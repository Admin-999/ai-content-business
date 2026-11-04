"""Карточки товаров для маркетплейсов из фото.

Клиент выбирает маркетплейс (Wildberries, Ozon, AliExpress, Яндекс Маркет),
загружает фото, название и цену. ИИ рассматривает фото (vision-модель) и
составляет описание, характеристики и ключевые слова под требования площадки.
При подключённом кабинете продавца карточка публикуется сама (Wildberries,
Ozon, Яндекс Маркет; публикацией в Ozon/Маркете занимается модуль mp.py),
иначе отдаётся готовый контент для ручной публикации.
"""
import json
import os
import re

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

import database
import mp
from ai import AIError, describe_image, run_prompt
from config import MP_PHOTOS_DIR, WB_CONTENT_API
from deps import daily_limit, get_current_user, new_id, used_today, utcnow

router = APIRouter(prefix="/api/wb", tags=["wildberries"])

WB_TIMEOUT = httpx.Timeout(30.0)
PHOTO_MAX = 8 * 1024 * 1024
ALLOWED_MIME = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
CMP_UPLOAD_URL = "https://cmp.wildberries.ru/cmp/uploadApiPhoto"

# Маркетплейсы: подсказки для ИИ под требования площадки; auto — доступна ли автопубликация
MARKETPLACES = {
    "wb": {
        "name": "Wildberries",
        "auto": True,
        "persona": "Ты — специалист по карточкам товаров Wildberries с опытом 10 лет.",
        "description": "продающее описание 500–800 символов, без указания цены",
        "characters": "6–10 шт.",
        "keywords": "10–15 поисковых слов через запятую",
    },
    "ozon": {
        "name": "Ozon",
        "auto": True,
        "persona": "Ты — специалист по карточкам товаров Ozon с опытом 10 лет.",
        "description": "продающее описание 500–1000 символов с выгодами для покупателя, без указания цены",
        "characters": "6–10 шт.",
        "keywords": "10–15 поисковых слов через запятую",
    },
    "aliexpress": {
        "name": "AliExpress",
        "auto": True,
        "persona": "Ты — специалист по карточкам товаров AliExpress с опытом 10 лет.",
        "description": "простое продающее описание 300–600 символов короткими фразами, без указания цены",
        "characters": "6–10 шт.",
        "keywords": "10–15 поисковых слов через запятую: русские и 3–5 английских",
    },
    "yamarket": {
        "name": "Яндекс Маркет",
        "auto": True,
        "persona": "Ты — специалист по карточкам товаров Яндекс Маркета с опытом 10 лет.",
        "description": "фактическое описание 500–800 символов: факты и преимущества без воды, без указания цены",
        "characters": "8–12 шт.",
        "keywords": "10–15 поисковых слов через запятую",
    },
}


class WBConnectIn(BaseModel):
    platform: str = "wb"
    api_token: str = ""
    client_id: str = ""
    api_key: str = ""
    app_key: str = ""
    app_secret: str = ""
    access_token: str = ""


class WBError(Exception):
    """Сбой обращения к API Wildberries."""


def _vision_prompt() -> str:
    return (
        "Рассмотри фото товара для карточки маркетплейса. Опиши только то, что видно: "
        "тип товара, материал, цвет, конструкцию, детали и комплектацию. "
        "Пиши связным текстом, 3–5 предложений, без советов и оценки качества."
    )


def _card_prompt(name: str, price: int, vision_text: str, platform: str) -> str:
    mp = MARKETPLACES.get(platform, MARKETPLACES["wb"])
    return (
        f"{mp['persona']}\n"
        f"Данные товара:\n- Название: {name}\n- Цена: {price} руб.\n"
        f"- Что видно на фото: {vision_text}\n"
        "Составь карточку товара. Верни СТРОГО один JSON-объект без markdown и пояснений:\n"
        '{"description": "' + mp["description"] + '", '
        '"characteristics": [{"name": "название характеристики", "value": "значение"}] — ' + mp["characters"] + ", "
        '"keywords": "' + mp["keywords"] + '"}'
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
    stems = mp._stems(mp._words(f"{name} {keywords or ''}"))
    best, best_score = None, 0
    for subject in subjects:
        score = len(stems & mp._stems(mp._words(subject)))
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
    """Проверяет и запоминает ключи кабинета продавца маркетплейса."""
    platform = (body.platform or "wb").strip().lower()
    if platform not in MARKETPLACES:
        raise HTTPException(status_code=422, detail="Неизвестный маркетплейс.")

    if platform == "wb":
        token = body.api_token.strip()
        if len(token) < 10:
            raise HTTPException(status_code=422, detail="Вставьте API-токен кабинета Wildberries.")
        try:
            subjects = _wb_get_subjects(token)
        except WBError as e:
            raise HTTPException(
                status_code=422,
                detail=f"{e} Токен берётся в кабинете WB: Настройки -> Доступ к API.",
            )
        creds, extra = token, None
    elif platform == "ozon":
        client_id = body.client_id.strip()
        api_key = body.api_key.strip()
        if len(client_id) < 4 or len(api_key) < 8:
            raise HTTPException(status_code=422, detail="Вставьте Client-Id и Api-Key из кабинета Ozon.")
        try:
            mp.ozon_validate(client_id, api_key)
        except mp.MarketplaceError as e:
            raise HTTPException(
                status_code=422,
                detail=f"{e} Ключи создаются в кабинете Ozon: Настройки -> API-ключи (доступ «Продукты»).",
            )
        creds, extra = json.dumps({"client_id": client_id, "api_key": api_key}), None
    elif platform == "yamarket":
        token = body.api_token.strip()
        if len(token) < 10:
            raise HTTPException(status_code=422, detail="Вставьте API-ключ кабинета Яндекс Маркета.")
        try:
            campaign_id = mp.yamarket_validate(token)
        except mp.MarketplaceError as e:
            raise HTTPException(
                status_code=422,
                detail=f"{e} Ключ создаётся в кабинете Маркета: Настройки -> API-ключи.",
            )
        creds, extra = token, json.dumps({"campaign_id": campaign_id})
    else:
        app_key = body.app_key.strip()
        app_secret = body.app_secret.strip()
        access_token = body.access_token.strip()
        if len(app_key) < 4 or len(app_secret) < 8 or len(access_token) < 10:
            raise HTTPException(
                status_code=422,
                detail="Вставьте app_key, app_secret и access_token приложения из AliExpress Open Platform.",
            )
        try:
            mp.aliexpress_validate(app_key, app_secret, access_token)
        except mp.MarketplaceError as e:
            raise HTTPException(
                status_code=422,
                detail=f"{e} Ключи берутся в кабинете разработчика AliExpress Open Platform (приложение с доступом к товарам).",
            )
        creds, extra = json.dumps(
            {"app_key": app_key, "app_secret": app_secret, "access_token": access_token}
        ), None
    database.execute(
        "DELETE FROM wb_accounts WHERE user_id = %s AND platform = %s",
        (user["id"], platform),
    )
    database.execute(
        "INSERT INTO wb_accounts (id, user_id, platform, api_token, extra, added_at) VALUES (%s, %s, %s, %s, %s, %s)",
        (new_id(), user["id"], platform, creds, extra, utcnow()),
    )
    result = {"connected": True, "platform": platform, "platform_name": MARKETPLACES[platform]["name"]}
    if platform == "wb":
        result["categories_available"] = len(subjects)
    return result


@router.get("/accounts")
def mp_accounts(user: dict = Depends(get_current_user)):
    """Статус подключения магазинов по всем маркетплейсам."""
    rows = database.fetchall(
        "SELECT platform, added_at FROM wb_accounts WHERE user_id = %s", (user["id"],)
    )
    connected = {r[0]: r[1] for r in rows}
    return {
        "accounts": [
            {
                "platform": key,
                "name": meta["name"],
                "auto": meta["auto"],
                "connected": key in connected,
                "added_at": database.as_dt(connected[key]) if key in connected else None,
            }
            for key, meta in MARKETPLACES.items()
        ]
    }


@router.delete("/account/{platform}")
def mp_disconnect(platform: str, user: dict = Depends(get_current_user)):
    if platform not in MARKETPLACES:
        raise HTTPException(status_code=422, detail="Неизвестный маркетплейс.")
    database.execute(
        "DELETE FROM wb_accounts WHERE user_id = %s AND platform = %s", (user["id"], platform)
    )
    return {"connected": False, "platform": platform}


@router.get("/photos/{filename}")
def mp_photo_file(filename: str):
    """Публичная раздача фото товаров — по этому адресу их скачивают Ozon и Яндекс Маркет."""
    ext = filename.rsplit(".", 1)[1] if "." in filename else ""
    if not re.fullmatch(r"[A-Za-z0-9]+\.(jpg|png|webp)", filename) or ext not in mp.PHOTO_MIME.values():
        raise HTTPException(status_code=404, detail="Фото не найдено.")
    path = os.path.join(MP_PHOTOS_DIR, filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Фото не найдено.")
    media_type = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}[ext]
    return FileResponse(path, media_type=media_type)


@router.post("/cards")
def create_card(
    photo: UploadFile = File(...),
    name: str = Form(...),
    price_rub: int = Form(...),
    platform: str = Form("wb"),
    user: dict = Depends(get_current_user),
):
    name = name.strip()
    if len(name) < 3:
        raise HTTPException(status_code=422, detail="Укажите название товара (минимум 3 символа).")
    if not (1 <= price_rub <= 10_000_000):
        raise HTTPException(status_code=422, detail="Укажите цену в рублях от 1 до 10 000 000.")
    platform = (platform or "wb").strip().lower()
    if platform not in MARKETPLACES:
        raise HTTPException(status_code=422, detail="Неизвестный маркетплейс. Доступны: Wildberries, Ozon, AliExpress, Яндекс Маркет.")
    mp_name = MARKETPLACES[platform]["name"]

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
        card, model = run_prompt(_card_prompt(name, price_rub, vision_text, platform))
        card = _extract_json(card)
    except AIError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Сервис генерации временно недоступен, попробуйте ещё раз через минуту. ({e})",
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Сбой генерации карточки: {type(e).__name__}: {str(e)[:250]}",
        )
    description = str(card.get("description") or "").strip()
    characteristics = card.get("characteristics") or []
    keywords = str(card.get("keywords") or "").strip()
    if not description:
        raise HTTPException(status_code=502, detail="Модель вернула пустое описание, попробуйте ещё раз.")

    status, error = "ready", None
    subject = None
    if platform == "wb":
        account = database.fetchone(
            "SELECT api_token, extra FROM wb_accounts WHERE user_id = %s AND platform = 'wb'",
            (user["id"],),
        )
        if account:
            try:
                subject = _wb_publish(account[0], photo_bytes, mime, name, card)
                status = "published"
            except WBError as e:
                status = "error"
                error = str(e)[:300]
    elif platform in ("ozon", "yamarket", "aliexpress"):
        account = database.fetchone(
            "SELECT api_token, extra FROM wb_accounts WHERE user_id = %s AND platform = %s",
            (user["id"], platform),
        )
        if account:
            try:
                if platform == "ozon":
                    creds = json.loads(account[0])
                    photo_url = mp.save_photo(photo_bytes, mime)
                    subject = mp.ozon_publish(
                        creds["client_id"], creds["api_key"], photo_url, name, price_rub, card
                    )
                elif platform == "yamarket":
                    extra = json.loads(account[1] or "{}")
                    campaign_id = extra.get("campaign_id")
                    if not campaign_id:
                        raise mp.MarketplaceError("Магазин Маркета подключён без кампании — подключите его заново.")
                    photo_url = mp.save_photo(photo_bytes, mime)
                    subject = mp.yamarket_publish(account[0], campaign_id, photo_url, name, price_rub, card)
                else:
                    creds = json.loads(account[0])
                    subject = mp.aliexpress_publish(creds, photo_bytes, mime, name, price_rub, card)
                status = "published"
            except (mp.MarketplaceError, ValueError) as e:
                status = "error"
                error = str(e)[:300]

    database.execute(
        "INSERT INTO generations (id, user_id, topic, content_type, tone, language, result, model, created_at) "
        "VALUES (%s, %s, %s, 'product', 'продающий', 'ru', %s, %s, %s)",
        (new_id(), user["id"], f"Карточка {mp_name}: {name}", description, model, utcnow()),
    )
    wid = new_id()
    database.execute(
        "INSERT INTO wb_cards (id, user_id, platform, name, price_rub, description, characteristics, keywords, status, error, created_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (
            wid,
            user["id"],
            platform,
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
        "platform": platform,
        "platform_name": mp_name,
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
        "SELECT id, platform, name, price_rub, description, characteristics, keywords, status, error, created_at "
        "FROM wb_cards WHERE user_id = %s ORDER BY created_at DESC LIMIT 20",
        (user["id"],),
    )
    cards = []
    for r in rows:
        try:
            chars = json.loads(r[5]) if r[5] else []
        except ValueError:
            chars = []
        cards.append(
            {
                "id": r[0],
                "platform": r[1] or "wb",
                "platform_name": MARKETPLACES.get(r[1] or "wb", MARKETPLACES["wb"])["name"],
                "name": r[2],
                "price_rub": r[3],
                "description": r[4],
                "characteristics": chars,
                "keywords": r[6],
                "status": r[7],
                "error": r[8],
                "created_at": database.as_dt(r[9]),
            }
        )
    return {"cards": cards}
