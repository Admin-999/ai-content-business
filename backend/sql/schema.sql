-- Схема БД для Supabase (Postgres).
--
-- ОБЫЧНО НЕ НУЖНА: таблицы создаются автоматически при первом запуске backend.
-- Используйте для ручной инициализации:
--   Supabase Dashboard -> SQL Editor -> вставить весь файл -> Run.

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    plan_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    content_type TEXT NOT NULL,
    tone TEXT,
    language TEXT,
    result TEXT NOT NULL,
    model TEXT,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_generations_user ON generations (user_id, created_at);

CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    status TEXT NOT NULL,
    amount_rub INTEGER,
    payment_ref TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ
);
