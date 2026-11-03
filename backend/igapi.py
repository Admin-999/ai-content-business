"""Обёртка Instagram Graph API: автопостинг через «Instagram API with Instagram Login».

Поток подключения (пошаговая инструкция — frontend/instagram-setup.html):
  1. Клиент создаёт приложение на developers.facebook.com и генерирует
     короткоживущий токен (живёт ~1 час) со скоупами
     instagram_business_basic + instagram_business_content_publish.
  2. Backend сразу обменивает его на долгосрочный (~60 дней) — exchange_token.
  3. Cron-задача автопостинга продлевает токен (refresh_token), пока канал
     активен, и публикует посты: media-контейнер -> media_publish.
"""
import time

import httpx

API_BASE = "https://graph.instagram.com"
API_VERSION = "v23.0"
TIMEOUT = httpx.Timeout(30.0)

# Сколько секунд ждать готовности media-контейнера (обычно 2–10 секунд)
_MEDIA_WAIT_TRIES = 15
_MEDIA_WAIT_STEP = 2


class InstagramError(Exception):
    """Ошибка Instagram API. status_code подставляется в HTTP-ответ клиенту."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


def _request(method: str, url: str, params=None, data=None) -> dict:
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.request(method, url, params=params, data=data)
    except httpx.HTTPError as e:
        raise InstagramError(f"Instagram недоступен: {e}")
    if resp.status_code != 200:
        try:
            err = resp.json().get("error", {})
            msg = err.get("message") or resp.text[:200]
            code = err.get("code")
        except ValueError:
            msg, code = resp.text[:200], None
        # code 190 — токен недействителен или истёк
        if code == 190:
            msg += " Токен истёк — сгенерируйте новый в кабинете Meta и подключите аккаунт заново."
        raise InstagramError(f"Instagram: {msg}")
    try:
        return resp.json()
    except ValueError:
        raise InstagramError("Instagram вернул нечитаемый ответ")


def exchange_token(short_token: str, client_secret: str):
    """Короткий токен (~1 час) -> долгосрочный (~60 дней). Возвращает (token, expires_in)."""
    data = _request(
        "GET",
        f"{API_BASE}/access_token",
        params={
            "grant_type": "ig_exchange_token",
            "client_secret": client_secret,
            "access_token": short_token,
        },
    )
    return data.get("access_token", ""), int(data.get("expires_in", 0))


def refresh_token(long_token: str):
    """Продление долгосрочного токена: снова ~60 дней с момента вызова."""
    data = _request(
        "GET",
        f"{API_BASE}/refresh_access_token",
        params={"grant_type": "ig_refresh_token", "access_token": long_token},
    )
    return data.get("access_token", ""), int(data.get("expires_in", 0))


def get_profile(token: str) -> dict:
    """Профиль аккаунта: user_id (числовой id Instagram) и username."""
    return _request(
        "GET",
        f"{API_BASE}/{API_VERSION}/me",
        params={"fields": "user_id,username", "access_token": token},
    )


def create_media(token: str, ig_user_id: str, image_url: str, caption: str) -> str:
    """Создаёт контейнер публикации. Возвращает creation_id."""
    data = _request(
        "POST",
        f"{API_BASE}/{API_VERSION}/{ig_user_id}/media",
        data={"image_url": image_url, "caption": caption[:2200], "access_token": token},
    )
    return data.get("id", "")


def media_status(token: str, media_id: str) -> str:
    data = _request(
        "GET",
        f"{API_BASE}/{API_VERSION}/{media_id}",
        params={"fields": "status_code", "access_token": token},
    )
    return (data.get("status_code") or "").upper()


def publish_media(token: str, ig_user_id: str, creation_id: str) -> str:
    """Публикует готовый контейнер. Возвращает id опубликованного поста."""
    data = _request(
        "POST",
        f"{API_BASE}/{API_VERSION}/{ig_user_id}/media_publish",
        data={"creation_id": creation_id, "access_token": token},
    )
    return data.get("id", "")


def publish_image(token: str, ig_user_id: str, image_url: str, caption: str) -> str:
    """Полный цикл публикации картинки: контейнер -> ожидание -> публикация."""
    creation_id = create_media(token, ig_user_id, image_url, caption)
    for _ in range(_MEDIA_WAIT_TRIES):
        status = media_status(token, creation_id)
        if status == "FINISHED":
            return publish_media(token, ig_user_id, creation_id)
        if status in ("ERROR", "EXPIRED"):
            raise InstagramError(f"Instagram не принял картинку ({status}).")
        time.sleep(_MEDIA_WAIT_STEP)
    raise InstagramError("Instagram слишком долго обрабатывал картинку — попробуем в следующий запуск.")
