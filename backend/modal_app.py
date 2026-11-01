"""Деплой backend на Modal (modal.com).

Запуск:
  python -m modal secret create ai-content-secrets SECRET_KEY=... GROQ_API_KEY=... ...
  python -m modal deploy modal_app.py

После деплоя Modal печатает публичный URL вида https://<workspace>--ai-content-api-api.modal.build
Приложение масштабируется до нуля (холодный старт несколько секунд), исходящий
интернет из контейнера разрешён (Groq доступен). max_containers=1 — чтобы все
запросы работали с одним SQLite-файлом контейнера.
"""
import modal

app = modal.App("ai-content-api")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install_from_requirements("requirements.txt")
    .add_local_python_source(
        "main",
        "config",
        "database",
        "security",
        "deps",
        "ai",
        "emailer",
        "routers",
    )
)


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("ai-content-secrets")],
    max_containers=1,
)
@modal.asgi_app()
def api():
    from main import app as fastapi_app

    return fastapi_app
