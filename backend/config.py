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
PRO_PRICE_RUB = _get_int("PRO_PRICE_RUB", 990)
PRO_PERIOD_DAYS = _get_int("PRO_PERIOD_DAYS", 30)
