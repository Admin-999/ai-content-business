"""Конструктор ИИ-ботов для Telegram.

Клиент описывает роль бота, тон и знания о бизнесе, даёт токен бота из
@BotFather. При активации мы регистрируем webhook: Telegram присылает
сообщения на /api/bot-webhook/{id}, бот отвечает через ИИ.
"""
import logging

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

import database
import tgapi
from ai import AIError, chat_text
from config import BACKEND_URL, BOT_DAILY_REPLY_LIMIT
from deps import get_current_user, new_id, utcnow

logger = logging.getLogger("app.bots")

router = APIRouter(prefix="/api", tags=["bots"])

_BOT_COLS = "id, name, role, tone, knowledge, webhook_secret, active, replies_today, stat_date, created_at"


class BotIn(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    role: str = Field(min_length=2, max_length=200)
    tone: str = Field(default="дружелюбный", max_length=50)
    knowledge: str = Field(min_length=10, max_length=4000)
    bot_token: str = Field(min_length=20, max_length=100)


def _row_to_bot(row) -> dict:
    return {
        "id": row[0],
        "name": row[1],
        "role": row[2],
        "tone": row[3],
        "knowledge": row[4],
        "active": bool(row[6]),
        "replies_today": row[7],
        "stat_date": row[8],
        "created_at": database.as_dt(row[9]),
    }


def _system_prompt(name: str, role: str, tone: str, knowledge: str) -> str:
    return (
        f"Ты — Telegram-бот «{name}» малого бизнеса. Твоя роль: {role}.\n"
        f"Тон общения: {tone}.\n"
        f"Знания о бизнесе, товарах и ценах: {knowledge}\n"
        "Правила ответов:\n"
        "- Отвечай кратко (до 600 символов), простым языком, по-русски.\n"
        "- Не выдумывай факты, которых нет в знаниях.\n"
        "- Если не знаешь ответа — честно скажи и предложи связаться с менеджером.\n"
        "- Если клиент заинтересовался — мягко позови к покупке или попроси контакт."
    )


@router.post("/bots")
def create_bot(body: BotIn, user: dict = Depends(get_current_user)):
    try:
        me = tgapi.get_me(body.bot_token.strip())
    except tgapi.TelegramError as e:
        raise HTTPException(
            status_code=422,
            detail=f"Токен бота не подошёл: {e}. Создайте бота у @BotFather и скопируйте токен.",
        )
    bid = new_id()
    database.execute(
        "INSERT INTO bots (id, user_id, name, role, tone, knowledge, bot_token, webhook_secret, "
        "active, replies_today, stat_date, created_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0, 0, NULL, %s)",
        (
            bid,
            user["id"],
            body.name.strip(),
            body.role.strip(),
            body.tone,
            body.knowledge.strip(),
            body.bot_token.strip(),
            new_id().replace("-", ""),
            utcnow(),
        ),
    )
    return {
        "id": bid,
        "bot_username": me.get("username"),
        "active": False,
        "status": "created",
    }


@router.get("/bots")
def list_bots(user: dict = Depends(get_current_user)):
    rows = database.fetchall(
        f"SELECT {_BOT_COLS} FROM bots WHERE user_id = %s ORDER BY created_at DESC",
        (user["id"],),
    )
    return {"bots": [_row_to_bot(r) for r in rows]}


@router.post("/bots/{bid}/activate")
def activate_bot(bid: str, user: dict = Depends(get_current_user)):
    row = database.fetchone(
        "SELECT bot_token, active FROM bots WHERE id = %s AND user_id = %s", (bid, user["id"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Бот не найден.")
    token, active = row
    if active:
        return {"id": bid, "active": True, "status": "already_active"}
    secret_row = database.fetchone("SELECT webhook_secret FROM bots WHERE id = %s", (bid,))
    try:
        tgapi.set_webhook(token, f"{BACKEND_URL}/api/bot-webhook/{bid}", secret_row[0])
    except tgapi.TelegramError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Telegram не принял webhook: {e}. Попробуйте ещё раз через минуту.",
        )
    database.execute("UPDATE bots SET active = 1 WHERE id = %s", (bid,))
    return {"id": bid, "active": True, "status": "activated"}


@router.post("/bots/{bid}/pause")
def pause_bot(bid: str, user: dict = Depends(get_current_user)):
    row = database.fetchone(
        "SELECT bot_token FROM bots WHERE id = %s AND user_id = %s", (bid, user["id"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Бот не найден.")
    try:
        tgapi.delete_webhook(row[0])
    except tgapi.TelegramError as e:
        logger.warning("Не удалось снять webhook бота %s: %s", bid, e)
    database.execute("UPDATE bots SET active = 0 WHERE id = %s", (bid,))
    return {"id": bid, "active": False, "status": "paused"}


@router.delete("/bots/{bid}")
def delete_bot(bid: str, user: dict = Depends(get_current_user)):
    row = database.fetchone(
        "SELECT bot_token, active FROM bots WHERE id = %s AND user_id = %s", (bid, user["id"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Бот не найден.")
    token, active = row
    if active:
        try:
            tgapi.delete_webhook(token)
        except tgapi.TelegramError as e:
            logger.warning("Не удалось снять webhook бота %s: %s", bid, e)
    database.execute("DELETE FROM bots WHERE id = %s", (bid,))
    return {"status": "deleted"}


@router.post("/bot-webhook/{bid}")
def bot_webhook(bid: str, update: dict, x_telegram_bot_api_secret_token: str = Header(default="")):
    """Telegram присылает сюда сообщения клиентов. Секрет проверяется на каждый запрос."""
    row = database.fetchone(
        f"SELECT {_BOT_COLS}, bot_token FROM bots WHERE id = %s", (bid,)
    )
    if not row or x_telegram_bot_api_secret_token != row[5]:
        raise HTTPException(status_code=403, detail="Недействительный webhook.")
    token = row[10]
    if not row[6]:
        return {"ok": True}

    message = update.get("message") or update.get("edited_message") or {}
    chat_id = (message.get("chat") or {}).get("id")
    if not chat_id:
        return {"ok": True}
    text = (message.get("text") or "").strip()
    if text.startswith("/start"):
        text = "здравствуйте, расскажите о себе"
    if not text:
        text = "здравствуйте, расскажите о себе"

    today = utcnow().strftime("%Y-%m-%d")
    replies_today, stat_date = row[7], row[8]
    if stat_date != today:
        replies_today, stat_date = 0, today
        database.execute(
            "UPDATE bots SET replies_today = 0, stat_date = %s WHERE id = %s", (today, bid)
        )
    if replies_today >= BOT_DAILY_REPLY_LIMIT:
        try:
            tgapi.send_message(
                token,
                chat_id,
                "Сегодня я уже ответил на много вопросов и отдыхаю. Пожалуйста, напишите завтра.",
            )
        except tgapi.TelegramError:
            pass
        return {"ok": True}

    try:
        answer, _ = chat_text(_system_prompt(row[1], row[2], row[3], row[4]), text)
    except AIError:
        answer = "Извините, я временно перегружен. Напишите, пожалуйста, через пару минут."
    try:
        tgapi.send_message(token, chat_id, answer)
    except tgapi.TelegramError as e:
        logger.warning("Не удалось ответить в чат %s бота %s: %s", chat_id, bid, e)
        return {"ok": True}
    database.execute(
        "UPDATE bots SET replies_today = replies_today + 1 WHERE id = %s", (bid,)
    )
    return {"ok": True}
