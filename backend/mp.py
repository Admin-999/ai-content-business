"""Публикация карточек в кабинеты продавца Ozon и Яндекс Маркета.

Wildberries принимает файл фото напрямую, а Ozon и Маркет скачивают картинку
по ссылке — поэтому фото товара сохраняется в MP_PHOTOS_DIR и раздаётся
публично (роут /api/wb/photos/{файл} в routers/wildberries.py).

Все функции бросают MarketplaceError с понятным текстом — вызывающий код
переводит сбой в статус карточки «error», а сама карточка остаётся готовой
к ручной публикации.
"""
import hashlib
import json
import os
import re
import time

import httpx

from config import ALIEXPRESS_GATEWAY, BACKEND_URL, MP_PHOTOS_DIR, OZON_CACHE

OZON_API = "https://api-seller.ozon.ru"
YM_API = "https://api.partner.market.yandex.ru"
MP_TIMEOUT = httpx.Timeout(30.0)
TREE_TIMEOUT = httpx.Timeout(90.0)
TREE_TTL_SECONDS = 7 * 24 * 3600
PHOTO_MIME = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
_STOP_WORDS = {"и", "в", "для", "на", "с", "из", "по", "от", "без", "the", "a"}


class MarketplaceError(Exception):
    """Сбой обращения к API маркетплейса."""


def save_photo(data: bytes, mime: str) -> str:
    """Сохраняет фото на диск и возвращает публичный URL для Ozon/Яндекс Маркета."""
    ext = PHOTO_MIME.get(mime, "jpg")
    name = hashlib.sha256(data).hexdigest()[:24] + "." + ext
    os.makedirs(MP_PHOTOS_DIR, exist_ok=True)
    path = os.path.join(MP_PHOTOS_DIR, name)
    if not os.path.isfile(path):
        with open(path, "wb") as f:
            f.write(data)
    return f"{BACKEND_URL}/api/wb/photos/{name}"


def _words(text: str) -> set:
    return set(re.split(r"[^0-9a-zа-яё]+", (text or "").lower())) - _STOP_WORDS


def _stems(words: set) -> set:
    """Основы слов (первые 5 символов), чтобы «кружка» совпала с «кружки»."""
    out = set()
    for w in words:
        if len(w) >= 5:
            out.add(w[:5])
        elif len(w) >= 3:
            out.add(w)
    return out


def pick_category(categories, name: str, keywords: str):
    """Категория с максимальным совпадением основ слов с названием товара."""
    stems = _stems(_words(f"{name} {keywords or ''}"))
    best, best_score = None, 0
    for cat in categories:
        score = len(stems & _stems(_words(cat.get("p") or "")))
        if score > best_score:
            best, best_score = cat, score
    return best


# ===== Ozon =====

def _ozon_headers(client_id: str, api_key: str) -> dict:
    return {"Client-Id": client_id, "Api-Key": api_key, "Content-Type": "application/json"}


def ozon_validate(client_id: str, api_key: str) -> None:
    """Проверяет ключи Ozon дешёвым запросом списка товаров."""
    try:
        with httpx.Client(timeout=MP_TIMEOUT) as client:
            resp = client.post(
                f"{OZON_API}/v3/product/list",
                headers=_ozon_headers(client_id, api_key),
                json={"filter": {}, "limit": 1},
            )
    except httpx.HTTPError as e:
        raise MarketplaceError(f"Ozon недоступен: {e}")
    if resp.status_code in (401, 403):
        raise MarketplaceError("Ключи Ozon отклонены (проверьте кабинет продавца).")
    if resp.status_code != 200:
        raise MarketplaceError(f"Ozon HTTP {resp.status_code}: {resp.text[:200]}")


def _flatten_category(node: dict, prefix: str, out: list) -> None:
    title = (node.get("category_name") or "").strip()
    path = f"{prefix} > {title}" if prefix else title
    cid = node.get("description_category_id")
    children = node.get("children") or []
    if cid and not children:
        out.append({"id": cid, "p": path})
    for child in children:
        _flatten_category(child, path, out)


def load_ozon_categories(client_id: str, api_key: str) -> list:
    """Листовые категории Ozon; дерево огромное, поэтому кэшируется в файл на неделю."""
    try:
        if os.path.isfile(OZON_CACHE):
            if time.time() - os.path.getmtime(OZON_CACHE) < TREE_TTL_SECONDS:
                with open(OZON_CACHE, encoding="utf-8") as f:
                    return json.load(f)
    except (OSError, ValueError):
        pass
    try:
        with httpx.Client(timeout=TREE_TIMEOUT) as client:
            resp = client.post(
                f"{OZON_API}/v1/description-category/tree",
                headers=_ozon_headers(client_id, api_key),
            )
    except httpx.HTTPError as e:
        raise MarketplaceError(f"Не удалось получить категории Ozon: {e}")
    if resp.status_code != 200:
        raise MarketplaceError(f"Категории Ozon: HTTP {resp.status_code}: {resp.text[:200]}")
    out: list = []
    for node in resp.json().get("result") or []:
        _flatten_category(node, "", out)
    try:
        cache_dir = os.path.dirname(OZON_CACHE)
        if cache_dir:
            os.makedirs(cache_dir, exist_ok=True)
        tmp = OZON_CACHE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
        os.replace(tmp, OZON_CACHE)
    except OSError:
        pass
    return out


def ozon_publish(client_id: str, api_key: str, photo_url: str, name: str, price: int, card: dict) -> str:
    """Создаёт товар в Ozon через Product Import API. Возвращает описание результата."""
    categories = load_ozon_categories(client_id, api_key)
    cat = pick_category(categories, name, card.get("keywords") or "")
    if not cat:
        raise MarketplaceError("Не удалось подобрать категорию товара в Ozon.")
    sku = "ac-" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]
    item = {
        "name": name,
        "offer_id": sku,
        "price": str(price),
        "vat": "0",
        "description_category_id": cat["id"],
        "attributes": [
            {"complex_id": 0, "id": 4180, "values": [{"value": name}]},
            {"complex_id": 0, "id": 4190, "values": [{"value": (card.get("description") or "")[:6000]}]},
        ],
        "images": [photo_url],
    }
    with httpx.Client(timeout=MP_TIMEOUT) as client:
        headers = _ozon_headers(client_id, api_key)
        try:
            resp = client.post(f"{OZON_API}/v2/product/import", headers=headers, json={"items": [item]})
        except httpx.HTTPError as e:
            raise MarketplaceError(f"Не удалось создать карточку в Ozon: {e}")
        if resp.status_code not in (200, 201):
            raise MarketplaceError(f"Создание в Ozon: HTTP {resp.status_code}: {resp.text[:200]}")
        task_id = (resp.json().get("result") or {}).get("task_id")
        if task_id is None:
            return f"категория: {cat['p']}"
        errors: list = []
        for _ in range(3):
            time.sleep(2.0)
            try:
                info = client.post(f"{OZON_API}/v1/product/import/info", headers=headers, json={"task_id": task_id})
            except httpx.HTTPError:
                break
            if info.status_code != 200:
                break
            items = (info.json().get("result") or {}).get("items") or []
            if items:
                errors = [
                    str(err.get("message") or err)[:200]
                    for it in items
                    for err in (it.get("errors") or [])
                ]
                break
        if errors:
            raise MarketplaceError(f"Ozon: {'; '.join(errors[:2])}")
    return f"категория: {cat['p']}"


# ===== Яндекс Маркет =====

def _ym_headers(token: str) -> dict:
    return {"Authorization": f"OAuth {token}", "Content-Type": "application/json", "Accept": "application/json"}


def yamarket_validate(token: str) -> int:
    """Проверяет токен и возвращает id кампании (магазина) для публикации."""
    try:
        with httpx.Client(timeout=MP_TIMEOUT) as client:
            resp = client.get(f"{YM_API}/v2/campaigns", headers=_ym_headers(token))
    except httpx.HTTPError as e:
        raise MarketplaceError(f"Яндекс Маркет недоступен: {e}")
    if resp.status_code in (401, 403):
        raise MarketplaceError("Токен Яндекс Маркета отклонён (проверьте кабинет магазина).")
    if resp.status_code != 200:
        raise MarketplaceError(f"Яндекс Маркет HTTP {resp.status_code}: {resp.text[:200]}")
    campaigns = resp.json().get("campaigns") or []
    if not campaigns:
        raise MarketplaceError("У этого токета нет ни одного магазина — проверьте кабинет Яндекс Маркета.")
    return campaigns[0].get("id")


def yamarket_publish(token: str, campaign_id: int, photo_url: str, name: str, price: int, card: dict) -> str:
    """Создаёт карточку товара и обновляет цену в кабинете Маркета."""
    headers = _ym_headers(token)
    sku = "ac-" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]
    card_body = {
        "cards": [
            {
                "offer": {"shopSku": sku, "name": name, "description": (card.get("description") or "")[:6000]},
                "media": [{"type": "PHOTO", "url": photo_url}],
            }
        ],
    }
    with httpx.Client(timeout=MP_TIMEOUT) as client:
        try:
            resp = client.put(f"{YM_API}/v2/campaigns/{campaign_id}/offer-cards", headers=headers, json=card_body)
        except httpx.HTTPError as e:
            raise MarketplaceError(f"Не удалось создать карточку в Маркете: {e}")
        if resp.status_code not in (200, 201, 204):
            raise MarketplaceError(f"Создание в Маркете: HTTP {resp.status_code}: {resp.text[:200]}")
        try:
            resp = client.post(
                f"{YM_API}/v2/campaigns/{campaign_id}/offer-prices",
                headers=headers,
                json={"offers": [{"shopSku": sku, "price": {"value": str(price), "currencyId": "RUR"}}]},
            )
        except httpx.HTTPError:
            resp = None
        if resp is not None and resp.status_code not in (200, 201, 204):
            raise MarketplaceError(f"Карточка создана, но цена не обновилась: HTTP {resp.status_code}: {resp.text[:200]}")
    return f"артикул: {sku}"


# ===== AliExpress (протокол TOP: подпись MD5, приложение из Open Platform) =====

def _ali_sign(params: dict, secret: str) -> str:
    src = secret + "".join(k + str(params[k]) for k in sorted(params)) + secret
    return hashlib.md5(src.encode("utf-8")).hexdigest().upper()


def _ali_call(app_key: str, app_secret: str, access_token: str, method: str, api_params: dict = None, files: dict = None) -> dict:
    """POST на шлюз AliExpress с обязательной подписью запроса."""
    params = {
        "method": method,
        "app_key": app_key,
        "session": access_token,
        "timestamp": str(int(time.time() * 1000)),
        "format": "JSON",
        "v": "2.0",
        "sign_method": "md5",
    }
    params.update({k: str(v) for k, v in (api_params or {}).items()})
    params["sign"] = _ali_sign(params, app_secret)
    try:
        with httpx.Client(timeout=MP_TIMEOUT) as client:
            if files:
                resp = client.post(ALIEXPRESS_GATEWAY, data=params, files=files)
            else:
                resp = client.post(ALIEXPRESS_GATEWAY, data=params)
    except httpx.HTTPError as e:
        raise MarketplaceError(f"AliExpress недоступен: {e}")
    try:
        data = resp.json()
    except ValueError:
        raise MarketplaceError(f"AliExpress: неожиданный ответ HTTP {resp.status_code}: {resp.text[:200]}")
    if isinstance(data, dict) and "error_response" in data:
        err = data["error_response"] or {}
        msg = " ".join(str(err.get(k)) for k in ("msg", "sub_msg") if err.get(k)).strip()
        raise MarketplaceError(f"AliExpress отклонил запрос: {msg[:220] or resp.text[:220]}")
    return data


def _ali_find(obj, keys: tuple):
    """Рекурсивно ищет первое непустое значение по списку имён ключей (ответы AliExpress глубоко вложены)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in keys and v not in (None, "", [], {}):
                return v
        for v in obj.values():
            found = _ali_find(v, keys)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = _ali_find(item, keys)
            if found is not None:
                return found
    return None


def aliexpress_validate(app_key: str, app_secret: str, access_token: str) -> None:
    """Проверяет ключи приложения дешёвым запросом рекомендованных категорий."""
    _ali_call(app_key, app_secret, access_token, "aliexpress.category.recommendfun.get", {"title": "test"})


def aliexpress_upload_photo(app_key: str, app_secret: str, access_token: str, photo_bytes: bytes, mime: str) -> str:
    """Загружает фото в фотобанк продавца и возвращает публичный URL AliExpress."""
    ext = PHOTO_MIME.get(mime, "jpg")
    data = _ali_call(
        app_key, app_secret, access_token,
        "aliexpress.photobank.image.upload",
        {},
        files={"image": (f"item.{ext}", photo_bytes, mime)},
    )
    url = _ali_find(data, ("url", "image_url", "image_full_path", "full_image_url"))
    if not isinstance(url, str) or not url.startswith("http"):
        raise MarketplaceError("AliExpress не вернул адрес загруженного фото.")
    return url


def aliexpress_pick_category(app_key: str, app_secret: str, access_token: str, name: str):
    data = _ali_call(
        app_key, app_secret, access_token,
        "aliexpress.category.recommendfun.get",
        {"title": name[:50]},
    )
    cats = _ali_find(data, ("result_list", "category_list", "categories", "list"))
    if not isinstance(cats, list) or not cats:
        raise MarketplaceError("Не удалось подобрать категорию товара в AliExpress.")
    cat_id = _ali_find(cats[0], ("category_id", "cat_id", "id"))
    if not cat_id:
        raise MarketplaceError("Не удалось подобрать категорию товара в AliExpress.")
    return cat_id


def aliexpress_publish(creds: dict, photo_bytes: bytes, mime: str, name: str, price: int, card: dict) -> str:
    """Публикует товар через Open Platform: фотобанк -> категория -> карточка."""
    app_key, app_secret, token = creds["app_key"], creds["app_secret"], creds["access_token"]
    image_url = aliexpress_upload_photo(app_key, app_secret, token, photo_bytes, mime)
    cat_id = aliexpress_pick_category(app_key, app_secret, token, name)
    keywords = ", ".join([w.strip() for w in (card.get("keywords") or "").split(",") if w.strip()][:3])
    product = {
        "subject": name[:128],
        "image_urls": [image_url],
        "product_units": [{"price": str(price), "sku_id": "default"}],
        "keyword_product": keywords[:128],
        "description": (card.get("description") or "")[:3000],
    }
    data = _ali_call(
        app_key, app_secret, token,
        "aliexpress.solution.open.product.publish",
        {"product": json.dumps(product, ensure_ascii=False), "cat_id": str(cat_id)},
    )
    product_id = _ali_find(data, ("product_id", "productId"))
    return f"ID товара: {product_id}" if product_id else "отправлена в AliExpress"
