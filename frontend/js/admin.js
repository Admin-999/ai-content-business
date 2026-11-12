// Админ-панель: вход администратора, поиск пользователей, выдача и отзыв подписок.
// Требует, чтобы на сервере были развёрнуты маршруты /api/admin/*.

const PLAN_LIMITS = { free: 5, pro: 100, pro_plus: 300 };
const PLAN_LABELS = { free: "FREE", pro: "PRO", pro_plus: "PRO+" };

function $(id) { return document.getElementById(id); }

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ru-RU");
}

function fmtDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function planBadge(plan) {
  const p = plan || "free";
  const label = PLAN_LABELS[p] || p;
  const cls = p === "pro"
    ? "bg-indigo-500/20 text-indigo-200 border-indigo-400/30"
    : p === "pro_plus"
      ? "bg-violet-500/20 text-violet-200 border-violet-400/30"
      : "bg-slate-700/40 text-slate-300 border-white/10";
  return '<span class="rounded-full border px-2 py-0.5 text-xs font-semibold ' + cls + '">' + esc(label) + "</span>";
}

// Обёртка над fetch: возвращает статус-код, чтобы различать 401/403/404.
async function adminApi(path, { method = "GET", body = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = localStorage.getItem("ac_token");
  if (token) headers["Authorization"] = "Bearer " + token;
  const resp = await fetch(API_URL + path, {
    method, headers, body: body ? JSON.stringify(body) : null,
  });
  let data = null;
  try { data = await resp.json(); } catch (e) { data = null; }
  if (!resp.ok) {
    const err = new Error((data && data.detail) || ("Ошибка сервера (" + resp.status + ")"));
    err.status = resp.status;
    throw err;
  }
  return data;
}

// --- Переключение экранов ----------------------------------------------------
function hideAll() {
  ["adminLogin", "adminDenied", "adminOutdated", "adminPanel"].forEach((id) => {
    if ($(id)) $(id).classList.add("hidden");
  });
}

function showLogin() {
  hideAll();
  $("adminLogin").classList.remove("hidden");
  const saved = localStorage.getItem("ac_email");
  if (saved) $("adminLoginEmail").value = saved;
}

function showDenied(email) {
  hideAll();
  $("adminDenied").classList.remove("hidden");
  $("deniedEmail").textContent = email || "—";
}

function showOutdated() {
  hideAll();
  $("adminOutdated").classList.remove("hidden");
}

function showPanel() {
  hideAll();
  $("adminPanel").classList.remove("hidden");
  $("adminEmail").textContent = localStorage.getItem("ac_email") || "";
}

// --- Данные ------------------------------------------------------------------
let state = { q: "", plan: "", offset: 0, limit: 25, total: 0, items: [] };

async function loadOverview() {
  const ov = await adminApi("/api/admin/overview");
  const cards = [
    ["Всего пользователей", ov.users_total, "text-slate-100"],
    ["Активные подписки", ov.active_subscriptions, "text-emerald-300"],
    ["Новых сегодня", ov.new_today, "text-indigo-300"],
    ["Генераций сегодня", ov.generations_today, "text-violet-300"],
  ];
  $("statsGrid").innerHTML = cards.map(([label, value, color]) =>
    '<div class="rounded-2xl border border-white/10 bg-slate-900/60 p-5">' +
      '<div class="text-sm text-slate-400">' + esc(label) + "</div>" +
      '<div class="mt-1 text-3xl font-bold ' + color + '">' + esc(value != null ? value : 0) + "</div>" +
    "</div>").join("") +
    '<div class="rounded-2xl border border-white/10 bg-slate-900/60 p-5 sm:col-span-2 lg:col-span-4">' +
      '<div class="flex flex-wrap items-center gap-3 text-sm">' +
        '<span class="text-slate-400">Тарифы:</span>' +
        planBadge("free") + "<span class=\"text-slate-300\">" + esc(ov.plans.free) + "</span>" +
        planBadge("pro") + "<span class=\"text-slate-300\">" + esc(ov.plans.pro) + "</span>" +
        planBadge("pro_plus") + "<span class=\"text-slate-300\">" + esc(ov.plans.pro_plus) + "</span>" +
        '<span class="ml-auto text-slate-500">Всего генераций: ' + esc(ov.generations_total) + "</span>" +
      "</div>" +
    "</div>";
}

async function loadUsers(reset) {
  if (reset) { state.offset = 0; state.items = []; $("usersBody").innerHTML = ""; }
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.plan) params.set("plan", state.plan);
  params.set("limit", state.limit);
  params.set("offset", state.offset);

  const data = await adminApi("/api/admin/users?" + params.toString());
  state.total = data.total;
  state.items = reset ? data.items : state.items.concat(data.items);
  renderUsers(data.items, !reset);
  state.offset = state.items.length;

  $("usersCount").textContent = state.total + " чел.";
  $("usersEmpty").classList.toggle("hidden", state.total !== 0);
  $("loadMoreBtn").classList.toggle("hidden", state.items.length >= state.total);
}

function renderUsers(items, append) {
  const body = $("usersBody");
  if (!append) body.innerHTML = "";
  const html = items.map((u) => {
    const limit = PLAN_LIMITS[u.plan] || PLAN_LIMITS.free;
    return '<tr class="border-b border-white/5 align-top">' +
      '<td class="py-3 pr-3">' +
        '<div class="font-medium text-slate-100">' + esc(u.email) + "</div>" +
        '<div class="text-xs text-slate-500">' + (u.name ? esc(u.name) + " · " : "") + '<span class="font-mono">' + esc(u.id) + "</span></div>" +
      "</td>" +
      '<td class="py-3 pr-3">' + planBadge(u.plan) + "</td>" +
      '<td class="py-3 pr-3 text-slate-300">' + esc(fmtDate(u.plan_expires_at)) + "</td>" +
      '<td class="py-3 pr-3 text-slate-300">' + esc(u.used_today) + " / " + esc(limit) + "</td>" +
      '<td class="py-3 pr-3 text-slate-400">' + esc(fmtDate(u.created_at)) + "</td>" +
      '<td class="py-3 pl-3 text-right whitespace-nowrap">' +
        '<button data-act="grant" data-id="' + esc(u.id) + '" data-email="' + esc(u.email) + '" class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500">Выдать</button> ' +
        '<button data-act="free" data-id="' + esc(u.id) + '" data-email="' + esc(u.email) + '" class="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10">Снять</button>' +
      "</td>" +
    "</tr>";
  }).join("");
  body.insertAdjacentHTML("beforeend", html);
}

// --- Загрузка панели ---------------------------------------------------------
async function boot() {
  const token = localStorage.getItem("ac_token");
  if (!token) return showLogin();
  try {
    await loadOverview();
    showPanel();
    await loadUsers(true);
  } catch (err) {
    if (err.status === 401) { localStorage.removeItem("ac_token"); return showLogin(); }
    if (err.status === 403) return showDenied(localStorage.getItem("ac_email"));
    if (err.status === 404) return showOutdated();
    toast(err.message, "error");
    showLogin();
  }
}

// --- Модалка выдачи ----------------------------------------------------------
let grantTarget = null;

function openGrant(id, email) {
  grantTarget = id;
  $("grantUser").textContent = email || "";
  $("grantForm").reset();
  $("grantDaysWrap").classList.remove("hidden");
  $("grantModal").classList.remove("hidden");
  $("grantModal").classList.add("flex");
}

function closeGrant() {
  $("grantModal").classList.add("hidden");
  $("grantModal").classList.remove("flex");
  grantTarget = null;
}

async function submitGrant(e) {
  e.preventDefault();
  if (!grantTarget) return;
  const plan = $("grantPlan").value;
  const days = parseInt($("grantDays").value, 10) || 30;
  const btn = $("grantSubmit");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Выдаём…';
  try {
    const res = await adminApi("/api/admin/users/" + encodeURIComponent(grantTarget) + "/grant", {
      method: "POST", body: { plan, days },
    });
    toast(res.message || "Готово", "success");
    closeGrant();
    await loadOverview().catch(() => {});
    await loadUsers(true);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Выдать";
  }
}

// --- Слушатели ---------------------------------------------------------------
$("adminLoginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("adminLoginError").classList.add("hidden");
  const email = $("adminLoginEmail").value.trim();
  const password = $("adminLoginPassword").value;
  if (!email || !password) {
    $("adminLoginError").textContent = "Заполните email и пароль.";
    $("adminLoginError").classList.remove("hidden");
    return;
  }
  const btn = $("adminLoginBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Входим…';
  try {
    const resp = await fetch(API_URL + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      $("adminLoginError").textContent = (data && data.detail) || "Неверный email или пароль.";
      $("adminLoginError").classList.remove("hidden");
      return;
    }
    localStorage.setItem("ac_token", data.token);
    localStorage.setItem("ac_email", data.email || email);
    await boot();
  } catch (err) {
    $("adminLoginError").textContent = "Сервер не отвечает. Попробуйте позже.";
    $("adminLoginError").classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Войти";
  }
});

$("deniedLoginBtn").addEventListener("click", () => {
  localStorage.removeItem("ac_token");
  localStorage.removeItem("ac_email");
  showLogin();
});

$("outdatedRetryBtn").addEventListener("click", () => boot());

$("logoutBtn").addEventListener("click", () => {
  localStorage.removeItem("ac_token");
  localStorage.removeItem("ac_email");
  showLogin();
});

let searchTimer = null;
$("userSearch").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = $("userSearch").value.trim();
    loadUsers(true).catch((err) => toast(err.message, "error"));
  }, 400);
});
$("userSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("searchBtn").click(); } });
$("searchBtn").addEventListener("click", () => {
  state.q = $("userSearch").value.trim();
  loadUsers(true).catch((err) => toast(err.message, "error"));
});

document.querySelectorAll(".chip[data-plan]").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip[data-plan]").forEach((c) => c.classList.toggle("active", c === chip));
    state.plan = chip.dataset.plan || "";
    loadUsers(true).catch((err) => toast(err.message, "error"));
  });
});

$("loadMoreBtn").addEventListener("click", () => {
  loadUsers(false).catch((err) => toast(err.message, "error"));
});

$("usersBody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const email = btn.dataset.email;
  if (btn.dataset.act === "grant") return openGrant(id, email);
  if (btn.dataset.act === "free") {
    if (!confirm("Снять подписку с " + email + "?")) return;
    btn.disabled = true;
    try {
      const res = await adminApi("/api/admin/users/" + encodeURIComponent(id) + "/revoke", { method: "POST" });
      toast(res.message || "Подписка снята", "success");
      await loadOverview().catch(() => {});
      await loadUsers(true);
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
    }
  }
});

$("grantPlan").addEventListener("change", () => {
  $("grantDaysWrap").classList.toggle("hidden", $("grantPlan").value === "free");
});
$("grantClose").addEventListener("click", closeGrant);
$("grantModal").addEventListener("click", (e) => { if (e.target === $("grantModal")) closeGrant(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeGrant(); });
$("grantForm").addEventListener("submit", submitGrant);

boot();
