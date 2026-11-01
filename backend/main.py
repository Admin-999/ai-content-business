"""Точка входа backend.

Локальный запуск:  uvicorn main:app --reload  (из папки backend)
Продакшен (Render): uvicorn main:app --host 0.0.0.0 --port $PORT
"""
import logging
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import ALLOW_ALL_ORIGINS, FRONTEND_ORIGINS, SECRET_KEY
from database import init_db
from routers import auth, billing, cron, generate, usage

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("app")


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()  # таблицы создаются автоматически при первом старте
    if SECRET_KEY.startswith("dev-"):
        logger.warning("SECRET_KEY не задан — используется ключ по умолчанию! Установите его в переменных окружения.")
    yield


app = FastAPI(
    title="AI Content API",
    description="Backend сервиса автоматической генерации контента для малого бизнеса",
    version="1.0.0",
    lifespan=lifespan,
)

# --- Простой rate limiting: 60 запросов в минуту на IP (in-memory, достаточно для одного инстанса free tier) ---
_requests: dict = defaultdict(deque)
RATE_LIMIT = 60
RATE_WINDOW = 60.0


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.url.path != "/api/health":
        ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        if not ip and request.client:
            ip = request.client.host
        now = time.time()
        bucket = _requests[ip]
        while bucket and bucket[0] < now - RATE_WINDOW:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT:
            return JSONResponse(
                status_code=429,
                content={"detail": "Слишком много запросов. Подождите минуту и попробуйте снова."},
            )
        bucket.append(now)
    return await call_next(request)


# CORS добавляется ПОСЛЕ rate limiter, чтобы быть внешним middleware
# и подписывать CORS-заголовки в том числе на ответах 429.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if ALLOW_ALL_ORIGINS else FRONTEND_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_errors_middleware(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception:
        logger.exception("Необработанная ошибка на %s %s", request.method, request.url.path)
        raise


# --- Роутеры ---
app.include_router(auth.router)
app.include_router(generate.router)
app.include_router(usage.router)
app.include_router(billing.router)
app.include_router(cron.router)


@app.get("/api/health")
def health():
    """Используется Render как health check и для мониторинга."""
    return {"status": "ok"}


@app.get("/")
def root():
    return {"service": "AI Content API", "docs": "/docs"}
