"""Карточки товаров Wildberries из фото.

Клиент загружает фото, название и цену. ИИ рассматривает фото (vision-модель),
составляет описание, характеристики и ключевые слова. Если подключён API-токен
кабинета продавца — пытается опубликовать карточку, иначе отдаёт готовый
контент для ручной публикации.
"""
import json
import re

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

import database
from ai import AIError, describe_image, run_prompt
from config import WB_CONTENT_API
from deps import daily_limit, get_current_user, new_id, used_today, utcnow

router = APIRouter(prefix="/api/wb", tags=["wildberries"])

WB_TIMEOUT = httpx.Timeout(30.0)
PHOTO_MAX = 8 * 1024 * 1024
ALLOWED_MIME = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
CMP_UPLOAD_URL = "https://cmp.wildberries.ru/cmp/uploadApiPhoto"


class WBConnectIn(BaseModel):
    api_token: str = Field(min_length=10, max_length=300)


class WBError(Exception):
    """Сбой обращения к API Wildberries."""


def _vision_prompt() -> str:
    return (
        "Рассмотри фото товара для карточки маркетплейса. Опиши только то, что видно: "
        "тип товара, материал, цвет, конструкцию, детали и комплектацию. "
        "Пиши связным текстом, 3–5 предложений, без советов и оценки качества."
    )


def _card_prompt(name: str, price: int, vision_text: str) -> str:
    return (
        "Ты — специалист по карточкам товаров Wildberries с опытом 10 лет.\n"
        f"Данные товара:\n- Название: {name}\n- Цена: {price} руб.\n"
        f"- Что видно на фото: {vision_text}\n"
        "Составь карточку товара. Верни СТРОГО один JSON-объект без markdown и пояснений:\n"
        '{"description": "продающее описание 500–800 символов, без указания цены", '
        '"characteristics": [{"name": "название характеристики", "value": "значение"}] — 6–10 шт., '
        '"keywords": "10–15 поисковых слов через запятую"}'
    )


def _extract_json(text: str) -> dict:
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise AIError("Модель вернула ответ не в формате JSON")
    try:
        return json.loads(text[start:end + 1])
    except ValueError:
        raise AIError("Не удалось разобрать карточку из ответа модели")


def _wb_get_subjects(token: str):
    try:
        with httpx.Client(timeout=WB_TIMEOUT) as client:
            resp = client.get(
                f"{WB_CONTENT_API}/content/v2/object/all",
                headers={"Authorization": token},
                params={"lang": "ru", "limit": 1000},
            )
    except httpx.HTTPError as e:
        raise WBError(f"Wildberries недоступен: {e}")
    if resp.status_code in (401, 403):
        raise WBError("Токен Wildberries отклонён (проверьте кабинет продавца).")
    if resp.status_code != 200:
        raise WBError(f"Wildberries HTTP {resp.status_code}: {resp.text[:200]}")
    data = resp.json().get("data") or []
    return [d.get("subjectName") or "" for d in data if d.get("subjectName")]


def _pick_subject(subjects, name: str, keywords: str):
    words = set(re.split(r"[^0-9a-zа-яё]+", f"{name} {keywords}".lower()))
    words -= {"и", "в", "для", "на", "с", "из", "по"}
    best, best_score = None, 0
    for subject in subjects:
        score = len(words & set(re.split(r"[^0-9a-zа-яё]+", subject.lower())))
        if score > best_score:
            best, best_score = subject, score
    return best


def _wb_publish(token: str, photo_bytes: bytes, mime: str, name: str, card: dict):
    """Пытается опубликовать карточку через WB Content API. Любой сбой -> WBError."""
    subjects = _wb_get_subjects(token)
    subject = _pick_subject(subjects, name, card.get("keywords") or "")
    if not subject:
        raise WBError("Не удалось подобрать категорию товара в Wildberries.")
    ext = ALLOWED_MIME.get(mime, "jpg")
    with httpx.Client(timeout=WB_TIMEOUT) as client:
        try:
            resp = client.post(
                CMP_UPLOAD_URL,
                headers={"Authorization": token},
                files={"photo": (f"item.{ext}", photo_bytes, mime)},
            )
        except httpx.HTTPError as e:
            raise WBError(f"Не удалось загрузить фото в Wildberries: {e}")
        if resp.status_code != 200:
            raise WBError(f"Загрузка фото: WB HTTP {resp.status_code}: {resp.text[:200]}")
        try:
            filename = (resp.json().get("result") or {}).get("filename")
        except ValueError:
            filename = None
        if not filename:
            raise WBError("Wildberries не вернул имя загруженного фото.")

        props = [{"title": "Наименование", "value": name}]
        for char in card.get("characteristics") or []:
            if char.get("name") and char.get("value"):
                props.append({"title": str(char["name"])[:100], "value": str(char["value"])[:800]})
        props.append({"title": "Описание", "value": card.get("description", "")[:2000]})
        try:
            resp = client.post(
                f"{WB_CONTENT_API}/content/v2/cards/multifactor",
                headers={"Authorization": token},
                json={
                    "cards": [
                        {
                            "subject": {"name": subject, "props": props},
                            "variants": [{"title": name}],
                            "photos": [{"filename": filename}],
                        }
                    ]
                },
            )
        except httpx.HTTPError as e:
            raise WBError(f"Не удалось создать карточку: {e}")
        if resp.status_code not in (200, 201):
            raise WBError(f"Создание карточки: WB HTTP {resp.status_code}: {resp.text[:200]}")
    return subject


@router.post("/connect")
def wb_connect(body: WBConnectIn, user: dict = Depends(get_current_user)):
    """Проверяет и запоминает API-токен кабинета продавца Wildberries."""
    token = body.api_token.strip()
    try:
        subjects = _wb_get_subjects(token)
    except WBError as e:
        raise HTTPException(
            status_code=422,
            detail=f"{e} Токен берётся в кабинете WB: Настройки -> Доступ к API.",
        )
    database.execute("DELETE FROM wb_accounts WHERE user_id = %s", (user["id"],))
    database.execute(
        "INSERT INTO wb_accounts (id, user_id, api_token, added_at) VALUES (%s, %s, %s, %s)",
        (new_id(), user["id"], token, utcnow()),
    )
    return {"connected": True, "categories_available": len(subjects)}


@router.get("/account")
def wb_account(user: dict = Depends(get_current_user)):
    row = database.fetchone(
        "SELECT id, added_at FROM wb_accounts WHERE user_id = %s", (user["id"],)
    )
    return {
        "connected": bool(row),
        "added_at": database.as_dt(row[1]) if row else None,
    }


@router.delete("/account")
def wb_disconnect(user: dict = Depends(get_current_user)):
    database.execute("DELETE FROM wb_accounts WHERE user_id = %s", (user["id"],))
    return {"connected": False}


@router.post("/cards")
def create_card(
    photo: UploadFile = File(...),
    name: str = Form(...),
    price_rub: int = Form(...),
    user: dict = Depends(get_current_user),
):
    name = name.strip()
    if len(name) < 3:
        raise HTTPException(status_code=422, detail="Укажите название товара (минимум 3 символа).")
    if not (1 <= price_rub <= 10_000_000):
        raise HTTPException(status_code=422, detail="Укажите цену в рублях от 1 до 10 000 000.")

    limit = daily_limit(user["plan"])
    used = used_today(user["id"])
    if used >= limit:
        raise HTTPException(
            status_code=429,
            detail=f"Достигнут дневной лимит: {used} из {limit} генераций. Лимит обновится в 00:00 UTC.",
        )

    photo_bytes = photo.file.read(PHOTO_MAX + 1)
    if len(photo_bytes) > PHOTO_MAX:
        raise HTTPException(status_code=422, detail="Фото слишком большое: максимум 8 МБ.")
    if not photo_bytes:
        raise HTTPException(status_code=422, detail="Загрузите фото товара.")
    mime = (photo.content_type or "").split(";")[0].strip().lower()
    if mime not in ALLOWED_MIME:
        raise HTTPException(status_code=422, detail="Поддерживаются фото: JPEG, PNG, WebP.")

    try:
        vision_text, vision_model = describe_image(photo_bytes, mime, _vision_prompt())
        card, model = run_prompt(_card_prompt(name, price_rub, vision_text))
        card = _extract_json(card)
    except AIError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Сервис генерации временно недоступен, попробуйте ещё раз через минуту. ({e})",
        )
    description = str(card.get("description") or "").strip()
    characteristics = card.get("characteristics") or []
    keywords = str(card.get("keywords") or "").strip()
    if not description:
        raise HTTPException(status_code=502, detail="Модель вернула пустое описание, попробуйте ещё раз.")

    account = database.fetchone(
        "SELECT api_token FROM wb_accounts WHERE user_id = %s", (user["id"],)
    )
    status, error = "ready", None
    subject = None
    if account:
        try:
            subject = _wb_publish(account[0], photo_bytes, mime, name, card)
            status = "published"
        except WBError as e:
            status = "error"
            error = str(e)[:300]

    database.execute(
        "INSERT INTO generations (id, user_id, topic, content_type, tone, language, result, model, created_at) "
        "VALUES (%s, %s, %s, 'product', 'продающий', 'ru', %s, %s, %s)",
        (new_id(), user["id"], f"Карточка WB: {name}", description, model, utcnow()),
    )
    wid = new_id()
    database.execute(
        "INSERT INTO wb_cards (id, user_id, name, price_rub, description, characteristics, keywords, status, error, created_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (
            wid,
            user["id"],
            name,
            price_rub,
            description,
            json.dumps(characteristics, ensure_ascii=False),
            keywords,
            status,
            error,
            utcnow(),
        ),
    )
    used += 1
    return {
        "id": wid,
        "name": name,
        "price_rub": price_rub,
        "description": description,
        "characteristics": characteristics,
        "keywords": keywords,
        "publish_status": status,
        "publish_subject": subject,
        "publish_error": error,
        "vision_model": vision_model,
        "model": model,
        "used_today": used,
        "limit": limit,
        "remaining": max(limit - used, 0),
    }


@router.get("/cards")
def list_cards(user: dict = Depends(get_current_user)):
    rows = database.fetchall(
        "SELECT id, name, price_rub, description, characteristics, keywords, status, error, created_at "
        "FROM wb_cards WHERE user_id = %s ORDER BY created_at DESC LIMIT 20",
        (user["id"],),
    )
    cards = []
    for r in rows:
        try:
            chars = json.loads(r[4]) if r[4] else []
        except ValueError:
            chars = []
        cards.append(
            {
                "id": r[0],
                "name": r[1],
                "price_rub": r[2],
                "description": r[3],
                "characteristics": chars,
                "keywords": r[5],
                "status": r[6],
                "error": r[7],
                "created_at": database.as_dt(r[8]),
            }
        )
    return {"cards": cards}
