// Общая логика фронтенда: HTTP-обёртка, тосты, копирование.

const API_URL = (window.APP_CONFIG && window.APP_CONFIG.API_URL) || "http://localhost:8000";

let toastTimer = null;
function toast(message, type = "info") {
  const el = document.getElementById("toast");
  if (!el) { alert(message); return; }
  el.textContent = message;
  el.className = "show " + (type === "error" ? "bg-rose-600" : type === "success" ? "bg-emerald-600" : "bg-slate-700");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ""; }, 4500);
}

async function api(path, { method = "GET", body = null, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = localStorage.getItem("ac_token");
  if (auth && token) headers["Authorization"] = "Bearer " + token;

  let resp;
  try {
    resp = await fetch(API_URL + path, { method, headers, body: body ? JSON.stringify(body) : null });
  } catch (e) {
    throw new Error("Нет связи с сервером. Проверьте интернет и что backend запущен.");
  }

  let data = null;
  try { data = await resp.json(); } catch (e) { data = null; }

  // Сессия истекла или невалидна — выкидываем на главную
  if (resp.status === 401 && auth) {
    localStorage.removeItem("ac_token");
    localStorage.removeItem("ac_email");
    if (document.body.dataset.page === "dashboard") location.href = "index.html";
    throw new Error((data && data.detail) || "Сессия истекла. Войдите заново.");
  }

  if (!resp.ok) throw new Error((data && data.detail) || "Ошибка сервера (" + resp.status + ")");
  return data;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      return true;
    } catch (e2) {
      return false;
    } finally {
      ta.remove();
    }
  }
}
