"""Конструктор ИИ-ботов для Telegram и Instagram.

Telegram: клиент описывает роль бота, тон и знания о бизнесе, даёт токен
бота из @BotFather. При активации мы регистрируем webhook: Telegram присылает
сообщения на /api/bot-webhook/{id}, бот отвечает через ИИ.

Instagram: клиент подключает профессиональный аккаунт токеном из кабинета
Meta (нужен дополнительный скоуп instagram_business_manage_messages, см.
frontend/instagram-setup.html). Мы обмениваем токен на долгосрочный и при
запуске сами регистрируем webhook приложения Meta — сообщения из Direct
приходят на /api/bots/ig-webhook/{id}, бот отвечает через ИИ.
"""
import datetime
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

import database
import igapi
import tgapi
from ai import AIError, chat_text
from config import BACKEND_URL, BOT_DAILY_REPLY_LIMIT
from deps import get_current_user, new_id, utcnow

logger = logging.getLogger("app.bots")

router = APIRouter(prefix="/api", tags=["bots"])

_BOT_COLS = (
    "id, name, role, tone, knowledge, webhook_secret, active, replies_today, stat_date, created_at, "
    "platform, ig_user_id, token_expires_at"
)


class BotIn(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    role: str = Field(min_length=2, max_length=200)
    tone: str = Field(default="дружелюбный", max_length=50)
    knowledge: str = Field(min_length=10, max_length=4000)
    bot_token: str = Field(min_length=20, max_length=100)


class InstagramBotIn(BaseModel):
    """ИИ-бот для Direct Instagram: токен из кабинета Meta + данные приложения."""

    name: str = Field(min_length=2, max_length=60)
    role: str = Field(min_length=2, max_length=200)
    tone: str = Field(default="дружелюбный", max_length=50)
    knowledge: str = Field(min_length=10, max_length=4000)
    access_token: str = Field(min_length=20, max_length=600)
    app_id: str = Field(min_length=10, max_length=64)
    app_secret: str = Field(min_length=16, max_length=128)


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
        "platform": row[10] or "telegram",
        "token_expires_at": database.as_dt(row[12]),
    }


def _system_prompt(name: str, role: str, tone: str, knowledge: str, platform: str = "telegram") -> str:
    who = (
        f"ИИ-помощник в Direct Instagram «{name}» малого бизнеса"
        if platform == "instagram"
        else f"Telegram-бот «{name}» малого бизнеса"
    )
    return (
        f"Ты — {who}. Твоя роль: {role}.\n"
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


@router.post("/bots/instagram")
def create_instagram_bot(body: InstagramBotIn, user: dict = Depends(get_current_user)):
    """ИИ-бот для Direct Instagram: обмен токена и сохранение (запуск — отдельной кнопкой)."""
    try:
        token, expires_in = igapi.exchange_token(body.access_token.strip(), body.app_secret.strip())
    except igapi.InstagramError as e:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Не удалось активировать токен: {e} "
                "Проверьте, что токен свежий (живёт ~1 час), а App ID и App Secret взяты "
                "из того же приложения Meta. Для бота нужен скоуп instagram_business_manage_messages."
            ),
        )
    if not token or not expires_in:
        raise HTTPException(status_code=502, detail="Instagram вернул пустой ответ при обмене токена.")
    try:
        profile = igapi.get_profile(token)
    except igapi.InstagramError as e:
        raise HTTPException(status_code=422, detail=f"Токен отклонён Instagram: {e}")
    ig_user_id = str(profile.get("user_id") or "")
    username = (profile.get("username") or "").strip()
    if not ig_user_id:
        raise HTTPException(status_code=502, detail="Instagram не вернул id аккаунта — попробуйте ещё раз.")

    expires_at = utcnow() + datetime.timedelta(seconds=expires_in)
    bid = new_id()
    database.execute(
        "INSERT INTO bots (id, user_id, name, role, tone, knowledge, bot_token, webhook_secret, "
        "active, replies_today, stat_date, created_at, platform, app_id, app_secret, "
        "ig_user_id, token_expires_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0, 0, NULL, %s, 'instagram', %s, %s, %s, %s)",
        (
            bid,
            user["id"],
            body.name.strip(),
            body.role.strip(),
            body.tone,
            body.knowledge.strip(),
            token,
            new_id().replace("-", ""),
            utcnow(),
            body.app_id.strip(),
            body.app_secret.strip(),
            ig_user_id,
            expires_at,
        ),
    )
    return {
        "id": bid,
        "ig_username": username,
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
        "SELECT bot_token, active, platform, app_id, app_secret, webhook_secret FROM bots "
        "WHERE id = %s AND user_id = %s",
        (bid, user["id"]),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Бот не найден.")
    token, active, platform, app_id, app_secret, webhook_secret = row
    if active:
        return {"id": bid, "active": True, "status": "already_active"}
    if (platform or "telegram") == "instagram":
        callback = f"{BACKEND_URL}/api/bots/ig-webhook/{bid}"
        try:
            igapi.configure_app_webhook(app_id, app_secret, callback, webhook_secret)
        except igapi.InstagramError as e:
            raise HTTPException(
                status_code=502,
                detail=(
                    f"Не удалось автоматически настроить приём сообщений: {e} "
                    f"Настройте вручную в кабинете Meta: приложение → Webhooks → Instagram → "
                    f"поле «messages»; Callback URL: {callback}; Verify token: {webhook_secret}. "
                    "После сохранения нажмите «Запустить» ещё раз."
                ),
            )
        database.execute("UPDATE bots SET active = 1 WHERE id = %s", (bid,))
        return {"id": bid, "active": True, "status": "activated"}
    try:
        tgapi.set_webhook(token, f"{BACKEND_URL}/api/bot-webhook/{bid}", webhook_secret)
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
        "SELECT bot_token, platform, active FROM bots WHERE id = %s AND user_id = %s", (bid, user["id"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Бот не найден.")
    token, platform, active = row
    if (platform or "telegram") == "telegram" and active:
        try:
            tgapi.delete_webhook(token)
        except tgapi.TelegramError as e:
            logger.warning("Не удалось снять webhook бота %s: %s", bid, e)
    # Instagram: подписка приложения остаётся, но бот со status=0 игнорирует сообщения
    database.execute("UPDATE bots SET active = 0 WHERE id = %s", (bid,))
    return {"id": bid, "active": False, "status": "paused"}


@router.delete("/bots/{bid}")
def delete_bot(bid: str, user: dict = Depends(get_current_user)):
    row = database.fetchone(
        "SELECT bot_token, platform, active FROM bots WHERE id = %s AND user_id = %s", (bid, user["id"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Бот не найден.")
    token, platform, active = row
    if (platform or "telegram") == "telegram" and active:
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
    token = row[13]
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
        answer, _ = chat_text(_system_prompt(row[1], row[2], row[3], row[4], row[10]), text)
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


def _maybe_refresh_bot_token(bid: str, token: str, expires_at) -> str:
    """Продлевает долгосрочный токен бота, если до истечения меньше недели."""
    exp = database.as_dt(expires_at)
    if not token or not exp or (exp - utcnow()).total_seconds() > 7 * 86400:
        return token
    try:
        new_token, expires_in = igapi.refresh_token(token)
    except igapi.InstagramError as e:
        logger.info("refresh_token бота %s: %s", bid, e)
        return token
    if new_token:
        database.execute(
            "UPDATE bots SET bot_token = %s, token_expires_at = %s WHERE id = %s",
            (new_token, utcnow() + datetime.timedelta(seconds=expires_in or 60 * 86400), bid),
        )
    return new_token or token


@router.get("/bots/ig-webhook/{bid}")
def ig_bot_webhook_verify(bid: str, request: Request):
    """Meta проверяет адрес вебхука при подписке: echoing hub.challenge."""
    row = database.fetchone("SELECT webhook_secret FROM bots WHERE id = %s", (bid,))
    if not row or request.query_params.get("hub.verify_token") != row[0]:
        raise HTTPException(status_code=403, detail="Недействительный verify token.")
    return PlainTextResponse(request.query_params.get("hub.challenge", ""))


@router.post("/bots/ig-webhook/{bid}")
def ig_bot_webhook(bid: str, payload: dict):
    """Instagram присылает сюда сообщения из Direct; бот отвечает через ИИ."""
    row = database.fetchone(
        f"SELECT {_BOT_COLS}, bot_token FROM bots WHERE id = %s", (bid,)
    )
    if not row:
        raise HTTPException(status_code=403, detail="Недействительный webhook.")
    if row[10] != "instagram" or not row[6]:
        return {"ok": True}
    ig_user_id = row[11]
    token = _maybe_refresh_bot_token(bid, row[13], row[12])

    today = utcnow().strftime("%Y-%m-%d")
    replies_today, stat_date = row[7], row[8]
    if stat_date != today:
        replies_today, stat_date = 0, today
        database.execute(
            "UPDATE bots SET replies_today = 0, stat_date = %s WHERE id = %s", (today, bid)
        )

    events = []
    for entry in payload.get("entry") or []:
        events.extend(entry.get("messaging") or [])
    for event in events:
        message = event.get("message") or {}
        if message.get("is_echo") or message.get("is_deleted"):
            continue
        text = (message.get("text") or "").strip()
        sender_id = str((event.get("sender") or {}).get("id") or "")
        if not text or not sender_id or sender_id == ig_user_id:
            continue
        if replies_today >= BOT_DAILY_REPLY_LIMIT:
            try:
                igapi.send_message(
                    token, ig_user_id, sender_id,
                    "Сегодня я уже ответил на много вопросов и отдыхаю. Пожалуйста, напишите завтра.",
                )
            except igapi.InstagramError:
                pass
            break
        try:
            answer, _ = chat_text(_system_prompt(row[1], row[2], row[3], row[4], "instagram"), text)
        except AIError:
            answer = "Извините, я временно перегружен. Напишите, пожалуйста, через пару минут."
        try:
            igapi.send_message(token, ig_user_id, sender_id, answer)
        except igapi.InstagramError as e:
            logger.warning("Не удалось ответить в Direct %s бота %s: %s", sender_id, bid, e)
            continue
        database.execute(
            "UPDATE bots SET replies_today = replies_today + 1 WHERE id = %s", (bid,)
        )
        replies_today += 1
    return {"ok": True}
