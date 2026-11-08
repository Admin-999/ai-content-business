# Сборка backend для хостинга (Northflank и любой другой контейнерный хост).
# Собирается из корня репозитория: docker build -t ai-content-api .
# Запуск: uvicorn main:app на порту $PORT (Northflank подставляет его сам).
FROM python:3.12-slim

WORKDIR /app

# Системные зависимости для psycopg2 (в slim-образе их нет)
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Сначала зависимости — так слой кэшируется и пересборка идёт быстрее
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Затем код backend (плоские импорты: from config import ...)
COPY backend/*.py ./
COPY backend/routers ./routers

ENV PYTHONUNBUFFERED=1
# Значение по умолчанию; Northflank передаёт настоящий PORT через переменную окружения
ENV PORT=8000

EXPOSE 8000

# shell-форма нужна, чтобы подставить $PORT
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
