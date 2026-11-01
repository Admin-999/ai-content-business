"""Отправка писем через Resend (free tier: 100 писем/день, 3000/месяц).

Пока не подтверждён собственный домен, Resend позволяет отправлять
только на email владельца аккаунта с адреса onboarding@resend.dev.
"""
import logging

import httpx

from config import EMAIL_FROM, RESEND_API_KEY

logger = logging.getLogger("app.email")


def send_email(to: str, subject: str, html_body: str) -> bool:
    """Возвращает True при успехе. Если ключ не задан — письмо пропускается без падения сервиса."""
    if not RESEND_API_KEY:
        logger.warning("RESEND_API_KEY не задан — письмо на %s не отправлено", to)
        return False
    try:
        resp = httpx.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
            json={"from": EMAIL_FROM, "to": [to], "subject": subject, "html": html_body},
            timeout=30.0,
        )
        if resp.status_code in (200, 201):
            return True
        logger.error("Resend HTTP %s: %s", resp.status_code, resp.text[:300])
        return False
    except httpx.HTTPError as e:
        logger.error("Ошибка при обращении к Resend: %s", e)
        return False
