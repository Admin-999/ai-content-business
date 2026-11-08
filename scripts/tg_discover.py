"""Находит чаты и каналы, где присутствует бот (через getUpdates).

Зачем: при первичной настройке клиент добавляет бота администратором в канал.
Telegram присылает боту служебное обновление my_chat_member с данными канала,
поэтому адрес канала можно определить автоматически, без ручного ввода @username.

Запуск:  TELEGRAM_BOT_TOKEN=... python scripts/tg_discover.py
"""
import json
import os
import sys
import urllib.request

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
if not TOKEN:
    sys.exit("Не задан TELEGRAM_BOT_TOKEN")

KINDS = ("message", "channel_post", "edited_message", "my_chat_member", "chat_member")

with urllib.request.urlopen(
    f"https://api.telegram.org/bot{TOKEN}/getUpdates?limit=100", timeout=30
) as resp:
    data = json.load(resp)

if not data.get("ok"):
    sys.exit(f"Telegram ответил ошибкой: {data.get('description')}")

updates = data.get("result") or []
chats = {}
for upd in updates:
    kinds = [k for k in KINDS if upd.get(k)]
    print(f"update {upd.get('update_id')}: {', '.join(kinds) or 'прочее'}")
    for key in KINDS:
        chat = (upd.get(key) or {}).get("chat")
        if chat:
            chats[chat["id"]] = chat

print(f"\nВсего обновлений: {len(updates)}")
if not chats:
    print("Чатов не найдено: бота пока не добавляли либо прошло больше 24 часов.")
else:
    print("\nНайденные чаты/каналы:")
    for cid, chat in chats.items():
        print(
            f"  id={cid}  type={chat.get('type')}  "
            f"title={chat.get('title')!r}  username=@{chat.get('username')}"
        )