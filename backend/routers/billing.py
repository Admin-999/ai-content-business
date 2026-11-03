"""Тарифы и «оплата».

ВНИМАНИЕ: оплата имитируется — это заглушка под Stripe (тестовый режим).
Карта не проверяется, деньги не списываются, PRO активируется сразу.

Как подключить реальный Stripe (когда появятся реквизиты):
  1. pip install stripe; создать Checkout Session на backend:
     stripe.checkout.Session.create(line_items=[...], mode="subscription", success_url=..., cancel_url=...)
  2. Вернуть фронтенду session.url и перенаправить пользователя туда.
  3. Добавить вебхук POST /api/stripe/webhook: по событию checkout.session.completed
     активировать подписку (запись в subscriptions + UPDATE users SET plan='pro').
"""
import datetime
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import database
from config import PRO_DAILY_LIMIT, PRO_PERIOD_DAYS, PRO_PRICE_RUB, PRO_PLUS_DAILY_LIMIT, PRO_PLUS_PRICE_RUB
from deps import get_current_user, new_id, utcnow

router = APIRouter(prefix="/api", tags=["billing"])

PLANS = {
    "pro": {"title": "PRO", "price": PRO_PRICE_RUB, "limit": PRO_DAILY_LIMIT},
    "pro_plus": {"title": "PRO+", "price": PRO_PLUS_PRICE_RUB, "limit": PRO_PLUS_DAILY_LIMIT},
}


class SubscribeIn(BaseModel):
    plan: str = "pro"
    # Поля карты принимаются и игнорируются — тестовый режим
    card_number: str = ""
    card_exp: str = ""
    card_cvc: str = ""


@router.post("/subscribe")
def subscribe(body: SubscribeIn, user: dict = Depends(get_current_user)):
    plan = PLANS.get(body.plan)
    if not plan:
        raise HTTPException(status_code=422, detail="Доступны тарифы 'pro' и 'pro_plus'.")

    now = utcnow()
    expires = now + datetime.timedelta(days=PRO_PERIOD_DAYS)
    payment_ref = f"TEST-{uuid.uuid4().hex[:8].upper()}"  # здесь будет id платежа из Stripe

    database.execute(
        "INSERT INTO subscriptions (id, user_id, plan, status, amount_rub, payment_ref, started_at, expires_at) "
        "VALUES (%s, %s, %s, 'active', %s, %s, %s, %s)",
        (new_id(), user["id"], body.plan, plan["price"], payment_ref, now, expires),
    )
    database.execute(
        "UPDATE users SET plan = %s, plan_expires_at = %s WHERE id = %s",
        (body.plan, expires, user["id"]),
    )
    return {
        "status": "active",
        "plan": body.plan,
        "price_rub": plan["price"],
        "daily_limit": plan["limit"],
        "expires_at": expires.isoformat(),
        "payment_ref": payment_ref,
        "message": f"Тариф {plan['title']} активирован (тестовый режим, деньги не списаны). Лимит: {plan['limit']} генераций в день.",
    }


@router.get("/subscription")
def subscription(user: dict = Depends(get_current_user)):
    row = database.fetchone(
        "SELECT plan, status, amount_rub, payment_ref, started_at, expires_at FROM subscriptions "
        "WHERE user_id = %s ORDER BY started_at DESC LIMIT 1",
        (user["id"],),
    )
    dt_started = database.as_dt(row[4]) if row else None
    dt_expires = database.as_dt(row[5]) if row else None
    return {
        "current_plan": user["plan"],
        "plan_expires_at": user["plan_expires_at"].isoformat() if user["plan_expires_at"] else None,
        "last_payment": None
        if not row
        else {
            "plan": row[0],
            "status": row[1],
            "amount_rub": row[2],
            "payment_ref": row[3],
            "started_at": dt_started.isoformat() if dt_started else None,
            "expires_at": dt_expires.isoformat() if dt_expires else None,
        },
    }
