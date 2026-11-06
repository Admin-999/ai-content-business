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
    renderUsage(await api("/api/usage"));
  } catch (err) {
    if (document.body.dataset.page === "dashboard" && !localStorage.getItem("ac_token")) return;
    toast(err.message, "error");
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
    list.appendChild(d);
  }
}

async function loadHistory() {
  try {
    const data = await api("/api/history?limit=20");
    renderHistory(data.items);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function generate(e) {
  e.preventDefault();
  const topic = $("topic").value.trim();
  if (topic.length < 3) {
    toast("Опишите тему подробнее: минимум 3 символа.", "error");
    return;
  }
  const btn = $("genBtn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Генерируем… до минуты';

  try {
    const data = await api("/api/generate", {
      method: "POST",
      body: {
        topic,
        content_type: $("contentType").value,
        tone: $("tone").value,
        language: $("language").value,
      },
    });
    $("resultCard").classList.remove("hidden");
    $("resultText").textContent = data.content;
    $("resultCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
    toast(`Готово! Осталось генераций сегодня: ${data.remaining}`, "success");
    loadUsage();
    loadHistory();
  } catch (err) {
    toast(err.message, "error");
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
  shrinkImage(file, (dataUrl) => {
    pendingAvatar = dataUrl;
    applyProfilePreview();
  });
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

  loadUsage();
  loadHistory();
  loadProfile();

  // Открытие модалки оплаты по прямой ссылке dashboard.html#upgrade (с лендинга)
  if (location.hash === "#upgrade") {
    openPay("pro");
    history.replaceState(null, "", location.pathname);
  }
})();
