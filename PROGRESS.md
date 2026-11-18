# AI Контент — состояние проекта и дальнейшие шаги (PROGRESS)

> Этот файл — «точка входа» для продолжения работы в новой сессии.
> Он лежит в корне репозитория и **НЕ публикуется на сайте** (GitHub Pages раздаёт только папку `frontend/`).
> **Секреты здесь не хранятся** — указаны только ИМЕНА переменных и мест, где лежат значения.

Последнее обновление: 18.11.2026

---

## 1. Как проект сохраняется (ничего не пропадёт при выключении ПК)

Проект живёт в трёх независимых местах, и все они — в облаке/на диске, а не «в памяти чата»:

| Что | Где лежит | Что будет, если выключить ПК |
|---|---|---|
| **Код, страницы, документы** | Git-репозиторий + GitHub: `https://github.com/Admin-999/ai-content-business` | Ничего. Всё сохранено в облаке GitHub. |
| **Сайт (статика)** | GitHub Pages: `https://admin-999.github.io/ai-content-business/` (раздаётся из `frontend/`) | Продолжает работать. |
| **Сервер/API + база данных** | Supabase (облако), проект `yapnxwamxmyobnffdhvu` | Продолжает работать. |
| **История чата (сессии OpenCode)** | Локально на этом ПК: `C:\Users\Владимир\.local\share\opencode\opencode.db` | Сохраняется, открывается заново в самом приложении. |

Вывод: **выключение компьютера или закрытие OpenCode ничего не сбрасывает.** Код и сайт — в GitHub, бэкенд — в Supabase.

---

## 2. Что уже сделано

### Сайт и юридические документы (опубликовано)
- Добавлены страницы:
  - `frontend/offer.html` — Публичная оферта (Free 0 ₽ / PRO 299 ₽ / PRO+ 990 ₽ за 30 дней);
  - `frontend/requisites.html` — Реквизиты и контакты;
  - `frontend/refund.html` — Оплата и возврат.
- Обновлены: `frontend/index.html` (футер: ссылки на документы + строка реквизитов; в FAQ упоминание Stripe заменено на Robokassa), `frontend/terms.html`, `frontend/privacy.html` (вписаны реальные реквизиты, убраны заглушки), `frontend/dashboard.html` + `frontend/js/dashboard.js` (убран Stripe из окна оплаты).
- **Контакты на сайте:** e-mail `savolovins@gmail.com`, **телефон убран везде**.
- **Реквизиты продавца:** Володина Вероника Александровна, самозанятый (НПД), ИНН `234504860293`.
- Коммиты: `a486b41`, `58de99c` (в `main`, запушено).

### Админ-панель (работает)
- `https://admin-999.github.io/ai-content-business/admin.html`
- Бэкенд-маршруты `/api/admin/*` в `supabase/functions/api/index.ts`, доступ по `requireAdmin` / `ADMIN_EMAIL` (= `vsvolodin2014@gmail.com`), Edge Function версия 10 (ACTIVE).
- В базе 3 реальных пользователя: `vsvolodin2014@gmail.com`, `czk.vivia@gmail.com`, `owner@ai-content.local`.

### Robokassa (идёт проверка)
- Кабинет: `ai.kontent.ru`, имя «Самозанятый Володина В. А.».
- Магазин создан: id `fda1cb4d-b4e6-489f-91e5-a0aeee077bdc`, идентификатор `ai-content`, тип бизнеса «Оказание услуг» (`catalogItem=3`).
- Способ вывода средств: счёт «Владимир и вероника — 40817810***1840».
- **Статус: «Подана заявка на активацию»** (подана 18.11.2026). Срок рассмотрения 1–3 рабочих дня; ответ придёт на e-mail и в SMS.

---

## 3. Блокер

Пока магазин на модерации Robokassa:
- доступны только **технические настройки**;
- **не получены** `Result URL`, `Success URL`, `Fail URL` и **Пароли №1/№2** — без них нельзя реализовать реальную оплату.

Как только придёт одобрение — переходим к разделу 4.

---

## 4. Следующие шаги

### Шаг A. После одобрения Robokassa
1. Открыть в кабинете Robokassa → магазин → **Технические настройки**.
2. Записать/задать:
   - **Result URL** (вебхук, серверный): `https://yapnxwamxmyobnffdhvu.supabase.co/functions/v1/api/robokassa/result`
   - **Success URL** (возврат после успешной оплаты): страница `dashboard.html` сайта;
   - **Fail URL** (возврат при отказе): страница `dashboard.html` сайта;
   - **Пароль №1** и **Пароль №2** (сгенерировать/задать).
3. Сохранить пароли в секреты Supabase (имена ниже), значения — НЕ в git.

### Шаг B. Код оплаты (в `supabase/functions/api/index.ts`)
1. `POST /api/pay` — создание платежа: формирование ссылки Robokassa, подпись `SignatureValue` (MD5 от `MerchantLogin:OutSum:InvId:Пароль №1`).
2. `POST /api/robokassa/result` — вебхук: проверка подписи (`Пароль №2`), активация тарифа PRO/PRO+, запись в БД.
3. На фронте (`frontend/js/dashboard.js`, окно `payModal`) заменить заглушку `/api/subscribe` на редирект на ссылку оплаты.
4. Деплой Edge Function через Management API:
   `POST https://api.supabase.com/v1/projects/{ref}/functions/deploy?slug=api`
5. Обновить тексты на сайте: убрать «тестовый режим» из FAQ/index, из `dashboard.html` (окно оплаты).

### Шаг C. Проверка
- Провести тестовый платёж, убедиться, что тариф активируется автоматически и приходит чек («Мой налог»).
- Удалить тестовую заглушку оплаты.

### Возможный запрос от Robokassa
- Догрузить в «Анкету» сканы: паспорт (данные + прописка) и справка о постановке на учёт (КНД 1122035).
- При сверке контактов: на сайте `savolovins@gmail.com` (без телефона), в анкете — `volodina_veronik@mail.ru` и телефон. При необходимости привести к одному.

---

## 5. Доступы и ключи (только ИМЕНА, значения не хранятся в репозитории)

- **GitHub:** репозиторий `Admin-999/ai-content-business`, ветка `main`, Pages раздаёт `frontend/`.
- **Supabase:** проект ref `yapnxwamxmyobnffdhvu`; API base `https://yapnxwamxmyobnffdhvu.supabase.co/functions/v1/api`.
  - Секреты Edge Function (имена): `SUPABASE_*`, `SECRET_KEY`, `TELEGRAM_BOT_TOKEN`, `CRON_SECRET`, `OPENAI_COMPAT_*`, `VISION_*`.
  - **Нужно добавить (после активации Robokassa):** `ROBOKASSA_LOGIN`, `ROBOKASSA_PASSWORD1`, `ROBOKASSA_PASSWORD2` (имена предлагаемые).
- **Supabase Management API token** (для деплоя функций): хранится отдельно, имя `opencode-admin-temp`. **В git не коммитить.** Отозвать можно на https://supabase.com/dashboard/account/tokens.
- **Robokassa:** кабинет `ai.kontent.ru`, магазин id `fda1cb4d-b4e6-489f-91e5-a0aeee077bdc`.

---

## 6. Как возобновить работу

### Продолжить этот же чат
- Откройте приложение OpenCode и в списке сессий выберите нужную — история сохранена локально (`opencode.db`).
- Если работаете из терминала: `opencode --continue` (продолжить последнюю сессию) или `opencode --session <id>`.

### Начать с чистого листа (в другом чате)
- Скажите в новом чате: «Продолжаем проект AI Контент, см. `PROGRESS.md` в `C:\Users\Владимир\Desktop\ai-content-business`».
- Этого достаточно: все ключевые данные, статус Robokassa и следующие шаги — в этом файле.

### Локальная папка проекта
```
C:\Users\Владимир\Desktop\ai-content-business
```
Проверить, что всё запушено:
```
git -C "C:\Users\Владимир\Desktop\ai-content-business" status
git -C "C:\Users\Владимир\Desktop\ai-content-business" push origin main
```

---

## 7. Сводка статусов

| Блок | Статус |
|---|---|
| Сайт + юридические страницы | ✅ Готово и опубликовано |
| Админ-панель | ✅ Работает |
| Контакты (e-mail, без телефона) | ✅ Обновлено |
| Магазин Robokassa | 🕓 На модерации («Подана заявка на активацию») |
| Реальная оплата + вебхук | ⛔ Заблокировано до одобрения Robokassa |
