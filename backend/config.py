"""Конфигурация backend. Все значения берутся из переменных окружения (.env локально, дашборд Render — в продакшене)."""
import os

from dotenv import load_dotenv

load_dotenv()


def _get_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


# --- База данных ---
# Supabase Postgres: postgresql://postgres.<ref>:<пароль>@aws-0-<регион>.pooler.supabase.com:6543/postgres
# Локально по умолчанию используется SQLite (работает без настройки).
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./local.db")


def is_postgres() -> bool:
    return DATABASE_URL.startswith(("postgres://", "postgresql://"))


# --- Безопасность ---
SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-change-me")
TOKEN_TTL_DAYS = _get_int("TOKEN_TTL_DAYS", 7)

# --- AI-провайдеры (оба бесплатные) ---
# Основной: Google Gemini (aistudio.google.com). Резервный: Groq (console.groq.com).
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
# Универсальный резерв: любой OpenAI-совместимый API (OpenRouter, GitHub Models и др.)
OPENAI_COMPAT_BASE_URL = os.getenv("OPENAI_COMPAT_BASE_URL", "").rstrip("/")
OPENAI_COMPAT_API_KEY = os.getenv("OPENAI_COMPAT_API_KEY", "").strip()
OPENAI_COMPAT_MODEL = os.getenv("OPENAI_COMPAT_MODEL", "")

# --- CORS ---
# Адреса frontend через запятую. В продакшене укажите URL с Vercel, например:
# FRONTEND_ORIGIN=https://my-app.vercel.app
_origins = os.getenv("FRONTEND_ORIGIN", "*")
FRONTEND_ORIGINS = [o.strip() for o in _origins.split(",") if o.strip()]
ALLOW_ALL_ORIGINS = "*" in FRONTEND_ORIGINS

# --- Cron / email ---
CRON_SECRET = os.getenv("CRON_SECRET", "")
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "").strip()
EMAIL_FROM = os.getenv("EMAIL_FROM", "AI Контент <onboarding@resend.dev>")
FRONTEND_URL = os.getenv("FRONTEND_URL", "").rstrip("/")
# Ограничение рассылки, чтобы не выйти за free-лимит Resend (100 писем/день)
EMAIL_REPORT_MAX = _get_int("EMAIL_REPORT_MAX", 80)

# --- Тарифы ---
FREE_DAILY_LIMIT = _get_int("FREE_DAILY_LIMIT", 5)
PRO_DAILY_LIMIT = _get_int("PRO_DAILY_LIMIT", 100)
PRO_PLUS_DAILY_LIMIT = _get_int("PRO_PLUS_DAILY_LIMIT", 300)
PRO_PRICE_RUB = _get_int("PRO_PRICE_RUB", 299)
PRO_PLUS_PRICE_RUB = _get_int("PRO_PLUS_PRICE_RUB", 990)
PRO_PERIOD_DAYS = _get_int("PRO_PERIOD_DAYS", 30)

# --- Автоматизация: Telegram и Wildberries ---
# Токен единственного бота сервиса: им клиенты добавляют администратором канала
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
# Папка для PNG-карточек автопостинга Instagram (в Modal — постоянный том /data)
IG_CARDS_DIR = os.getenv("IG_CARDS_DIR", "/data/ig_cards" if os.path.isdir("/data") else "./ig_cards")
# Папка фото товаров: Ozon и Яндекс Маркет скачивают фото по публичной ссылке
MP_PHOTOS_DIR = os.getenv("MP_PHOTOS_DIR", "/data/mp_photos" if os.path.isdir("/data") else "./mp_photos")
# Кэш дерева категорий Ozon (обновляется раз в неделю, файл может быть на десятки МБ)
OZON_CACHE = os.getenv("OZON_CACHE", "/data/ozon_categories.json" if os.path.isdir("/data") else "./ozon_categories.json")
# Шлюз API AliExpress (протокол TOP): глобальный api-sg.aliexpress.com проверен и отвечает;
# при необходимости можно переопределить другим регионом через переменную окружения
ALIEXPRESS_GATEWAY = os.getenv("ALIEXPRESS_GATEWAY", "https://api-sg.aliexpress.com/sync").rstrip("/")
# Публичный адрес этого backend: по нему Telegram шлёт обновления ИИ-ботов,
# а Instagram скачивает картинки-карточки постов.
# На Render подставляется автоматически (RENDER_EXTERNAL_URL) — задавать вручную не нужно.
BACKEND_URL = (
    os.getenv("BACKEND_URL", "").rstrip("/")
    or os.getenv("RENDER_EXTERNAL_URL", "").rstrip("/")
    or "http://localhost:8000"
)
# Модель с распознаванием изображений (фото товаров Wildberries)
GROQ_VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "qwen/qwen3.8-27b")
# API контента Wildberries (кабинет продавца)
WB_CONTENT_API = os.getenv("WB_CONTENT_API", "https://content-api.wildberries.ru").rstrip("/")
# Сколько ответов в сутки даёт один ИИ-бот
BOT_DAILY_REPLY_LIMIT = _get_int("BOT_DAILY_REPLY_LIMIT", 200)
