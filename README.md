# AI Контент — автоматизированный ИИ-бизнес (MVP)

Сервис генерации контента для малого бизнеса по подписке: клиент регистрируется, вводит тему —
и получает готовый пост, статью или описание товара. Всё автоматически, без участия человека.

**Весь стек бесплатный.**

| Компонент | Технология | Бесплатный лимит |
|---|---|---|
| Frontend | HTML/JS + Tailwind CDN на **Vercel** | Hobby-план бесплатен |
| Backend | Python FastAPI на **Render** | 750 часов/мес, free-инстанс «засыпает» |
| База данных | **Supabase** Postgres | 500 МБ, пауза после недели неактивности |
| ИИ-генерация | **Google Gemini** (+ резерв **Groq**) | есть free tier у обоих |
| Авторизация | Собственная: bcrypt + JWT | бесплатно, работает из коробки |
| Email | **Resend** | 100 писем/день, 3000/мес |
| Cron | **GitHub Actions** | бесплатно (public — безлимит) |
| Платежи | Заглушка, готова к подключению **Stripe** | — |

> Примечание об авторизации: вместо Supabase Auth используется собственный JWT (пароли — bcrypt-хеши).
> Это осознанное упрощение MVP: не требуется подтверждение email и настройка редиректов,
> сервис работает сразу. Переход на Supabase Auth можно выполнить позже без изменения фронтенда.

---

## Файловая структура

```
ai-content-business/
├── README.md                        <- этот файл
├── .env.example                     <- шаблон переменных окружения
├── .gitignore
├── render.yaml                      <- автодеплой backend на Render (Blueprint)
├── .github/
│   └── workflows/
│       └── daily-report.yml         <- cron: ежедневные email-отчёты
├── backend/
│   ├── main.py                      <- FastAPI: CORS, rate limiting, health check
│   ├── config.py                    <- все настройки из переменных окружения
│   ├── database.py                  <- Supabase Postgres / SQLite (авто-выбор)
│   ├── security.py                  <- bcrypt-пароли + JWT
│   ├── deps.py                      <- авторизация, тарифы, счётчики
│   ├── ai.py                        <- Gemini (основной) -> Groq (резерв)
│   ├── emailer.py                   <- Resend
│   ├── requirements.txt
│   ├── sql/schema.sql               <- схема БД (обычно не нужна: создаётся сама)
│   └── routers/
│       ├── auth.py                  <- /api/auth/register, /api/auth/login, /api/auth/me
│       ├── generate.py              <- /api/generate (проверка дневного лимита)
│       ├── usage.py                 <- /api/usage, /api/history
│       ├── billing.py               <- /api/subscribe (заглушка Stripe), /api/subscription
│       └── cron.py                  <- /api/cron/daily-report (защищён секретом)
└── frontend/
    ├── index.html                   <- лендинг: тарифы, FAQ, вход/регистрация
    ├── dashboard.html               <- личный кабинет: генератор, лимиты, история, PRO
    ├── terms.html                   <- Условия использования (шаблон)
    ├── privacy.html                 <- Политика конфиденциальности (шаблон)
    ├── vercel.json
    ├── css/style.css
    └── js/
        ├── config.js                <- ЗАМЕНИТЕ API_URL после деплоя backend
        ├── api.js                   <- fetch-обёртка, тосты, копирование
        ├── auth.js                  <- вход/регистрация
        └── dashboard.js             <- генерация, лимиты, история, оплата
```

---

## Шаг 0. Локальный запуск (10 минут, для проверки)

1. Установите Python 3.10+.
2. В папке `backend`:
   ```
   python -m venv venv
   venv\Scripts\activate            # Windows (Linux/Mac: source venv/bin/activate)
   pip install -r requirements.txt
   copy ..\.env.example .env        # Linux/Mac: cp ..\.env.example .env
   ```
3. Получите ключ Gemini (бесплатно, см. Шаг 3) и впишите его в `backend/.env`.
4. Запустите backend (из папки `backend`): `uvicorn main:app --reload` — база SQLite создастся сама.
5. В втором терминале запустите frontend (из папки `frontend`): `python -m http.server 5500`
6. Откройте http://localhost:5500 — зарегистрируйтесь и сгенерируйте первый текст.

---

## Деплой в интернет (всё бесплатно)

### Шаг 1. GitHub

Создайте репозиторий на https://github.com и загрузите проект:
```
git init
git add .
git commit -m "AI Content MVP"
git branch -M main
git remote add origin https://github.com/<ваш-логин>/ai-content-business.git
git push -u origin main
```

### Шаг 2. Supabase (база данных)

1. https://supabase.com -> Sign up (бесплатно) -> **New project**.
2. Придумайте пароль базы данных (сохраните его) и регион `eu-central-1`.
3. Дождитесь инициализации проекта.
4. **Project Settings -> Database -> Connection string -> URI**, вкладка **Transaction pooler** (порт **6543**).
5. Скопируйте строку вида:
   `postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`
   и замените `[YOUR-PASSWORD]` на свой пароль. Это и есть `DATABASE_URL`.
6. Таблицы создавать не нужно — backend создаст их при первом старте.
   (При желании можно выполнить `backend/sql/schema.sql` в SQL Editor вручную.)

> Supabase free-проект «засыпает» после ~7 дней неактивности. Открывайте панель проекта раз в неделю
> или зайдите на сайт сервиса — БД оживёт.

### Шаг 3. Google Gemini (ИИ-генерация)

1. Откройте https://aistudio.google.com/apikey и войдите через Google-аккаунт.
2. **Create API key** -> скопируйте ключ (начинается с `AIza...`).
3. Free tier имеет лимиты запросов в минуту/день — для MVP их достаточно.
   При упоре в лимиты добавьте резервный ключ Groq (Шаг 3.1).

3.1. (Необязательно) Резервный провайдер Groq:
1. https://console.groq.com -> Sign up -> **API Keys** -> Create API Key.
2. Модель по умолчанию — `llama-3.3-70b-versatile` (меняется через `GROQ_MODEL`).

### Шаг 4. Render (backend)

1. https://render.com -> Sign up через GitHub.
2. **New + -> Blueprint** -> выберите репозиторий `ai-content-business` -> **Apply**.
   Render прочитает `render.yaml` и создаст сервис.
3. На странице сервиса откройте **Environment** и заполните переменные:
   | Переменная | Значение |
   |---|---|
   | `DATABASE_URL` | строка из Шага 2 |
   | `GEMINI_API_KEY` | ключ из Шага 3 |
   | `GROQ_API_KEY` | ключ из Шага 3.1 (необязательно) |
   | `FRONTEND_ORIGIN` | `https://<ваш-проект>.vercel.app` (впишете после Шага 5) |
   | `FRONTEND_URL` | тот же адрес Vercel |
   | `RESEND_API_KEY` | ключ из Шага 6 (можно позже) |

   `SECRET_KEY` и `CRON_SECRET` сгенерированы автоматически — скопируйте `CRON_SECRET` (пригодится в Шаге 7).
4. Сохраните — Render пересоберёт сервис. Проверьте: откройте
   `https://<имя-сервиса>.onrender.com/api/health` -> должно вернуть `{"status":"ok"}`.

> Free-инстанс засыпает после 15 минут неактивности: первый запрос будет грузиться ~50 секунд.
> Это нормально для free tier. (Решение — «пингалка» UptimeRobot, см. «Что улучшить».)

### Шаг 5. Vercel (frontend)

1. **До деплоя**: откройте `frontend/js/config.js` и укажите адрес backend из Шага 4:
   ```js
   window.APP_CONFIG = { API_URL: "https://ai-content-api.onrender.com" };
   ```
   Закоммитьте и запушьте.
2. https://vercel.com -> Sign up через GitHub -> **Add New -> Project** -> импортируйте репозиторий.
3. **Root Directory**: `frontend`. Остальное по умолчанию -> **Deploy**.
4. Скопируйте выданный адрес `https://<проект>.vercel.app`.
5. Вернитесь в Render -> Environment: впишите этот адрес в `FRONTEND_ORIGIN` и `FRONTEND_URL`
   -> Save (сервис пересоберётся). Без этого браузер заблокирует запросы из-за CORS.

### Шаг 6. Resend (email-отчёты)

1. https://resend.com -> Sign up -> **API Keys** -> Create API Key.
2. Добавьте ключ как `RESEND_API_KEY` в Render -> Environment -> Save.
3. Важно для free tier: с адреса `onboarding@resend.dev` письма уходят **только на email владельца
   аккаунта Resend**. Чтобы слать всем клиентам, добавьте и подтвердите свой домен
   (**Domains -> Add domain**, DNS-записи) и поменяйте `EMAIL_FROM` на `AI Контент <noreply@ваш-домен.ru>`.

### Шаг 7. GitHub Actions (cron, ежедневные отчёты)

1. В репозитории: **Settings -> Secrets and variables -> Actions -> New repository secret**:
   - `BACKEND_URL` = `https://ai-content-api.onrender.com`
   - `CRON_SECRET` = значение из Render (Шаг 4.3)
2. Вкладка **Actions** — workflow «Ежедневный отчёт (cron)» включён автоматически;
   расписание — каждый день в 08:00 UTC (11:00 МСК). Запустить вручную можно кнопкой
   **Run workflow** — в логах будет JSON-отчёт о выполнении.

### Шаг 8. Юридические страницы

Замените плейсхолдеры `[...]` в `frontend/terms.html` и `frontend/privacy.html`
(название компании, реквизиты, email поддержки, дата) и покажите документы юристу.

---

## Как работает тарификация

| Тариф | Цена | Лимит | Особенности |
|---|---|---|---|
| Free | 0 ₽ | 5 генераций/день | лимит обнуляется в 00:00 UTC |
| PRO | 990 ₽/30 дней | 100 генераций/день | оплата пока тестовая |

- «Списание» лимита автоматическое: каждая генерация пишется в БД, дневной счётчик считается по ней.
- Истёкший PRO понижается до Free: лениво при каждом запросе + раз в день через cron.

## Подключение реальных платежей (Stripe) — краткий план

1. Аккаунт Stripe, ключи в переменные окружения Render (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`).
2. `pip install stripe`; в `routers/billing.py` заменить заглушку на создание Checkout Session.
3. Добавить вебхук `POST /api/stripe/webhook`: по событию `checkout.session.completed` активировать подписку.
4. На фронте заменить модалку оплаты на редирект на `session.url`.
Подробные точки внедрения помечены комментариями в `routers/billing.py`.

## Известные ограничения free tier

| Ограничение | Следствие | Решение |
|---|---|---|
| Render free засыпает | первый запрос ~50 сек | UptimeRobot ping / платный план |
| Supabase пауза после 7 дней тишины | БД не отвечает | открывать панель раз в неделю |
| Лимиты Gemini (rpm/rpd) | редкие 502 при пиках | добавить GROQ_API_KEY как резерв |
| Resend: 100 писем/день, письма только владельцу | отчёты не всем | подтвердить домен в Resend |
| Rate limit 60 req/min на IP (in-memory) | сбрасывается при рестарте | для MVP достаточно; далее Redis |

## Troubleshooting

| Симптом | Причина и решение |
|---|---|
| «Нет связи с сервером» | backend спит (первый запрос ~50 сек) или не задан `API_URL` в `js/config.js` |
| Ошибка CORS в консоли браузера | `FRONTEND_ORIGIN` в Render не совпадает с адресом Vercel |
| 502 «Сервис генерации недоступен» | не задан `GEMINI_API_KEY`, исчерпаны лимиты или ключ неверный |
| Письма не приходят | не задан `RESEND_API_KEY`, либо получатель не владелец аккаунта Resend (нужен свой домен) |
| `relation "users" does not exist` | backend не запускался ни разу (автосоздание таблиц) — проверьте логи Render |
| 429 Too Many Requests | сработал rate limit (60 req/min) или дневной лимит генераций |

## Что улучшить дальше

- Подключить Stripe (см. выше) и убрать тестовый режим оплаты.
- Подтвердить домен в Resend и добавить письмо-подтверждение регистрации.
- «Прогрев» Render через UptimeRobot (бесплатный ping каждые 5 минут).
- Админ-панель: статистика регистраций и выручки (эндпоинт под секретом).
- Реферальная программа и промокоды.
