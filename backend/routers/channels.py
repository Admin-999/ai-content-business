"""Автопостинг в Telegram-каналы и Instagram-аккаунты.

Telegram: клиент описывает канал и добавляет бота сервиса администратором —
токены не нужны, публикация идёт от единственного бота (TELEGRAM_BOT_TOKEN).

Instagram (путь «Instagram API with Instagram Login»): клиент один раз
получает в кабинете Meta короткоживущий токен + App Secret и вставляет их
в форму (пошаговая инструкция — frontend/instagram-setup.html). Backend
обменивает токен на долгосрочный (~60 дней), продлевает его автоматически
и публикует посты картинкой-карточкой с текстом в подписи.

Cron-задача /api/cron/autopost (см. .github/workflows/autopost.yml) сама
пишет посты через ИИ с учётом интервала канала и дневного лимита.
"""
import datetime
import logging
import os
import re

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import database
import igapi
import igcards
import tgapi
from ai import AIError, generate_content
from config import BACKEND_URL, CRON_SECRET, IG_CARDS_DIR, TELEGRAM_BOT_TOKEN
from deps import daily_limit, get_current_user, new_id, used_today, utcnow

logger = logging.getLogger("app.channels")

router = APIRouter(prefix="/api", tags=["channels"])

_CHANNEL_COLS = (
    "id, title, description, channel_username, tone, interval_hours, active, last_post_at, created_at, "
    "platform, ig_username, token_expires_at"
)


class ChannelIn(BaseModel):
    title: str = Field(min_length=2, max_length=100)
    description: str = Field(min_length=10, max_length=2000)
    channel_username: str = Field(min_length=2, max_length=100)
    tone: str = Field(default="дружелюбный", max_length=50)
    interval_hours: int = 12


class InstagramChannelIn(BaseModel):
    """Подключение Instagram: короткоживущий токен из кабинета Meta + App Secret."""

    title: str = Field(min_length=2, max_length=100)
    description: str = Field(min_length=10, max_length=2000)
    tone: str = Field(default="дружелюбный", max_length=50)
    interval_hours: int = 12
    access_token: str = Field(min_length=20, max_length=600)
    app_secret: str = Field(min_length=16, max_length=128)


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
        "platform": row[9] or "telegram",
        "ig_username": row[10],
        "token_expires_at": database.as_dt(row[11]),
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


@router.post("/channels/instagram")
def create_instagram_channel(body: InstagramChannelIn, user: dict = Depends(get_current_user)):
    """Подключение Instagram-аккаунта: обмен короткого токена на долгосрочный."""
    if body.interval_hours not in (6, 12, 24):
        raise HTTPException(status_code=422, detail="Интервал постинга: 6, 12 или 24 часа.")
    try:
        token, expires_in = igapi.exchange_token(body.access_token.strip(), body.app_secret.strip())
    except igapi.InstagramError as e:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Не удалось активировать токен: {e} "
                "Проверьте, что токен скопирован целиком и свежий (живёт ~1 час после генерации), "
                "а App Secret взят из настроек того же приложения Meta."
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
    cid = new_id()
    database.execute(
        "INSERT INTO channels (id, user_id, title, description, bot_token, channel_username, "
        "tone, interval_hours, active, last_post_at, created_at, platform, access_token, "
        "ig_user_id, ig_username, token_expires_at) "
        "VALUES (%s, %s, %s, %s, '', %s, %s, %s, 1, NULL, %s, 'instagram', %s, %s, %s, %s)",
        (
            cid,
            user["id"],
            body.title.strip(),
            body.description.strip(),
            username,
            body.tone,
            body.interval_hours,
            utcnow(),
            token,
            ig_user_id,
            username,
            expires_at,
        ),
    )
    return {
        "id": cid,
        "status": "created",
        "ig_username": username,
        "token_expires_at": expires_at.isoformat(),
    }


@router.get("/ig/cards/{filename}")
def ig_card_file(filename: str):
    """Публичная раздача PNG-карточек — по этому адресу картинку скачивает сам Instagram."""
    if not re.fullmatch(r"[A-Za-z0-9]+\.png", filename):
        raise HTTPException(status_code=404, detail="Карточка не найдена.")
    path = os.path.join(IG_CARDS_DIR, filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Карточка не найдена.")
    return FileResponse(path, media_type="image/png")


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
        member = tgapi.get_chat_member(TELEGRAM_BOT_TOKEN, f"@{username}", me.get("id"))
        status = member.get("status")
    except tgapi.TelegramError as e:
        status = None
        logger.info("getChatMember @%s: %s", username, e)
    if status not in ("administrator", "creator"):
        raise HTTPException(
            status_code=422,
            detail=(
                f"Бот сервиса ещё не администратор канала @{username}. "
                f"Откройте канал → Администраторы → добавьте @{bot_username} администратором "
                "с правом публикации сообщений — и нажмите кнопку ещё раз."
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


def _fresh_ig_token(channel_id, token, expires_at, now):
    """Продлевает долгосрочный токен Instagram (обновляем заранее, за неделю до истечения)."""
    exp = database.as_dt(expires_at)
    if token and exp and (exp - now).total_seconds() > 7 * 86400:
        return token
    if not token:
        return None
    try:
        new_token, expires_in = igapi.refresh_token(token)
    except igapi.InstagramError as e:
        logger.info("refresh_token канала %s: %s", channel_id, e)
        # попробуем опубликовать со старым токеном; если он уже невалиден,
        # ошибка зафиксируется в посте с подсказкой о переподключении
        return token
    if not new_token:
        return token
    new_exp = now + datetime.timedelta(seconds=expires_in or 60 * 86400)
    database.execute(
        "UPDATE channels SET access_token = %s, token_expires_at = %s WHERE id = %s",
        (new_token, new_exp, channel_id),
    )
    return new_token


@router.post("/cron/autopost")
def autopost(x_cron_secret: str = Header(default="")):
    """Запускается GitHub Actions каждые 2 часа. Пишет посты в активные Telegram-каналы и Instagram-аккаунты."""
    if not CRON_SECRET or x_cron_secret != CRON_SECRET:
        raise HTTPException(status_code=403, detail="Недействительный секрет cron-задачи.")

    now = utcnow()
    rows = database.fetchall(
        "SELECT c.id, c.user_id, c.title, c.description, c.tone, c.interval_hours, "
        "c.channel_username, c.last_post_at, u.plan, c.platform, c.access_token, "
        "c.ig_user_id, c.token_expires_at "
        "FROM channels c JOIN users u ON u.id = c.user_id WHERE c.active = 1"
    )
    sent = failed = skipped = 0
    for (cid, uid, title, description, tone, interval_hours, username, last_post_at, plan,
         platform, access_token, ig_user_id, token_expires_at) in rows:
        last = database.as_dt(last_post_at)
        if last and (now - last).total_seconds() < interval_hours * 3600 - 600:
            skipped += 1
            continue
        if used_today(uid) >= daily_limit(plan):
            skipped += 1
            continue
        platform = platform or "telegram"
        if platform == "telegram" and not TELEGRAM_BOT_TOKEN:
            skipped += 1
            continue
        if platform == "instagram" and not (access_token and ig_user_id):
            _log_post(cid, uid, "", "failed", "Аккаунт Instagram подключён не полностью — удалите канал и подключите заново.")
            failed += 1
            continue

        if platform == "instagram":
            subject = (
                f"Пост для Instagram-аккаунта «{title}» (публикуется как картинка с подписью). "
                f"О чём аккаунт: {description}"
            )
        else:
            subject = f"Пост для Telegram-канала «{title}». О чём канал: {description}"
        try:
            text, model = generate_content(subject, "post", tone, "ru")
        except AIError as e:
            _log_post(cid, uid, "", "failed", str(e))
            failed += 1
            continue

        if platform == "instagram":
            token = _fresh_ig_token(cid, access_token, token_expires_at, now)
            if not token:
                _log_post(
                    cid, uid, text, "failed",
                    "Токен Instagram истёк — сгенерируйте новый в кабинете Meta и подключите аккаунт заново.",
                )
                failed += 1
                continue
            try:
                filename = igcards.make_card(title, text)
                image_url = f"{BACKEND_URL}/api/ig/cards/{filename}"
                igapi.publish_image(token, ig_user_id, image_url, text)
                status, error = "sent", None
                database.execute("UPDATE channels SET last_post_at = %s WHERE id = %s", (now, cid))
                sent += 1
            except igapi.InstagramError as e:
                status, error = "failed", str(e)
                failed += 1
        else:
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
