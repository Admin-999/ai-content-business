"""Слой доступа к данным: Supabase Postgres в продакшене или локальный SQLite.

Единый интерфейс для обоих движков:
  - fetchall(sql, params) -> list[tuple]  (только SELECT)
  - fetchone(sql, params) -> tuple | None (только SELECT)
  - execute(sql, params)                  (INSERT / UPDATE / CREATE)
Идентификаторы и даты формируются в Python, поэтому SQL одинаковый для обеих БД.
"""
import datetime
import logging
import sqlite3
import threading

from config import DATABASE_URL, is_postgres

logger = logging.getLogger("app.db")

_lock = threading.Lock()
_pg_pool = None
_sqlite = None

DDL = [
    """CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        plan_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS generations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        content_type TEXT NOT NULL,
        tone TEXT,
        language TEXT,
        result TEXT NOT NULL,
        model TEXT,
        created_at TIMESTAMPTZ NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS idx_generations_user ON generations (user_id, created_at)",
    """CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        plan TEXT NOT NULL,
        status TEXT NOT NULL,
        amount_rub INTEGER,
        payment_ref TEXT,
        started_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ
    )""",
    """CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        bot_token TEXT NOT NULL,
        channel_username TEXT NOT NULL,
        tone TEXT NOT NULL DEFAULT 'дружелюбный',
        interval_hours INTEGER NOT NULL DEFAULT 12,
        active INTEGER NOT NULL DEFAULT 1,
        last_post_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        platform TEXT NOT NULL DEFAULT 'telegram',
        access_token TEXT,
        ig_user_id TEXT,
        ig_username TEXT,
        token_expires_at TIMESTAMPTZ
    )""",
    "CREATE INDEX IF NOT EXISTS idx_channels_active ON channels (active)",
    """CREATE TABLE IF NOT EXISTS channel_posts (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS idx_channel_posts_channel ON channel_posts (channel_id, created_at)",
    """CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        tone TEXT NOT NULL,
        knowledge TEXT NOT NULL,
        bot_token TEXT NOT NULL,
        webhook_secret TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        replies_today INTEGER NOT NULL DEFAULT 0,
        stat_date TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        platform TEXT NOT NULL DEFAULT 'telegram',
        app_id TEXT,
        app_secret TEXT,
        ig_user_id TEXT,
        token_expires_at TIMESTAMPTZ
    )""",
    "CREATE INDEX IF NOT EXISTS idx_bots_active ON bots (active)",
    """CREATE TABLE IF NOT EXISTS wb_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        api_token TEXT NOT NULL,
        added_at TIMESTAMPTZ NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS wb_cards (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        price_rub INTEGER NOT NULL,
        description TEXT NOT NULL,
        characteristics TEXT NOT NULL,
        keywords TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL
    )""",
]


def _connect() -> None:
    global _pg_pool, _sqlite
    if is_postgres():
        import psycopg2
        import psycopg2.pool

        dsn = DATABASE_URL
        # Supabase требует SSL
        if "sslmode=" not in dsn:
            dsn += ("&" if "?" in dsn else "?") + "sslmode=require"
        logger.info("Подключаюсь к Postgres (Supabase)...")
        _pg_pool = psycopg2.pool.SimpleConnectionPool(1, 5, dsn=dsn)
    else:
        path = DATABASE_URL
        if path.startswith("sqlite:///"):
            path = path[len("sqlite:///"):] or "./local.db"
        logger.info("Подключаюсь к SQLite: %s", path)
        # isolation_level=None -> режим autocommit, потокобезопасность через _lock
        _sqlite = sqlite3.connect(path, check_same_thread=False, isolation_level=None)


_connect()


def _adapt_sql(sql: str) -> str:
    return sql if is_postgres() else sql.replace("%s", "?")


def _adapt_params(params):
    if is_postgres():
        return params
    # SQLite не умеет datetime, передаём ISO-строки
    return tuple(p.isoformat() if isinstance(p, (datetime.datetime, datetime.date)) else p for p in params)


def fetchall(sql: str, params=()):
    with _lock:
        if is_postgres():
            conn = _pg_pool.getconn()
            try:
                conn.autocommit = True
                cur = conn.cursor()
                cur.execute(sql, params)
                rows = cur.fetchall()
                cur.close()
            finally:
                _pg_pool.putconn(conn)
        else:
            cur = _sqlite.execute(_adapt_sql(sql), _adapt_params(params))
            rows = cur.fetchall()
            cur.close()
    return rows


def fetchone(sql: str, params=()):
    rows = fetchall(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params=()) -> None:
    with _lock:
        if is_postgres():
            conn = _pg_pool.getconn()
            try:
                conn.autocommit = True
                cur = conn.cursor()
                cur.execute(sql, params)
                cur.close()
            finally:
                _pg_pool.putconn(conn)
        else:
            cur = _sqlite.execute(_adapt_sql(sql), _adapt_params(params))
            cur.close()


def as_dt(value):
    """Значение из БД -> datetime с таймзоной (Postgres отдаёт datetime, SQLite — строку)."""
    if value is None:
        return None
    if isinstance(value, datetime.datetime):
        return value if value.tzinfo else value.replace(tzinfo=datetime.timezone.utc)
    try:
        return datetime.datetime.fromisoformat(str(value))
    except ValueError:
        return None


# Колонки Instagram: добавляются миграцией к базам, созданным до этой версии
_IG_CHANNEL_COLUMNS = (
    ("platform", "TEXT NOT NULL DEFAULT 'telegram'"),
    ("access_token", "TEXT"),
    ("ig_user_id", "TEXT"),
    ("ig_username", "TEXT"),
    ("token_expires_at", "TIMESTAMPTZ"),
)
_IG_BOT_COLUMNS = (
    ("platform", "TEXT NOT NULL DEFAULT 'telegram'"),
    ("app_id", "TEXT"),
    ("app_secret", "TEXT"),
    ("ig_user_id", "TEXT"),
    ("token_expires_at", "TIMESTAMPTZ"),
)


def _add_missing_columns(table: str, columns) -> None:
    """Дополняет существующую таблицу новыми колонками (SQLite и Postgres)."""
    if is_postgres():
        rows = fetchall(
            "SELECT column_name FROM information_schema.columns WHERE table_name = %s",
            (table,),
        )
        present = {r[0] for r in rows}
    else:
        with _lock:
            present = {r[1] for r in _sqlite.execute(f"PRAGMA table_info({table})").fetchall()}
    for name, col_type in columns:
        if name not in present:
            execute(f"ALTER TABLE {table} ADD COLUMN {name} {col_type}")
            logger.info("Миграция %s: добавлена колонка %s", table, name)


def init_db() -> None:
    """Таблицы создаются автоматически при старте — sql/schema.sql нужен только для ручной инициализации."""
    for ddl in DDL:
        execute(ddl)
    _add_missing_columns("channels", _IG_CHANNEL_COLUMNS)
    _add_missing_columns("bots", _IG_BOT_COLUMNS)
    logger.info("База данных готова")
