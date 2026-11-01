"""Счётчик генераций и история пользователя (личный кабинет)."""
from fastapi import APIRouter, Depends, Query

import database
from deps import daily_limit, get_current_user, used_today

router = APIRouter(prefix="/api", tags=["usage"])


@router.get("/usage")
def usage(user: dict = Depends(get_current_user)):
    used = used_today(user["id"])
    limit = daily_limit(user["plan"])
    total = database.fetchone("SELECT COUNT(*) FROM generations WHERE user_id = %s", (user["id"],))
    return {
        "plan": user["plan"],
        "plan_expires_at": user["plan_expires_at"].isoformat() if user["plan_expires_at"] else None,
        "used_today": used,
        "limit": limit,
        "remaining": max(limit - used, 0),
        "total_generated": int(total[0]) if total else 0,
    }


@router.get("/history")
def history(limit: int = Query(default=20, ge=1, le=50), user: dict = Depends(get_current_user)):
    rows = database.fetchall(
        "SELECT id, topic, content_type, result, model, created_at FROM generations "
        "WHERE user_id = %s ORDER BY created_at DESC LIMIT %s",
        (user["id"], limit),
    )
    items = []
    for r in rows:
        dt = database.as_dt(r[5])
        items.append(
            {
                "id": r[0],
                "topic": r[1],
                "content_type": r[2],
                "result": r[3],
                "model": r[4],
                "created_at": dt.isoformat() if dt else None,
            }
        )
    return {"items": items}
