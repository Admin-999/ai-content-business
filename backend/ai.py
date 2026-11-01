"""Генерация текста через бесплатные LLM API.

Цепочка провайдеров: Google Gemini -> Groq -> универсальный OpenAI-совместимый
(OpenRouter, GitHub Models и любые другие). Работают те, у кого задан ключ.
"""
import httpx

from config import (
    GEMINI_API_KEY,
    GEMINI_MODEL,
    GROQ_API_KEY,
    GROQ_MODEL,
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
    data = resp.json()
    candidates = data.get("candidates") or []
    parts = []
    if candidates:
        parts = (candidates[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts).strip()
    if not text:
        raise AIError("Gemini вернул пустой ответ")
    return text


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
    choices = resp.json().get("choices") or [{}]
    text = (choices[0].get("message") or {}).get("content", "").strip()
    if not text:
        raise AIError("Groq вернул пустой ответ")
    return text


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
    choices = resp.json().get("choices") or [{}]
    text = (choices[0].get("message") or {}).get("content", "").strip()
    if not text:
        raise AIError("AI-провайдер вернул пустой ответ")
    return text


def generate_content(topic: str, content_type: str, tone: str = "дружелюбный", language: str = "ru"):
    """Возвращает (текст, имя_модели). Пробует провайдеров по очереди."""
    prompt = build_prompt(topic, content_type, tone, language)
    providers = []
    if GEMINI_API_KEY:
        providers.append((f"gemini:{GEMINI_MODEL}", _call_gemini))
    if GROQ_API_KEY:
        providers.append((f"groq:{GROQ_MODEL}", _call_groq))
    if OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY and OPENAI_COMPAT_MODEL:
        providers.append((f"compat:{OPENAI_COMPAT_MODEL}", _call_openai_compat))
    if not providers:
        raise AIError("Не настроен ни один AI-провайдер. Добавьте GEMINI_API_KEY или GROQ_API_KEY.")

    last_error = None
    with httpx.Client(timeout=TIMEOUT) as client:
        for label, fn in providers:
            try:
                return fn(client, prompt), label
            except (AIError, httpx.HTTPError) as e:
                last_error = e
    raise AIError(str(last_error))
