---
title: AI Content API
sdk: docker
app_port: 7860
pinned: false
---

Backend сервиса автоматической генерации контента (FastAPI).

- Проверка доступности: `/api/health`
- Документация API: `/docs`

Все настройки передаются переменными окружения (Space Secrets): `SECRET_KEY`, `GROQ_API_KEY`, `CRON_SECRET`, опционально `DATABASE_URL` (Postgres), `FRONTEND_ORIGIN`, `FRONTEND_URL`, `RESEND_API_KEY`.

По умолчанию используется SQLite внутри контейнера. Данные сохраняются между перезапусками только при подключённом Postgres (например, Supabase).
