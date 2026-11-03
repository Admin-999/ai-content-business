"""Автопостинг в Telegram-каналы.

Клиент описывает канал и добавляет бота сервиса администратором канала —
никаких токенов клиенту не нужно. Публикация идёт от единственного бота
сервиса (TELEGRAM_BOT_TOKEN в секретах). Cron-задача /api/cron/autopost
(см. .github/workflows/autopost.yml) сама пишет посты через ИИ
с учётом интервала канала и дневного лимита пользователя.
"""
import logging

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

import database
import tgapi
from ai import AIError, generate_content
from config import CRON_SECRET, TELEGRAM_BOT_TOKEN
from deps import daily_limit, get_current_user, new_id, used_today, utcnow

logger = logging.getLogger("app.channels")

router = APIRouter(prefix="/api", tags=["channels"])

_CHANNEL_COLS = (
    "id, title, description, channel_username, tone, interval_hours, active, last_post_at, created_at"
)


class ChannelIn(BaseModel):
    title: str = Field(min_length=2, max_length=100)
    description: str = Field(min_length=10, max_length=2000)
    channel_username: str = Field(min_length=2, max_length=100)
    tone: str = Field(default="дружелюбный", max_length=50)
    interval_hours: int = 12


def _norm_channel(name: str) -> str:
    """@name, https://t.me/name и просто name -> name."""
    name = name.strip()
    if name.startswith("https://t.me/"):
        name = name[len("https://t.me/"):]
    if name.startswith("@"):
        name = name[1:]
    return name.split("/")[0].strip()


def _row_to_channel(row) -> dict:
    return {
        "id": row[0],
        "title": row[1],
        "description": row[2],
        "channel_username": row[3],
        "tone": row[4],
        "interval_hours": row[5],
        "active": bool(row[6]),
        "last_post_at": database.as_dt(row[7]),
        "created_at": database.as_dt(row[8]),
    }


def _log_post(channel_id: str, user_id: str, text: str, status: str, error) -> None:
    database.execute(
        "INSERT INTO channel_posts (id, channel_id, user_id, text, status, error, created_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (new_id(), channel_id, user_id, text, status, error, utcnow()),
    )


@router.get("/channels/setup")
def channel_setup(user: dict = Depends(get_current_user)):
    """Имя бота сервиса для инструкции «добавьте администратором»."""
    if not TELEGRAM_BOT_TOKEN:
        return {"ready": False, "bot_username": None}
    try:
        me = tgapi.get_me(TELEGRAM_BOT_TOKEN)
        return {"ready": True, "bot_username": me.get("username")}
    except tgapi.TelegramError:
        return {"ready": False, "bot_username": None}


@router.post("/channels")
def create_channel(body: ChannelIn, user: dict = Depends(get_current_user)):
    username = _norm_channel(body.channel_username)
    if not username:
        raise HTTPException(
            status_code=422,
            detail="Укажите адрес канала: @my_channel или https://t.me/my_channel",
        )
    if body.interval_hours not in (6, 12, 24):
        raise HTTPException(status_code=422, detail="Интервал постинга: 6, 12 или 24 часа.")
    if not TELEGRAM_BOT_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="Автопостинг подключается: администратор сервиса регистрирует бота. Попробуйте чуть позже.",
        )

    try:
        me = tgapi.get_me(TELEGRAM_BOT_TOKEN)
    except tgapi.TelegramError as e:
        raise HTTPException(status_code=502, detail=f"Бот сервиса недоступен: {e}")
    bot_username = me.get("username") or "бота сервиса"
    try:
        tgapi.get_chat(TELEGRAM_BOT_TOKEN, f"@{username}")
    except tgapi.TelegramError as e:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Нет доступа к каналу @{username} ({e}). Откройте канал → Администраторы → "
                f"добавьте бота @{bot_username} администратором с правом публикации — и нажмите кнопку ещё раз."
            ),
        )

    cid = new_id()
    database.execute(
        "INSERT INTO channels (id, user_id, title, description, bot_token, channel_username, "
        "tone, interval_hours, active, last_post_at, created_at) "
        "VALUES (%s, %s, %s, %s, '', %s, %s, %s, 1, NULL, %s)",
        (
            cid,
            user["id"],
            body.title.strip(),
            body.description.strip(),
            username,
            body.tone,
            body.interval_hours,
            utcnow(),
        ),
    )
    return {"id": cid, "bot_username": bot_username, "status": "created"}


@router.get("/channels")
def list_channels(user: dict = Depends(get_current_user)):
    rows = database.fetchall(
        f"SELECT {_CHANNEL_COLS} FROM channels WHERE user_id = %s ORDER BY created_at DESC",
        (user["id"],),
    )
    channels = []
    for row in rows:
        channel = _row_to_channel(row)
        stat = database.fetchone(
            "SELECT COUNT(*), SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) "
            "FROM channel_posts WHERE channel_id = %s",
            (channel["id"],),
        )
        channel["posts_total"] = int(stat[0]) if stat else 0
        channel["posts_sent"] = int(stat[1] or 0) if stat else 0
        channels.append(channel)
    return {"channels": channels}


@router.get("/channels/{cid}/posts")
def channel_posts(cid: str, user: dict = Depends(get_current_user)):
    row = database.fetchone(
        "SELECT id FROM channels WHERE id = %s AND user_id = %s", (cid, user["id"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Канал не найден.")
    posts = database.fetchall(
        "SELECT id, text, status, error, created_at FROM channel_posts "
        "WHERE channel_id = %s ORDER BY created_at DESC LIMIT 10",
        (cid,),
    )
    return {
        "posts": [
            {
                "id": p[0],
                "text": p[1],
                "status": p[2],
                "error": p[3],
                "created_at": database.as_dt(p[4]),
            }
            for p in posts
        ]
    }


@router.post("/channels/{cid}/toggle")
def toggle_channel(cid: str, user: dict = Depends(get_current_user)):
    row = database.fetchone(
        "SELECT active FROM channels WHERE id = %s AND user_id = %s", (cid, user["id"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Канал не найден.")
    new_active = 0 if row[0] else 1
    database.execute("UPDATE channels SET active = %s WHERE id = %s", (new_active, cid))
    return {"id": cid, "active": bool(new_active)}


@router.delete("/channels/{cid}")
def delete_channel(cid: str, user: dict = Depends(get_current_user)):
    row = database.fetchone(
        "SELECT id FROM channels WHERE id = %s AND user_id = %s", (cid, user["id"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Канал не найден.")
    database.execute("DELETE FROM channel_posts WHERE channel_id = %s", (cid,))
    database.execute("DELETE FROM channels WHERE id = %s", (cid,))
    return {"status": "deleted"}


@router.post("/cron/autopost")
def autopost(x_cron_secret: str = Header(default="")):
    """Запускается GitHub Actions каждые 2 часа. Пишет посты в активные каналы."""
    if not CRON_SECRET or x_cron_secret != CRON_SECRET:
        raise HTTPException(status_code=403, detail="Недействительный секрет cron-задачи.")
    if not TELEGRAM_BOT_TOKEN:
        return {"status": "ok", "checked": 0, "sent": 0, "failed": 0, "skipped": 0}

    now = utcnow()
    rows = database.fetchall(
        "SELECT c.id, c.user_id, c.title, c.description, c.tone, c.interval_hours, "
        "c.channel_username, c.last_post_at, u.plan "
        "FROM channels c JOIN users u ON u.id = c.user_id WHERE c.active = 1"
    )
    sent = failed = skipped = 0
    for cid, uid, title, description, tone, interval_hours, username, last_post_at, plan in rows:
        last = database.as_dt(last_post_at)
        if last and (now - last).total_seconds() < interval_hours * 3600 - 600:
            skipped += 1
            continue
        if used_today(uid) >= daily_limit(plan):
            skipped += 1
            continue
        try:
            text, model = generate_content(
                f"Пост для Telegram-канала «{title}». О чём канал: {description}",
                "post",
                tone,
                "ru",
            )
        except AIError as e:
            _log_post(cid, uid, "", "failed", str(e))
            failed += 1
            continue
        try:
            tgapi.send_message(TELEGRAM_BOT_TOKEN, f"@{username}", text)
            status, error = "sent", None
            database.execute("UPDATE channels SET last_post_at = %s WHERE id = %s", (now, cid))
            sent += 1
        except tgapi.TelegramError as e:
            status, error = "failed", str(e)
            failed += 1
        database.execute(
            "INSERT INTO generations (id, user_id, topic, content_type, tone, language, result, model, created_at) "
            "VALUES (%s, %s, %s, 'post', %s, 'ru', %s, %s, %s)",
            (new_id(), uid, f"Автопостинг: {title}", tone, text, model, now),
        )
        _log_post(cid, uid, text, status, error)
    return {"status": "ok", "checked": len(rows), "sent": sent, "failed": failed, "skipped": skipped}
