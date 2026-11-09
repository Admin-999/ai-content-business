// Логика личного кабинета: генерация, лимиты, история, апгрейд.

const TYPE_NAMES = { post: "Пост", article: "Статья", product: "Описание товара" };

const $ = (id) => document.getElementById(id);

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return iso || "";
  }
}

function requireAuth() {
  if (!localStorage.getItem("ac_token")) {
    location.href = "index.html";
    return false;
  }
  return true;
}

function renderUsage(u) {
  const badge = $("planBadge");
  badge.textContent = u.plan === "pro_plus" ? "PRO+" : u.plan === "pro" ? "PRO" : "FREE";
  badge.className =
    u.plan === "pro_plus"
      ? "rounded-full bg-violet-500/20 px-2.5 py-0.5 text-xs font-semibold text-violet-300"
      : u.plan === "pro"
        ? "rounded-full bg-indigo-500/20 px-2.5 py-0.5 text-xs font-semibold text-indigo-300"
        : "rounded-full bg-slate-700 px-2.5 py-0.5 text-xs font-semibold text-slate-300";

  $("planName").textContent = u.plan === "pro_plus" ? "Тариф PRO+" : u.plan === "pro" ? "Тариф PRO" : "Бесплатный тариф";

  const pct = u.limit ? Math.min(100, Math.round((u.used_today / u.limit) * 100)) : 0;
  const bar = $("usageBar");
  bar.style.width = pct + "%";
  bar.className = "h-2 rounded-full transition-all " + (pct >= 100 ? "bg-rose-500" : "bg-indigo-500");

  $("usageText").textContent = `Сегодня: ${u.used_today} из ${u.limit} генераций (осталось ${u.remaining})`;
  $("usageTotal").textContent = `Всего создано материалов: ${u.total_generated}`;

  $("upgradeCard").classList.toggle("hidden", u.plan !== "free");
}

async function loadUsage() {
  try {
    const u = await api("/api/usage");
    renderUsage(u);
    try { localStorage.setItem("ac_usage", JSON.stringify(u)); } catch (e) {}
  } catch (err) {
    const cached = localStorage.getItem("ac_usage");
    if (!cached) {
      if (document.body.dataset.page === "dashboard" && !localStorage.getItem("ac_token")) return;
      toast(err.message, "error");
      return;
    }
    try { renderUsage(JSON.parse(cached)); } catch (e) {}
  }
}

function showResultImage(url) {
  const img = $("resultImage");
  const link = $("resultImageLink");
  if (!img || !link) return;
  if (url) {
    img.src = url;
    img.classList.remove("hidden");
    link.href = url;
    link.classList.remove("hidden");
  } else {
    img.removeAttribute("src");
    img.classList.add("hidden");
    link.classList.add("hidden");
  }
}

function renderHistory(items) {
  const list = $("historyList");
  list.innerHTML = "";
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "text-sm text-slate-400";
    p.textContent = "Пока нет материалов. Сгенерируйте первый слева.";
    list.appendChild(p);
    return;
  }
  for (const it of items) {
    const d = document.createElement("details");
    d.className = "rounded-lg border border-white/10 bg-slate-950/60 p-3";

    const s = document.createElement("summary");
    s.className = "text-sm font-medium";
    s.textContent = `${TYPE_NAMES[it.content_type] || it.content_type} — ${it.topic}`;

    const meta = document.createElement("p");
    meta.className = "mt-1 text-xs text-slate-500";
    meta.textContent = fmtDate(it.created_at) + (it.model ? " · " + it.model : "");

    const pre = document.createElement("pre");
    pre.className = "mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-300";
    pre.textContent = it.result;

    d.append(s, meta, pre);
    if (it.image_url) {
      const img = document.createElement("img");
      img.className = "mt-3 w-full max-w-xs rounded-lg border border-white/10";
      img.loading = "lazy";
      img.alt = "Изображение к материалу";
      img.src = it.image_url;
      d.appendChild(img);
    }
    list.appendChild(d);
  }
}

async function loadHistory() {
  try {
    const data = await api("/api/history?limit=20");
    renderHistory(data.items);
    try { localStorage.setItem("ac_history", JSON.stringify(data)); } catch (e) {}
  } catch (err) {
    const cached = localStorage.getItem("ac_history");
    if (!cached) {
      toast(err.message, "error");
      return;
    }
    try { renderHistory(JSON.parse(cached).items || []); } catch (e) {}
  }
}

// --- Генерация без сервера ------------------------------------------------
// Если backend недоступен, текст создаётся прямо в браузере через свободный
// OpenAI-совместимый эндпоинт (ключ не нужен). Так генерация работает, даже
// когда API-сервер выключен. Лимиты тарифа в этом режиме не считаются,
// а результат сохраняется в истории браузера.
const FREE_LLM_URL = "https://text.pollinations.ai/openai/chat/completions";
const FREE_LLM_MODEL = "openai";

const GEN_TASKS = {
  post: "Напиши вовлекающий пост для социальных сетей на тему: «{topic}». Объём 150–250 слов. Первый абзац должен цеплять внимание. В конце добавь призыв к действию и 3–5 хештегов.",
  article: "Напиши статью для корпоративного блога на тему: «{topic}». Объём 500–800 слов. Структура: цепляющий заголовок, вступление, 3–4 смысловых блока с подзаголовками, практические советы, короткий вывод.",
  product: "Напиши продающее описание товара для интернет-магазина: «{topic}». Объём 150–300 слов. Структура: цепляющий заголовок, 3–5 ключевых выгод списком, краткое описание, призыв к действию.",
};

function buildPrompt(topic, contentType, tone, language) {
  const task = (GEN_TASKS[contentType] || GEN_TASKS.post).replace("{topic}", topic);
  const toneLine = tone ? "Тон текста: " + tone + "." : "";
  const langLine = language === "ru" ? "русском" : language === "en" ? "английском" : language;
  return (
    "Ты — профессиональный коммерческий копирайтер с опытом 10 лет.\n" +
    "Задача: " + task + "\n" +
    toneLine + "\n" +
    "Напиши текст на " + langLine + " языке.\n" +
    "В ответе выведи только готовый текст, без пояснений и служебных пометок.\n" +
    "Не используй Markdown-разметку (звёздочки, решётки, подчёркивания) — только чистый текст."
  );
}

async function generateOffline(topic, contentType, tone, language) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  let resp;
  try {
    resp = await fetch(FREE_LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: FREE_LLM_MODEL,
        messages: [{ role: "user", content: buildPrompt(topic, contentType, tone, language) }],
        max_tokens: 2048,
        temperature: 0.8,
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error("Не удалось связаться с ИИ. Проверьте интернет и нажмите кнопку ещё раз.");
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    throw new Error("Не удалось сгенерировать текст (ошибка " + resp.status + "). Попробуйте ещё раз.");
  }
  let data = null;
  try { data = await resp.json(); } catch (e) { data = null; }
  const text = (((data || {}).choices || [{}])[0].message || {}).content || "";
  if (!text.trim()) throw new Error("ИИ вернул пустой ответ. Попробуйте ещё раз.");
  return { content: text.trim(), model: "browser:" + FREE_LLM_MODEL };
}

function saveLocalGeneration(topic, contentType, model, content) {
  try {
    const cached = JSON.parse(localStorage.getItem("ac_history") || "{}");
    const items = cached.items || [];
    items.unshift({
      id: "local-" + Date.now(),
      topic: topic,
      content_type: contentType,
      result: content,
      model: model,
      created_at: new Date().toISOString(),
    });
    const trimmed = items.slice(0, 20);
    localStorage.setItem("ac_history", JSON.stringify({ items: trimmed }));
    renderHistory(trimmed);
  } catch (e) {}
}

async function generate(e) {
  e.preventDefault();
  const topic = $("topic").value.trim();
  if (topic.length < 3) {
    toast("Опишите тему подробнее: минимум 3 символа.", "error");
    return;
  }
  const contentType = $("contentType").value;
  const tone = $("tone").value;
  const language = $("language").value;

  const btn = $("genBtn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Генерируем… до минуты';

  try {
    let content, model, imageUrl = null, remaining = null, offline = false;
    try {
      const data = await api("/api/generate", {
        method: "POST",
        body: { topic, content_type: contentType, tone, language },
      });
      content = data.content;
      model = data.model;
      imageUrl = data.image_url || null;
      remaining = data.remaining;
    } catch (err) {
      // Сервер недоступен — генерируем прямо в браузере.
      if (err.code !== "offline" && err.code !== "timeout") throw err;
      const local = await generateOffline(topic, contentType, tone, language);
      content = local.content;
      model = local.model;
      offline = true;
    }

    $("resultCard").classList.remove("hidden");
    $("resultText").textContent = content;
    showResultImage(imageUrl);
    $("resultCard").scrollIntoView({ behavior: "smooth", block: "nearest" });

    if (offline) {
      saveLocalGeneration(topic, contentType, model, content);
      toast("Готово! Сервер недоступен — текст создан прямо в браузере.", "success");
    } else {
      toast("Готово! Осталось генераций сегодня: " + remaining, "success");
      loadUsage();
      loadHistory();
    }
  } catch (err) {
    toast((err && err.message) || "Не удалось сгенерировать текст.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// --- Модалка оплаты (заглушка под Stripe) ---
const PAY_PLANS = {
  pro: { title: "Оформление PRO", subtitle: "299 ₽ / 30 дней · 100 генераций в день", button: "Оплатить 299 ₽" },
  pro_plus: { title: "Оформление PRO+", subtitle: "990 ₽ / 30 дней · 300 генераций в день", button: "Оплатить 990 ₽" },
};

let payPlan = "pro";

function openPay(plan) {
  payPlan = PAY_PLANS[plan] ? plan : "pro";
  $("payTitle").textContent = PAY_PLANS[payPlan].title;
  $("paySubtitle").textContent = PAY_PLANS[payPlan].subtitle;
  $("payBtn").textContent = PAY_PLANS[payPlan].button;
  $("payModal").classList.remove("hidden");
  $("payModal").classList.add("flex");
}
function closePay() {
  $("payModal").classList.add("hidden");
  $("payModal").classList.remove("flex");
}

async function pay(e) {
  e.preventDefault();
  const errEl = $("payError");
  errEl.classList.add("hidden");

  const num = $("cardNumber").value.replace(/\s+/g, "");
  const exp = $("cardExp").value.trim();
  const cvc = $("cardCvc").value.trim();
  if (!/^\d{12,19}$/.test(num)) return showPayError("Введите номер карты (12–19 цифр). Это тест: подойдут любые цифры.");
  if (!/^\d{2}\/\d{2}$/.test(exp)) return showPayError("Срок карты в формате ММ/ГГ, например 12/29.");
  if (!/^\d{3,4}$/.test(cvc)) return showPayError("CVC — 3 цифры на обороте карты.");

  const btn = $("payBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Обработка платежа…';
  try {
    const data = await api("/api/subscribe", {
      method: "POST",
      body: { plan: payPlan, card_number: num, card_exp: exp, card_cvc: cvc },
    });
    closePay();
    toast(data.message, "success");
    loadUsage();
  } catch (err) {
    showPayError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = PAY_PLANS[payPlan].button;
  }
}

function showPayError(msg) {
  $("payError").textContent = msg;
  $("payError").classList.remove("hidden");
}

// --- Профиль: имя и аватар ---
let currentAvatar = null;
let pendingAvatar; // undefined — не трогали, null — удалить, строка — новый data URL

function renderHeaderProfile(name, avatar) {
  $("profileName").textContent = name || "";
  $("profileName").classList.toggle("hidden", !name);
  if (avatar) {
    $("avatarImg").src = avatar;
    $("avatarImg").classList.remove("hidden");
    $("avatarFallback").classList.add("hidden");
  } else {
    $("avatarImg").removeAttribute("src");
    $("avatarImg").classList.add("hidden");
    $("avatarFallback").classList.remove("hidden");
  }
}

function applyProfilePreview() {
  const shown = pendingAvatar === undefined ? currentAvatar : pendingAvatar;
  if (shown) {
    $("pfAvatarPreview").src = shown;
    $("pfAvatarPreview").classList.remove("hidden");
    $("pfAvatarFallback").classList.add("hidden");
  } else {
    $("pfAvatarPreview").classList.add("hidden");
    $("pfAvatarFallback").classList.remove("hidden");
  }
  $("pfAvatarRemove").classList.toggle("hidden", !shown);
}

async function loadProfile() {
  const cachedName = localStorage.getItem("ac_name");
  const cachedAvatar = localStorage.getItem("ac_avatar");
  if (cachedName || cachedAvatar) {
    currentAvatar = cachedAvatar || null;
    renderHeaderProfile(cachedName, cachedAvatar);
  }
  try {
    const p = await api("/api/auth/profile");
    currentAvatar = p.avatar || null;
    renderHeaderProfile(p.name, p.avatar);
    localStorage.setItem("ac_name", p.name || "");
    localStorage.setItem("ac_avatar", p.avatar || "");
  } catch (err) {
    // Профиль — некритичная часть шапки, не мешаем тостами
  }
}

function openProfile() {
  $("pfName").value = $("profileName").textContent || "";
  pendingAvatar = undefined;
  $("profileError").classList.add("hidden");
  applyProfilePreview();
  $("profileModal").classList.remove("hidden");
  $("profileModal").classList.add("flex");
}

function closeProfile() {
  $("profileModal").classList.add("hidden");
  $("profileModal").classList.remove("flex");
}

function shrinkImage(file, done) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const SIZE = 128; // прокси Modal режет тела больше ~10 КБ — держим аватар компактным
      const canvas = document.createElement("canvas");
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext("2d");
      const scale = Math.max(SIZE / img.width, SIZE / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
      let q = 0.8;
      let dataUrl = canvas.toDataURL("image/jpeg", q);
      while (dataUrl.length > 8000 && q > 0.35) {
        q -= 0.15;
        dataUrl = canvas.toDataURL("image/jpeg", q);
      }
      if (dataUrl.length > 10000) {
        toast("Это фото не удалось сжать до допустимого размера. Попробуйте другое.", "error");
        return;
      }
      done(dataUrl);
    };
    img.onerror = () => toast("Не удалось прочитать изображение.", "error");
    img.src = reader.result;
  };
  reader.onerror = () => toast("Не удалось прочитать файл.", "error");
  reader.readAsDataURL(file);
}

function onAvatarFile() {
  const input = $("pfAvatarInput");
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
    toast("Поддерживаются PNG, JPEG и WebP.", "error");
    return;
  }
  toast("Обрабатываем фото…");
  setTimeout(() => shrinkImage(file, (dataUrl) => {
    pendingAvatar = dataUrl;
    applyProfilePreview();
    toast("Фото готово. Нажмите «Сохранить».", "success");
  }), 50);
}

function removeAvatar() {
  pendingAvatar = null;
  applyProfilePreview();
}

async function saveProfile(e) {
  e.preventDefault();
  const errEl = $("profileError");
  errEl.classList.add("hidden");
  const body = { name: $("pfName").value.trim() };
  if (pendingAvatar !== undefined) body.avatar = pendingAvatar === null ? "" : pendingAvatar;

  const btn = $("pfSaveBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Сохраняем…';
  try {
    const p = await api("/api/auth/profile", { method: "PATCH", body });
    if (!p || !("avatar" in p)) throw new Error("Сервер не подтвердил сохранение. Проверьте интернет и попробуйте ещё раз через минуту.");
    currentAvatar = p.avatar || null;
    pendingAvatar = undefined;
    renderHeaderProfile(p.name, p.avatar);
    localStorage.setItem("ac_name", p.name || "");
    localStorage.setItem("ac_avatar", p.avatar || "");
    closeProfile();
    toast("Профиль сохранён", "success");
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Сохранить";
  }
}

// --- Инициализация ---
(function init() {
  if (!requireAuth()) return;

  warmBackend();

  $("userEmail").textContent = localStorage.getItem("ac_email") || "";

  $("genForm").addEventListener("submit", generate);
  $("logoutBtn").addEventListener("click", () => {
    localStorage.removeItem("ac_token");
    localStorage.removeItem("ac_email");
    localStorage.removeItem("ac_name");
    localStorage.removeItem("ac_avatar");
    localStorage.removeItem("ac_usage");
    localStorage.removeItem("ac_history");
    location.href = "index.html";
  });
  $("profileBtn").addEventListener("click", openProfile);
  $("pfClose").addEventListener("click", closeProfile);
  $("profileModal").addEventListener("click", (e) => { if (e.target === $("profileModal")) closeProfile(); });
  $("pfAvatarPick").addEventListener("click", () => $("pfAvatarInput").click());
  $("pfAvatarInput").addEventListener("change", onAvatarFile);
  $("pfAvatarRemove").addEventListener("click", removeAvatar);
  $("pfForm").addEventListener("submit", saveProfile);
  $("copyBtn").addEventListener("click", async () => {
    const ok = await copyText($("resultText").textContent);
    toast(ok ? "Скопировано в буфер обмена" : "Не удалось скопировать", ok ? "success" : "error");
  });
  $("upgradeBtn").addEventListener("click", () => openPay("pro"));
  $("upgradeBtnPlus").addEventListener("click", () => openPay("pro_plus"));
  $("payClose").addEventListener("click", closePay);
  $("payModal").addEventListener("click", (e) => { if (e.target === $("payModal")) closePay(); });
  $("payForm").addEventListener("submit", pay);

  // Маска номера карты: группы по 4 цифры
  $("cardNumber").addEventListener("input", (e) => {
    const digits = e.target.value.replace(/\D/g, "").slice(0, 19);
    e.target.value = digits.replace(/(.{4})/g, "$1 ").trim();
  });
  // Маска срока: ММ/ГГ
  $("cardExp").addEventListener("input", (e) => {
    const digits = e.target.value.replace(/\D/g, "").slice(0, 4);
    e.target.value = digits.length > 2 ? digits.slice(0, 2) + "/" + digits.slice(2) : digits;
  });

  const cachedUsage = localStorage.getItem("ac_usage");
  if (cachedUsage) {
    try { renderUsage(JSON.parse(cachedUsage)); } catch (e) {}
  }
  const cachedHistory = localStorage.getItem("ac_history");
  if (cachedHistory) {
    try { renderHistory(JSON.parse(cachedHistory).items || []); } catch (e) {}
  }

  loadUsage();
  loadHistory();
  loadProfile();

  // Открытие модалки оплаты по прямой ссылке dashboard.html#upgrade (с лендинга)
  if (location.hash === "#upgrade") {
    openPay("pro");
    history.replaceState(null, "", location.pathname);
  }
})();
