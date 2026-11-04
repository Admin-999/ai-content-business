"""Деплой backend на Modal (modal.com).

Запуск:
  python -m modal secret create ai-content-secrets SECRET_KEY=... GROQ_API_KEY=... ...
  python -m modal deploy modal_app.py

После деплоя Modal печатает публичный URL вида https://<workspace>--ai-content-api-api.modal.build
Приложение масштабируется до нуля (холодный старт несколько секунд), исходящий
интернет из контейнера разрешён (Groq доступен). max_containers=1 + Volume /data —
чтобы все запросы работали с одним постоянным SQLite-файлом (sqlite:////data/local.db).
"""
import modal

app = modal.App("ai-content-api")

# Постоянный том: SQLite-файл переживает холодные старты контейнера.
volume = modal.Volume.from_name("ai-content-db", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("fonts-dejavu-core")
    .pip_install_from_requirements("requirements.txt")
    .add_local_python_source(
        "main",
        "config",
        "database",
        "security",
        "deps",
        "ai",
        "tgapi",
        "igapi",
        "igcards",
        "emailer",
        "mp",
        "routers",
    )
)


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("ai-content-secrets"), modal.Secret.from_name("telegram-bot")],
    max_containers=1,
    cpu=0.5,
    memory=2048,
    scaledown_window=900,
    volumes={"/data": volume},
)
@modal.asgi_app()
def api():
    from main import app as fastapi_app

    return fastapi_app
