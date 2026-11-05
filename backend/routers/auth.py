"""Регистрация, вход и профиль пользователя.

Пароли хранятся в виде bcrypt-хешей, сессия — JWT в localStorage на фронтенде.
Выбор в пользу собственной JWT-авторизации (вместо Supabase Auth): не нужно
подтверждение email и настройка редиректов, MVP работает сразу из коробки.
"""
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import database
from deps import get_current_user, new_id, row_to_user, utcnow
from security import create_token, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class RegisterIn(BaseModel):
    email: str = Field(min_length=5, max_length=200)
    password: str = Field(min_length=8, max_length=64)  # максимум 64 — ограничение bcrypt


class LoginIn(BaseModel):
    email: str
    password: str


# Аватар хранится прямо в БД как data URL (PNG/JPEG/WebP, ~до 350 КБ бинарно)
AVATAR_RE = re.compile(r"^data:image/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$")
AVATAR_MAX_CHARS = 500_000


class ProfileIn(BaseModel):
    # None — поле не менять, "" — очистить
    name: Optional[str] = Field(default=None, max_length=60)
    avatar: Optional[str] = None


@router.post("/register")
def register(body: RegisterIn):
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=422, detail="Введите корректный email.")
    if len(body.password) < 8:
        raise HTTPException(status_code=422, detail="Пароль должен содержать минимум 8 символов.")
    if database.fetchone("SELECT id FROM users WHERE email = %s", (email,)):
        raise HTTPException(status_code=409, detail="Пользователь с таким email уже зарегистрирован.")

    uid = new_id()
    database.execute(
        "INSERT INTO users (id, email, password_hash, plan, created_at) VALUES (%s, %s, %s, 'free', %s)",
        (uid, email, hash_password(body.password), utcnow()),
    )
    return {
        "token": create_token(uid),
        "email": email,
        "plan": "free",
        "message": "Аккаунт создан. Доступно 5 бесплатных генераций в день.",
    }


@router.post("/login")
def login(body: LoginIn):
    email = body.email.strip().lower()
    row = database.fetchone(
        "SELECT id, email, password_hash, plan, plan_expires_at, created_at FROM users WHERE email = %s",
        (email,),
    )
    if not row or not verify_password(body.password, row[2]):
        raise HTTPException(status_code=401, detail="Неверный email или пароль.")
    user = row_to_user(row)
    return {"token": create_token(user["id"]), "email": user["email"], "plan": user["plan"]}


@router.get("/me")
def me(user: dict = Depends(get_current_user)):
    return {
        "id": user["id"],
        "email": user["email"],
        "plan": user["plan"],
        "plan_expires_at": user["plan_expires_at"].isoformat() if user["plan_expires_at"] else None,
    }


@router.get("/profile")
def get_profile(user: dict = Depends(get_current_user)):
    row = database.fetchone("SELECT name, avatar FROM users WHERE id = %s", (user["id"],))
    name, avatar = (row[0], row[1]) if row else (None, None)
    return {"email": user["email"], "name": name, "avatar": avatar}


@router.patch("/profile")
def update_profile(body: ProfileIn, user: dict = Depends(get_current_user)):
    row = database.fetchone("SELECT name, avatar FROM users WHERE id = %s", (user["id"],))
    name, avatar = (row[0], row[1]) if row else (None, None)

    if body.name is not None:
        name = body.name.strip() or None
    if body.avatar is not None:
        avatar = body.avatar or None
        if avatar:
            if len(avatar) > AVATAR_MAX_CHARS:
                raise HTTPException(
                    status_code=422,
                    detail="Файл аватара слишком большой. Выберите изображение поменьше.",
                )
            if not AVATAR_RE.match(avatar):
                raise HTTPException(
                    status_code=422,
                    detail="Аватар должен быть изображением PNG, JPEG или WebP.",
                )

    database.execute(
        "UPDATE users SET name = %s, avatar = %s WHERE id = %s",
        (name, avatar, user["id"]),
    )
    return {"email": user["email"], "name": name, "avatar": avatar, "message": "Профиль сохранён."}
