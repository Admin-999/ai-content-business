// Логика модалки входа/регистрации на лендинге.

const authModal = document.getElementById("authModal");
const tabLogin = document.getElementById("tabLogin");
const tabRegister = document.getElementById("tabRegister");
const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");

function openAuth(mode) {
  authModal.classList.remove("hidden");
  authModal.classList.add("flex");
  setAuthTab(mode);
}

function closeAuth() {
  authModal.classList.add("hidden");
  authModal.classList.remove("flex");
}

function setAuthTab(mode) {
  const isLogin = mode === "login";
  tabLogin.classList.toggle("active", isLogin);
  tabRegister.classList.toggle("active", !isLogin);
  loginForm.classList.toggle("hidden", !isLogin);
  registerForm.classList.toggle("hidden", isLogin);
}

function showAuthError(elId, message) {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.classList.remove("hidden");
}

function saveSession(data) {
  localStorage.setItem("ac_token", data.token);
  localStorage.setItem("ac_email", data.email || "");
  location.href = "dashboard.html";
}

if (authModal) {
  tabLogin.addEventListener("click", () => setAuthTab("login"));
  tabRegister.addEventListener("click", () => setAuthTab("register"));
  document.getElementById("authClose").addEventListener("click", closeAuth);
  authModal.addEventListener("click", (e) => { if (e.target === authModal) closeAuth(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAuth(); });

  // Вход
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    document.getElementById("loginError").classList.add("hidden");
    if (!email || !password) return showAuthError("loginError", "Заполните email и пароль.");
    try {
      const data = await api("/api/auth/login", { method: "POST", auth: false, body: { email, password } });
      saveSession(data);
    } catch (err) {
      showAuthError("loginError", err.message);
    }
  });

  // Регистрация
  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("regEmail").value.trim();
    const password = document.getElementById("regPassword").value;
    document.getElementById("regError").classList.add("hidden");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showAuthError("regError", "Введите корректный email.");
    if (password.length < 8) return showAuthError("regError", "Пароль должен быть не короче 8 символов.");
    if (password.length > 64) return showAuthError("regError", "Пароль должен быть не длиннее 64 символов.");
    try {
      const data = await api("/api/auth/register", { method: "POST", auth: false, body: { email, password } });
      saveSession(data);
    } catch (err) {
      showAuthError("regError", err.message);
    }
  });
}

// Кнопки лендинга
document.querySelectorAll("[data-auth]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (localStorage.getItem("ac_token")) {
      location.href = "dashboard.html";
    } else {
      openAuth(btn.dataset.auth || "register");
    }
  });
});

document.querySelectorAll("[data-upgrade]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (localStorage.getItem("ac_token")) {
      location.href = "dashboard.html#upgrade";
    } else {
      openAuth("register");
      toast("Сначала создайте бесплатный аккаунт — это займёт 20 секунд.", "info");
    }
  });
});

// Если пользователь уже вошёл — меняем кнопки шапки на «Личный кабинет»
(function initHeader() {
  const loginBtn = document.getElementById("loginBtn");
  const startBtn = document.getElementById("startBtn");
  if (!loginBtn) return;
  if (localStorage.getItem("ac_token")) {
    loginBtn.textContent = "Личный кабинет";
    loginBtn.onclick = () => (location.href = "dashboard.html");
    if (startBtn) startBtn.onclick = () => (location.href = "dashboard.html");
  } else {
    loginBtn.onclick = () => openAuth("login");
    if (startBtn) startBtn.onclick = () => openAuth("register");
  }
})();
