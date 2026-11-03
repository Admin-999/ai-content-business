"""Генерация текста через бесплатные LLM API.

Цепочка провайдеров: Google Gemini -> Groq -> универсальный OpenAI-совместимый
(OpenRouter, GitHub Models и любые другие). Работают те, у кого задан ключ.
"""
import base64

import httpx

from config import (
    GEMINI_API_KEY,
    GEMINI_MODEL,
    GROQ_API_KEY,
    GROQ_MODEL,
    GROQ_VISION_MODEL,
    OPENAI_COMPAT_API_KEY,
    OPENAI_COMPAT_BASE_URL,
    OPENAI_COMPAT_MODEL,
)

TIMEOUT = httpx.Timeout(60.0)

CONTENT_TYPES = ("post", "article", "product")


class AIError(Exception):
    """Единая ошибка генерации — наружу отдаётся понятным текстом с кодом 502."""


_TASKS = {
    "post": (
        "Напиши вовлекающий пост для социальных сетей на тему: «{topic}». "
        "Объём 150–250 слов. Первый абзац должен цеплять внимание. "
        "В конце добавь призыв к действию и 3–5 хештегов."
    ),
    "article": (
        "Напиши статью для корпоративного блога на тему: «{topic}». "
        "Объём 500–800 слов. Структура: цепляющий заголовок, вступление, "
        "3–4 смысловых блока с подзаголовками, практические советы, короткий вывод."
    ),
    "product": (
        "Напиши продающее описание товара для интернет-магазина: «{topic}». "
        "Объём 150–300 слов. Структура: цепляющий заголовок, 3–5 ключевых выгод "
        "списком, краткое описание, призыв к действию."
    ),
}


def build_prompt(topic: str, content_type: str, tone: str, language: str) -> str:
    task = _TASKS.get(content_type, _TASKS["post"]).format(topic=topic)
    tone_line = f"Тон текста: {tone}." if tone else ""
    if language == "ru":
        lang_line = "русском"
    elif language == "en":
        lang_line = "английском"
    else:
        lang_line = language
    return (
        "Ты — профессиональный коммерческий копирайтер с опытом 10 лет.\n"
        f"Задача: {task}\n"
        f"{tone_line}\n"
        f"Напиши текст на {lang_line} языке.\n"
        "В ответе выведи только готовый текст, без пояснений и служебных пометок."
    )


def _gemini_text(data: dict) -> str:
    candidates = data.get("candidates") or []
    parts = []
    if candidates:
        parts = (candidates[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts).strip()
    if not text:
        raise AIError("Gemini вернул пустой ответ")
    return text


def _chat_text(data: dict, label: str) -> str:
    choices = data.get("choices") or [{}]
    text = (choices[0].get("message") or {}).get("content", "").strip()
    if not text:
        raise AIError(f"{label} вернул пустой ответ")
    return text


def _call_gemini(client: httpx.Client, prompt: str) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    resp = client.post(
        url,
        headers={"x-goog-api-key": GEMINI_API_KEY},
        json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.8, "maxOutputTokens": 2048},
        },
    )
    if resp.status_code != 200:
        raise AIError(f"Gemini HTTP {resp.status_code}: {resp.text[:200]}")
    return _gemini_text(resp.json())


def _call_groq(client: httpx.Client, prompt: str) -> str:
    resp = client.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
        json={
            "model": GROQ_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.8,
            "max_tokens": 2048,
        },
    )
    if resp.status_code != 200:
        raise AIError(f"Groq HTTP {resp.status_code}: {resp.text[:200]}")
    return _chat_text(resp.json(), "Groq")


def _call_openai_compat(client: httpx.Client, prompt: str) -> str:
    """Любой OpenAI-совместимый провайдер: OpenRouter, GitHub Models и т.п."""
    resp = client.post(
        f"{OPENAI_COMPAT_BASE_URL}/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_COMPAT_API_KEY}"},
        json={
            "model": OPENAI_COMPAT_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.8,
            "max_tokens": 2048,
        },
    )
    if resp.status_code != 200:
        raise AIError(f"AI HTTP {resp.status_code}: {resp.text[:200]}")
    return _chat_text(resp.json(), "AI-провайдер")


def _text_providers(prompt: str):
    """Список (метка, функция(client)) текстовых провайдеров с замыканием на промпт."""
    providers = []
    if GEMINI_API_KEY:
        providers.append((f"gemini:{GEMINI_MODEL}", lambda c: _call_gemini(c, prompt)))
    if GROQ_API_KEY:
        providers.append((f"groq:{GROQ_MODEL}", lambda c: _call_groq(c, prompt)))
    if OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY and OPENAI_COMPAT_MODEL:
        providers.append((f"compat:{OPENAI_COMPAT_MODEL}", lambda c: _call_openai_compat(c, prompt)))
    if not providers:
        raise AIError("Не настроен ни один AI-провайдер. Добавьте GEMINI_API_KEY или GROQ_API_KEY.")
    return providers


def _run_chain(providers):
    """Пробует провайдеров по очереди. Возвращает (текст, имя_модели)."""
    last_error = None
    with httpx.Client(timeout=TIMEOUT) as client:
        for label, fn in providers:
            try:
                return fn(client), label
            except (AIError, httpx.HTTPError) as e:
                last_error = e
    raise AIError(str(last_error))


def run_prompt(prompt: str):
    """Базовый вызов LLM: один промпт без системной роли."""
    return _run_chain(_text_providers(prompt))


def generate_content(topic: str, content_type: str, tone: str = "дружелюбный", language: str = "ru"):
    """Возвращает (текст, имя_модели)."""
    return run_prompt(build_prompt(topic, content_type, tone, language))


def chat_text(system: str, user: str):
    """Диалоговый вызов для ИИ-ботов: роль бота + сообщение клиента."""
    prompt = f"{system}\n\nСообщение клиента: {user}"
    return run_prompt(prompt)


def _vision_gemini(client: httpx.Client, prompt: str, b64: str, mime: str) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    resp = client.post(
        url,
        headers={"x-goog-api-key": GEMINI_API_KEY},
        json={
            "contents": [{"parts": [
                {"text": prompt},
                {"inline_data": {"mime_type": mime, "data": b64}},
            ]}],
            "generationConfig": {"temperature": 0.4, "maxOutputTokens": 2048},
        },
    )
    if resp.status_code != 200:
        raise AIError(f"Gemini HTTP {resp.status_code}: {resp.text[:200]}")
    return _gemini_text(resp.json())


def _vision_groq(client: httpx.Client, prompt: str, b64: str, mime: str) -> str:
    resp = client.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
        json={
            "model": GROQ_VISION_MODEL,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ]}],
            "temperature": 0.4,
            "max_tokens": 2048,
        },
    )
    if resp.status_code != 200:
        raise AIError(f"Groq HTTP {resp.status_code}: {resp.text[:200]}")
    return _chat_text(resp.json(), "Groq")


def describe_image(image_bytes: bytes, mime: str, prompt: str):
    """Распознавание фото товара (vision-модель). Возвращает (описание, имя_модели)."""
    b64 = base64.b64encode(image_bytes).decode("ascii")
    providers = []
    if GEMINI_API_KEY:
        providers.append((f"gemini:{GEMINI_MODEL}", lambda c: _vision_gemini(c, prompt, b64, mime)))
    if GROQ_API_KEY:
        providers.append((f"groq:{GROQ_VISION_MODEL}", lambda c: _vision_groq(c, prompt, b64, mime)))
    if not providers:
        raise AIError("Для анализа фото нужен GEMINI_API_KEY или GROQ_API_KEY.")
    return _run_chain(providers)
