"""Главный эндпоинт: генерация контента с проверкой дневного лимита."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import database
from ai import AIError, CONTENT_TYPES, generate_content
from deps import daily_limit, get_current_user, new_id, used_today, utcnow

router = APIRouter(prefix="/api", tags=["generate"])


class GenerateIn(BaseModel):
    topic: str = Field(default="", max_length=500)
    content_type: str = "post"
    tone: str = Field(default="дружелюбный", max_length=50)
    language: str = Field(default="ru", max_length=20)


@router.post("/generate")
def generate(body: GenerateIn, user: dict = Depends(get_current_user)):
    # --- Валидация входа (edge-кейсы: пустая/короткая тема, неизвестный тип) ---
    topic = body.topic.strip()
    if len(topic) < 3:
        raise HTTPException(status_code=422, detail="Опишите тему подробнее: минимум 3 символа.")
    if body.content_type not in CONTENT_TYPES:
        raise HTTPException(status_code=422, detail="Неизвестный тип контента. Доступно: post, article, product.")

    # --- Проверка дневного лимита (списание автоматическое: считаем фактические генерации) ---
    limit = daily_limit(user["plan"])
    used = used_today(user["id"])
    if used >= limit:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Достигнут дневной лимит: {used} из {limit} генераций. "
                + ("Лимит обновится в 00:00 UTC — или оформите тариф PRO." if user["plan"] == "free" else "Лимит обновится в 00:00 UTC.")
            ),
        )

    # --- Обращение к бесплатному LLM API ---
    try:
        text, model = generate_content(topic, body.content_type, body.tone, body.language)
    except AIError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Сервис генерации временно недоступен, попробуйте ещё раз через минуту. ({e})",
        )

    # --- Логируем генерацию в БД (это же и есть «списание» лимита) ---
    gid = new_id()
    database.execute(
        "INSERT INTO generations (id, user_id, topic, content_type, tone, language, result, model, created_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (gid, user["id"], topic, body.content_type, body.tone, body.language, text, model, utcnow()),
    )
    used += 1
    return {
        "id": gid,
        "content": text,
        "model": model,
        "used_today": used,
        "limit": limit,
        "remaining": max(limit - used, 0),
    }
