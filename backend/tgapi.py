"""Обёртка Telegram Bot API: автопостинг в каналы и webhook ИИ-ботов."""
import httpx

API_BASE = "https://api.telegram.org"
TIMEOUT = httpx.Timeout(30.0)


class TelegramError(Exception):
    """Ошибка Telegram API. status_code подставляется в HTTP-ответ клиенту."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


def _call(token: str, method: str, payload=None):
    url = f"{API_BASE}/bot{token}/{method}"
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.post(url, json=payload or {})
    except httpx.HTTPError as e:
        raise TelegramError(f"Telegram недоступен: {e}")
    if resp.status_code != 200:
        raise TelegramError(f"Telegram HTTP {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    if not data.get("ok"):
        raise TelegramError(f"Telegram: {data.get('description', 'неизвестная ошибка')}")
    return data.get("result")


def get_me(token: str):
    """Информация о боте; заодно проверяет, что токен действителен."""
    return _call(token, "getMe")


def get_chat(token: str, chat_id: str):
    """Данные о чате/канале; работает, только если бот добавлен в канал."""
    return _call(token, "getChat", {"chat_id": chat_id})


def send_message(token: str, chat_id: str, text: str):
    return _call(
        token,
        "sendMessage",
        {
            "chat_id": chat_id,
            "text": text[:4000],
            "disable_web_page_preview": True,
        },
    )


def set_webhook(token: str, url: str, secret: str):
    """Направляет обновления бота на наш backend; secret проверяется в webhook."""
    return _call(
        token,
        "setWebhook",
        {"url": url, "secret_token": secret, "allowed_updates": ["message"]},
    )


def delete_webhook(token: str):
    return _call(token, "deleteWebhook")
