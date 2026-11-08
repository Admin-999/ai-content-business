"""Точка входа для Vercel (serverless).

Vercel ищет объект `app` (FastAPI) в файлах index.py / app.py / main.py.
Здесь мы просто добавляем папку backend в sys.path и импортируем приложение
оттуда — так продолжают работать «плоские» импорты внутри backend
(from config import ... , from database import ...).

Для Render этот файл не используется (там запускается uvicorn main:app
из папки backend).
"""
import os
import sys

_BACKEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend")
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from main import app  # noqa: E402,F401
