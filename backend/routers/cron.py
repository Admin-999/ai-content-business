"""Cron-задачи. Вызываются GitHub Actions раз в день
(см. .github/workflows/daily-report.yml, секреты BACKEND_URL и CRON_SECRET).

Что делает daily-report:
  1. Переводит истёкшие подписки PRO обратно на Free.
  2. Собирает статистику генераций за вчерашний день по каждому пользователю.
  3. Отправляет email-отчёты через Resend (с ограничением, чтобы не выйти
     за free-лимит 100 писем/день).
"""
import datetime
import html as html_lib

from fastapi import APIRouter, Header, HTTPException

import database
from config import (
    CRON_SECRET,
    EMAIL_REPORT_MAX,
    FREE_DAILY_LIMIT,
    FRONTEND_URL,
    PRO_DAILY_LIMIT,
    PRO_PLUS_DAILY_LIMIT,
    RESEND_API_KEY,
)
from emailer import send_email

router = APIRouter(prefix="/api/cron", tags=["cron"])


def _check_secret(x_cron_secret: str) -> None:
    if not CRON_SECRET or x_cron_secret != CRON_SECRET:
        raise HTTPException(status_code=403, detail="Недействительный секрет cron-задачи.")


@router.post("/groq-models")
def groq_models(x_cron_secret: str = Header(default="")):
    """ВРЕМЕННЫЙ отладочный эндпоинт: список моделей Groq (для выбора vision-модели)."""
    import httpx

    from config import GROQ_API_KEY

    _check_secret(x_cron_secret)
    resp = httpx.get(
        "https://api.groq.com/openai/v1/models",
        headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
        timeout=30.0,
    )
    return {"status": resp.status_code, "body": resp.text[:8000]}


@router.post("/daily-report")
def daily_report(x_cron_secret: str = Header(default="")):
    _check_secret(x_cron_secret)

    now = datetime.datetime.now(datetime.timezone.utc)
    day_start = (now - datetime.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + datetime.timedelta(days=1)

    # 1. Истёкшие подписки
    database.execute(
        "UPDATE subscriptions SET status = 'expired' "
        "WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < %s",
        (now,),
    )
    expired_users = database.fetchall(
        "SELECT id FROM users WHERE plan IN ('pro', 'pro_plus') AND plan_expires_at IS NOT NULL AND plan_expires_at < %s",
        (now,),
    )
    database.execute(
        "UPDATE users SET plan = 'free', plan_expires_at = NULL "
        "WHERE plan IN ('pro', 'pro_plus') AND plan_expires_at IS NOT NULL AND plan_expires_at < %s",
        (now,),
    )

    # 2. Активность за вчера
    rows = database.fetchall(
        "SELECT u.email, u.plan, COUNT(g.id) FROM users u "
        "JOIN generations g ON g.user_id = u.id "
        "WHERE g.created_at >= %s AND g.created_at < %s "
        "GROUP BY u.email, u.plan ORDER BY COUNT(g.id) DESC",
        (day_start, day_end),
    )

    # 3. Email-отчёты
    dashboard_link = (FRONTEND_URL + "/dashboard.html") if FRONTEND_URL else "#"
    sent = 0
    for email, plan, count in rows:
        if sent >= EMAIL_REPORT_MAX:
            break
        limit = PRO_PLUS_DAILY_LIMIT if plan == "pro_plus" else PRO_DAILY_LIMIT if plan == "pro" else FREE_DAILY_LIMIT
        plan_title = "PRO+" if plan == "pro_plus" else "PRO" if plan == "pro" else "Free"
        body = (
            "<html><body style='font-family:Arial,sans-serif;color:#1e293b'>"
            f"<h2>Отчёт за {day_start.strftime('%d.%m.%Y')}</h2>"
            f"<p>Вчера вы создали <b>{count}</b> материал(ов) через AI Контент.</p>"
            f"<p>Ваш тариф: <b>{plan_title}</b> (лимит {limit} генераций в день).</p>"
            f"<p><a href='{html_lib.escape(dashboard_link)}'>Открыть личный кабинет</a></p>"
            "<p style='color:#94a3b8;font-size:12px'>Вы получили это письмо, потому что зарегистрированы в AI Контент.</p>"
            "</body></html>"
        )
        if send_email(email, "Ваш ежедневный отчёт — AI Контент", body):
            sent += 1

    return {
        "status": "ok",
        "date": day_start.strftime("%Y-%m-%d"),
        "users_with_activity": len(rows),
        "emails_sent": sent,
        "emails_not_sent": max(len(rows) - sent, 0),
        "plans_expired": len(expired_users),
        "resend_configured": bool(RESEND_API_KEY),
    }
