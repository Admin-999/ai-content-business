"""Общие зависимости FastAPI: авторизация, тарифы, счётчики."""
import datetime
import uuid
from typing import Optional

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

import database
from config import FREE_DAILY_LIMIT, PRO_DAILY_LIMIT
from security import decode_token

_bearer = HTTPBearer(auto_error=False)


def new_id() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def row_to_user(row) -> dict:
    return {
        "id": row[0],
        "email": row[1],
        "password_hash": row[2],
        "plan": row[3],
        "plan_expires_at": database.as_dt(row[4]),
        "created_at": database.as_dt(row[5]),
    }


def ensure_active_plan(user: dict) -> dict:
    """Ленивое понижение тарифа: если подписка PRO истекла — возвращаем Free не дожидаясь cron."""
    if user["plan"] == "pro" and user["plan_expires_at"] and user["plan_expires_at"] < utcnow():
        database.execute(
            "UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = %s",
            (user["id"],),
        )
        user["plan"] = "free"
        user["plan_expires_at"] = None
    return user


def get_current_user(creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)) -> dict:
    """Проверяет заголовок Authorization: Bearer <JWT> и возвращает пользователя."""
    if creds is None or not creds.credentials:
        raise HTTPException(status_code=401, detail="Требуется авторизация. Войдите в аккаунт.")
    try:
        user_id = decode_token(creds.credentials)
    except Exception:
        raise HTTPException(status_code=401, detail="Сессия истекла. Войдите заново.")
    row = database.fetchone(
        "SELECT id, email, password_hash, plan, plan_expires_at, created_at FROM users WHERE id = %s",
        (user_id,),
    )
    if not row:
        raise HTTPException(status_code=401, detail="Пользователь не найден.")
    return ensure_active_plan(row_to_user(row))


def daily_limit(plan: str) -> int:
    return PRO_DAILY_LIMIT if plan == "pro" else FREE_DAILY_LIMIT


def used_today(user_id: str) -> int:
    """Генерации с начала текущих суток по UTC (лимит обнуляется в 00:00 UTC)."""
    day_start = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    row = database.fetchone(
        "SELECT COUNT(*) FROM generations WHERE user_id = %s AND created_at >= %s",
        (user_id, day_start),
    )
    return int(row[0]) if row else 0
