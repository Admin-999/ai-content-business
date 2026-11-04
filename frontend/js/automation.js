// Раздел «Автоматизация»: каналы (Telegram, Instagram), маркетплейсы (Wildberries, Ozon, AliExpress, Яндекс Маркет), ИИ-боты.
// Использует api()/toast()/copyText()/$/fmtDate/loadUsage из api.js и dashboard.js.

// Отправка формы с файлом (FormData, без Content-Type: application/json)
async function apiForm(path, formData) {
  const headers = {};
  const token = localStorage.getItem("ac_token");
  if (token) headers["Authorization"] = "Bearer " + token;
  let resp;
  try {
    resp = await fetch(API_URL + path, { method: "POST", headers, body: formData });
  } catch (e) {
    throw new Error("Сервер не отвечает — возможно, он просыпается после паузы. Подождите минуту и попробуйте ещё раз.");
  }
  let data = null;
  try { data = await resp.json(); } catch (e) { data = null; }
  if (resp.status === 401) {
    localStorage.removeItem("ac_token");
    localStorage.removeItem("ac_email");
    location.href = "index.html";
    throw new Error("Сессия истекла. Войдите заново.");
  }
  if (!resp.ok) throw new Error((data && data.detail) || "Ошибка сервера (" + resp.status + ")");
  return data;
}

(function initAutomation() {
  if (!document.getElementById("automation")) return;
  if (!localStorage.getItem("ac_token")) return;

  // ===== Вкладки =====
  const tabBtns = Array.from(document.querySelectorAll(".autotab"));
  function openTab(name) {
    for (const b of tabBtns) b.classList.toggle("active", b.dataset.tab === name);
    document.querySelectorAll(".autotab-pane").forEach((p) => p.classList.toggle("hidden", p.id !== "tab-" + name));
  }
  tabBtns.forEach((b) => b.addEventListener("click", () => openTab(b.dataset.tab)));
  openTab("channels");

  // ===== Каналы: Telegram и Instagram =====
  const INTERVAL_NAMES = { 6: "каждые 6 часов", 12: "каждые 12 часов", 24: "раз в день" };

  const platformChips = Array.from(document.querySelectorAll("#platformChips .chip"));

  function selectPlatform(name) {
    platformChips.forEach((c) => c.classList.toggle("active", c.dataset.v === name));
    $("chPlatform").value = name;
    const isIg = name === "instagram";
    $("igFields").classList.toggle("hidden", !isIg);
    $("tgUsernameField").classList.toggle("hidden", isIg);
    $("igSetupHint").classList.toggle("hidden", !isIg);
    $("tgSetupHint").classList.toggle("hidden", isIg);
  }
  platformChips.forEach((chip) => chip.addEventListener("click", () => selectPlatform(chip.dataset.v)));

  function channelCard(ch) {
    const isIg = ch.platform === "instagram";
    const card = document.createElement("div");
    card.className = "rounded-xl border border-white/10 bg-slate-950/60 p-4";

    const head = document.createElement("div");
    head.className = "flex flex-wrap items-center justify-between gap-2";
    const title = document.createElement("span");
    title.className = "font-semibold";
    title.textContent = ch.title;
    const plat = document.createElement("span");
    plat.className = isIg
      ? "rounded-full bg-fuchsia-500/15 px-2.5 py-0.5 text-xs font-semibold text-fuchsia-300"
      : "rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs font-semibold text-sky-300";
    plat.textContent = isIg ? "Instagram" : "Telegram";
    const badge = document.createElement("span");
    badge.className = ch.active
      ? "rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-300"
      : "rounded-full bg-slate-700 px-2.5 py-0.5 text-xs font-semibold text-slate-300";
    badge.textContent = ch.active ? "Работает" : "Пауза";
    head.append(title, plat, badge);

    const meta = document.createElement("p");
    meta.className = "mt-1 text-xs text-slate-400";
    meta.textContent =
      (isIg ? "@" + (ch.ig_username || "instagram") : "@" + ch.channel_username) +
      " · тон: " + ch.tone +
      " · " + (INTERVAL_NAMES[ch.interval_hours] || "каждые " + ch.interval_hours + " ч") +
      " · опубликовано: " + ch.posts_sent + " из " + ch.posts_total +
      (ch.last_post_at ? " · последний пост: " + fmtDate(ch.last_post_at) : "");

    const actions = document.createElement("div");
    actions.className = "mt-3 flex flex-wrap gap-2";
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10";
    toggleBtn.textContent = ch.active ? "Поставить на паузу" : "Возобновить";
    toggleBtn.dataset.action = "toggle";
    toggleBtn.dataset.id = ch.id;
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "rounded-lg border border-rose-500/30 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10";
    deleteBtn.textContent = "Удалить";
    deleteBtn.dataset.action = "delete";
    deleteBtn.dataset.id = ch.id;
    actions.append(toggleBtn, deleteBtn);

    card.append(head, meta, actions);

    if (isIg && ch.token_expires_at) {
      const days = Math.ceil((new Date(ch.token_expires_at) - Date.now()) / 86400000);
      if (days < 10) {
        const warn = document.createElement("p");
        warn.className = "mt-2 text-xs " + (days < 3 ? "text-rose-400" : "text-amber-400");
        warn.textContent = days < 0
          ? "Токен Instagram истёк — подключите аккаунт заново (см. инструкцию в форме выше)."
          : "Токен Instagram истекает через " + days + " дн. — обычно он продлевается сам. Если посты перестанут выходить, подключите аккаунт заново.";
        card.appendChild(warn);
      }
    }

    const det = document.createElement("details");
    det.className = "mt-3";
    const summary = document.createElement("summary");
    summary.className = "cursor-pointer text-sm text-slate-300";
    summary.textContent = "Последние посты";
    const postsBox = document.createElement("div");
    postsBox.className = "mt-2 space-y-2";
    det.append(summary, postsBox);
    let loaded = false;
    det.addEventListener("toggle", async () => {
      if (!det.open || loaded) return;
      loaded = true;
      try {
        const data = await api("/api/channels/" + ch.id + "/posts");
        if (!data.posts.length) {
          const p = document.createElement("p");
          p.className = "text-xs text-slate-500";
          p.textContent = "Постов ещё не было — первый выйдет по расписанию.";
          postsBox.appendChild(p);
          return;
        }
        for (const post of data.posts) {
          const box = document.createElement("div");
          box.className = "rounded-lg border border-white/10 bg-slate-950/60 p-3";
          const headLine = document.createElement("p");
          headLine.className = "text-xs " + (post.status === "sent" ? "text-emerald-400" : "text-rose-400");
          headLine.textContent =
            (post.status === "sent" ? "Опубликован" : "Ошибка") + " · " + fmtDate(post.created_at) +
            (post.error ? " · " + post.error : "");
          const pre = document.createElement("pre");
          pre.className = "mt-1 whitespace-pre-wrap font-sans text-xs leading-relaxed text-slate-300";
          pre.textContent = post.text || "";
          box.append(headLine, pre);
          postsBox.appendChild(box);
        }
      } catch (err) {
        toast(err.message, "error");
      }
    });

    card.append(head, meta, actions, det);
    return card;
  }

  async function loadChannels() {
    try {
      const data = await api("/api/channels");
      const list = $("channelList");
      list.innerHTML = "";
      if (!data.channels.length) {
        const p = document.createElement("p");
        p.className = "text-sm text-slate-400";
        p.textContent = "Пока нет каналов. Выберите Telegram или Instagram в форме выше — и ИИ начнёт публиковать посты сам.";
        list.appendChild(p);
        return;
      }
      for (const ch of data.channels) list.appendChild(channelCard(ch));
    } catch (err) {
      toast(err.message, "error");
    }
  }

  $("channelForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const platform = $("chPlatform").value;
    const title = $("chTitle").value.trim();
    const description = $("chDesc").value.trim();
    if (title.length < 2) return toast("Введите название канала.", "error");
    if (description.length < 10) return toast("Опишите канал подробнее: минимум 10 символов.", "error");
    const btn = $("chBtn");
    btn.disabled = true;
    try {
      if (platform === "instagram") {
        const access_token = $("chIgToken").value.trim();
        const app_secret = $("chIgSecret").value.trim();
        if (access_token.length < 20) return toast("Вставьте токен из кабинета Meta — пошаговая инструкция в подсказке над формой.", "error");
        if (!app_secret) return toast("Вставьте App Secret из настроек приложения Meta (Настройки приложения → Basic).", "error");
        btn.innerHTML = '<span class="spinner"></span>Подключаем Instagram…';
        await api("/api/channels/instagram", {
          method: "POST",
          body: {
            title,
            description,
            tone: $("chTone").value,
            interval_hours: parseInt($("chInterval").value, 10),
            access_token,
            app_secret,
          },
        });
        toast("Instagram подключён! ИИ начнёт публиковать посты-карточки по расписанию.", "success");
      } else {
        const channel_username = $("chUsername").value.trim();
        if (!channel_username) return toast("Укажите адрес канала, например @my_shop.", "error");
        btn.innerHTML = '<span class="spinner"></span>Проверяем бота и канал…';
        await api("/api/channels", {
          method: "POST",
          body: {
            title,
            description,
            channel_username,
            tone: $("chTone").value,
            interval_hours: parseInt($("chInterval").value, 10),
          },
        });
        toast("Канал подключён! ИИ начнёт публиковать посты по расписанию.", "success");
      }
      $("channelForm").reset();
      selectPlatform("telegram");
      loadChannels();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Подключить";
    }
  });

  $("channelList").addEventListener("click", async (e) => {
    const btnEl = e.target.closest("button[data-action]");
    if (!btnEl) return;
    try {
      if (btnEl.dataset.action === "toggle") {
        await api("/api/channels/" + btnEl.dataset.id + "/toggle", { method: "POST" });
        loadChannels();
      } else if (btnEl.dataset.action === "delete") {
        if (!confirm("Удалить канал? История автопостов тоже удалится.")) return;
        await api("/api/channels/" + btnEl.dataset.id, { method: "DELETE" });
        toast("Канал удалён.", "success");
        loadChannels();
      }
    } catch (err) {
      toast(err.message, "error");
    }
  });

  async function loadChannelSetup() {
    try {
      const data = await api("/api/channels/setup");
      const name = data.bot_username ? "@" + data.bot_username : "нашего бота";
      document.querySelectorAll(".service-bot-name").forEach((el) => { el.textContent = name; });
    } catch (err) { /* имя бота не критично для работы */ }
  }

  // ===== Маркетплейсы (Wildberries, Ozon, AliExpress, Яндекс Маркет) =====
  const MP_NAMES = { wb: "Wildberries", ozon: "Ozon", aliexpress: "AliExpress", yamarket: "Яндекс Маркет" };
  const MP_BOXES = { wb: "wbStoreBox", ozon: "ozonStoreBox", yamarket: "ymStoreBox", aliexpress: "aliStoreBox" };
  const mpChips = Array.from(document.querySelectorAll("#mpChips .chip"));

  function selectMarketplace(name) {
    mpChips.forEach((c) => c.classList.toggle("active", c.dataset.v === name));
    $("wbPlatform").value = name;
    for (const key of Object.keys(MP_BOXES)) {
      $(MP_BOXES[key]).classList.toggle("hidden", key !== name);
    }
  }
  mpChips.forEach((chip) => chip.addEventListener("click", () => selectMarketplace(chip.dataset.v)));

  function setStoreStatus(prefix, connected, yesText, noText) {
    $(prefix + "StatusText").textContent = connected ? yesText : noText;
    $(prefix + "DisconnectBtn").classList.toggle("hidden", !connected);
    $(prefix + "ConnectBtn").classList.toggle("hidden", connected);
  }

  async function loadMpAccounts() {
    try {
      const data = await api("/api/wb/accounts");
      const by = {};
      for (const a of data.accounts) by[a.platform] = a;
      setStoreStatus(
        "wb",
        !!(by.wb && by.wb.connected),
        "Магазин подключён. Новые карточки будут публиковаться автоматически.",
        "Магазин не подключён: карточки будут создаваться, но публиковать их придётся вручную."
      );
      setStoreStatus(
        "ozon",
        !!(by.ozon && by.ozon.connected),
        "Магазин Ozon подключён. Категория подбирается автоматически, публикация — сама.",
        "Магазин не подключён: карточки будут создаваться, но публиковать их придётся вручную."
      );
      setStoreStatus(
        "ym",
        !!(by.yamarket && by.yamarket.connected),
        "Магазин Маркета подключён. Новые карточки будут публиковаться автоматически.",
        "Магазин не подключён: карточки будут создаваться, но публиковать их придётся вручную."
      );
      setStoreStatus(
        "ali",
        !!(by.aliexpress && by.aliexpress.connected),
        "Магазин AliExpress подключён. Новые карточки будут публиковаться автоматически.",
        "Магазин не подключён: карточки будут создаваться, но публиковать их придётся вручную."
      );
    } catch (err) {
      toast(err.message, "error");
    }
  }

  function connectBtnState(btn, busy, busyText, idleText) {
    btn.disabled = busy;
    btn.innerHTML = busy ? '<span class="spinner"></span>' + busyText : idleText;
  }

  $("wbConnectBtn").addEventListener("click", async () => {
    const token = $("wbToken").value.trim();
    if (token.length < 10) return toast("Вставьте API-токен из кабинета Wildberries (Настройки → Доступ к API).", "error");
    const btn = $("wbConnectBtn");
    connectBtnState(btn, true, "Проверяем токен…", "Подключить");
    try {
      await api("/api/wb/connect", { method: "POST", body: { platform: "wb", api_token: token } });
      toast("Wildberries подключён!", "success");
      $("wbToken").value = "";
      loadMpAccounts();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      connectBtnState(btn, false, "", "Подключить");
    }
  });

  $("ozonConnectBtn").addEventListener("click", async () => {
    const clientId = $("ozonClientId").value.trim();
    const apiKey = $("ozonApiKey").value.trim();
    if (clientId.length < 4 || apiKey.length < 8) return toast("Вставьте Client-Id и Api-Key из кабинета Ozon (Настройки → API-ключи).", "error");
    const btn = $("ozonConnectBtn");
    connectBtnState(btn, true, "Проверяем ключи…", "Подключить");
    try {
      await api("/api/wb/connect", { method: "POST", body: { platform: "ozon", client_id: clientId, api_key: apiKey } });
      toast("Ozon подключён!", "success");
      $("ozonClientId").value = "";
      $("ozonApiKey").value = "";
      loadMpAccounts();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      connectBtnState(btn, false, "", "Подключить");
    }
  });

  $("ymConnectBtn").addEventListener("click", async () => {
    const token = $("ymToken").value.trim();
    if (token.length < 10) return toast("Вставьте API-ключ из кабинета Яндекс Маркета (Настройки → API-ключи).", "error");
    const btn = $("ymConnectBtn");
    connectBtnState(btn, true, "Проверяем ключ…", "Подключить");
    try {
      await api("/api/wb/connect", { method: "POST", body: { platform: "yamarket", api_token: token } });
      toast("Яндекс Маркет подключён!", "success");
      $("ymToken").value = "";
      loadMpAccounts();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      connectBtnState(btn, false, "", "Подключить");
    }
  });

  $("aliConnectBtn").addEventListener("click", async () => {
    const appKey = $("aliKey").value.trim();
    const appSecret = $("aliSecret").value.trim();
    const accessToken = $("aliToken").value.trim();
    if (appKey.length < 4 || appSecret.length < 8 || accessToken.length < 10) {
      return toast("Вставьте app_key, app_secret и access_token из AliExpress Open Platform.", "error");
    }
    const btn = $("aliConnectBtn");
    connectBtnState(btn, true, "Проверяем ключи…", "Подключить");
    try {
      await api("/api/wb/connect", {
        method: "POST",
        body: { platform: "aliexpress", app_key: appKey, app_secret: appSecret, access_token: accessToken },
      });
      toast("AliExpress подключён!", "success");
      $("aliKey").value = "";
      $("aliSecret").value = "";
      $("aliToken").value = "";
      loadMpAccounts();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      connectBtnState(btn, false, "", "Подключить");
    }
  });

  for (const [prefix, platform] of [["wb", "wb"], ["ozon", "ozon"], ["ym", "yamarket"], ["ali", "aliexpress"]]) {
    $(prefix + "DisconnectBtn").addEventListener("click", async () => {
      try {
        await api("/api/wb/account/" + platform, { method: "DELETE" });
        toast("Магазин отключён.", "success");
        loadMpAccounts();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  $("wbDisconnectBtn").addEventListener("click", async () => {
    try {
      await api("/api/wb/account", { method: "DELETE" });
      toast("Магазин отключён.", "success");
      loadWbAccount();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  const WB_STATUS = {
    published: ["Опубликована", "text-emerald-300"],
    ready: ["Готова к публикации вручную", "text-sky-300"],
    error: ["Не удалось опубликовать", "text-rose-400"],
  };

  function cardFullText(c) {
    const lines = [c.name, c.price_rub + " ₽", "", c.description, "", "Характеристики:"];
    for (const ch of c.characteristics || []) lines.push("- " + ch.name + ": " + ch.value);
    if (c.keywords) lines.push("", "Ключевые слова: " + c.keywords);
    return lines.join("\n");
  }

  function renderWbResult(c) {
    const box = $("wbResult");
    box.classList.remove("hidden");
    box.innerHTML = "";

    const mpName = MP_NAMES[c.platform] || "Wildberries";
    const h = document.createElement("h3");
    h.className = "font-semibold";
    h.textContent = mpName + ": " + c.name + " — " + c.price_rub + " ₽";
    const st = document.createElement("p");
    const statusInfo = WB_STATUS[c.publish_status] || WB_STATUS.ready;
    st.className = "mt-1 text-xs font-semibold " + statusInfo[1];
    st.textContent = statusInfo[0] +
      (c.publish_subject ? " · категория: " + c.publish_subject : "") +
      (c.publish_error ? " · " + c.publish_error : "");
    const desc = document.createElement("pre");
    desc.className = "mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-200";
    desc.textContent = c.description;
    box.append(h, st, desc);

    if (c.characteristics && c.characteristics.length) {
      const ul = document.createElement("ul");
      ul.className = "mt-2 space-y-1 text-sm text-slate-300";
      for (const ch of c.characteristics) {
        const li = document.createElement("li");
        li.textContent = ch.name + ": " + ch.value;
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
    if (c.keywords) {
      const kw = document.createElement("p");
      kw.className = "mt-2 text-xs text-slate-400";
      kw.textContent = "Ключевые слова: " + c.keywords;
      box.appendChild(kw);
    }
    const copyBtn = document.createElement("button");
    copyBtn.className = "mt-3 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10";
    copyBtn.textContent = "Скопировать карточку";
    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(cardFullText(c));
      toast(ok ? "Карточка скопирована" : "Не удалось скопировать", ok ? "success" : "error");
    });
    box.appendChild(copyBtn);
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function loadWbCards() {
    try {
      const data = await api("/api/wb/cards");
      const list = $("wbCardsList");
      list.innerHTML = "";
      if (!data.cards.length) {
        const p = document.createElement("p");
        p.className = "text-sm text-slate-400";
        p.textContent = "Карточек пока нет. Загрузите фото товара выше — и ИИ составит первую.";
        list.appendChild(p);
        return;
      }
      for (const c of data.cards) {
        const d = document.createElement("details");
        d.className = "rounded-xl border border-white/10 bg-slate-950/60 p-3";
        const s = document.createElement("summary");
        s.className = "cursor-pointer text-sm font-medium";
        const statusInfo = WB_STATUS[c.status] || WB_STATUS.ready;
        s.textContent = (c.platform_name || MP_NAMES[c.platform] || "Wildberries") + " · " + c.name + " — " + c.price_rub + " ₽ (" + statusInfo[0].toLowerCase() + ")";
        const meta = document.createElement("p");
        meta.className = "mt-1 text-xs text-slate-500";
        meta.textContent = fmtDate(c.created_at) + (c.error ? " · " + c.error : "");
        const pre = document.createElement("pre");
        pre.className = "mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-300";
        pre.textContent = c.description;
        d.append(s, meta, pre);
        list.appendChild(d);
      }
    } catch (err) {
      toast(err.message, "error");
    }
  }

  $("wbCardForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $("wbPhoto").files[0];
    if (!file) return toast("Выберите фото товара (JPEG, PNG или WebP).", "error");
    const name = $("wbName").value.trim();
    if (name.length < 3) return toast("Введите название товара: минимум 3 символа.", "error");
    const price = parseInt($("wbPrice").value, 10);
    if (!price || price < 1) return toast("Укажите цену в рублях, например 590.", "error");
    if (file.size > 8 * 1024 * 1024) return toast("Фото больше 8 МБ — выберите поменьше.", "error");

    const fd = new FormData();
    fd.append("photo", file);
    fd.append("name", name);
    fd.append("price_rub", String(price));
    fd.append("platform", $("wbPlatform").value);

    const btn = $("wbCardBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>ИИ рассматривает фото… до минуты';
    try {
      const data = await apiForm("/api/wb/cards", fd);
      renderWbResult(data);
      toast("Карточка готова! Осталось генераций сегодня: " + data.remaining, "success");
      loadWbCards();
      loadUsage();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Создать карточку";
    }
  });

  // ===== ИИ-боты =====
  document.querySelectorAll("#roleChips .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#roleChips .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      $("botRole").value = chip.dataset.v;
    });
  });

  const botPlatformChips = Array.from(document.querySelectorAll("#botPlatformChips .chip"));

  function selectBotPlatform(name) {
    botPlatformChips.forEach((c) => c.classList.toggle("active", c.dataset.v === name));
    $("botPlatform").value = name;
    const isIg = name === "instagram";
    $("botIgFields").classList.toggle("hidden", !isIg);
    $("botTgTokenField").classList.toggle("hidden", isIg);
    $("botIgHint").classList.toggle("hidden", !isIg);
    $("botTgHint").classList.toggle("hidden", isIg);
  }
  botPlatformChips.forEach((chip) => chip.addEventListener("click", () => selectBotPlatform(chip.dataset.v)));

  function botCard(bot) {
    const isIg = bot.platform === "instagram";
    const card = document.createElement("div");
    card.className = "rounded-xl border border-white/10 bg-slate-950/60 p-4";

    const head = document.createElement("div");
    head.className = "flex flex-wrap items-center justify-between gap-2";
    const title = document.createElement("span");
    title.className = "font-semibold";
    title.textContent = bot.name;
    const plat = document.createElement("span");
    plat.className = isIg
      ? "rounded-full bg-fuchsia-500/15 px-2.5 py-0.5 text-xs font-semibold text-fuchsia-300"
      : "rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs font-semibold text-sky-300";
    plat.textContent = isIg ? "Instagram Direct" : "Telegram";
    const badge = document.createElement("span");
    badge.className = bot.active
      ? "rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-300"
      : "rounded-full bg-slate-700 px-2.5 py-0.5 text-xs font-semibold text-slate-300";
    badge.textContent = bot.active ? "Отвечает клиентам" : "Остановлен";
    head.append(title, plat, badge);

    const meta = document.createElement("p");
    meta.className = "mt-1 text-xs text-slate-400";
    meta.textContent = "Роль: " + bot.role + " · тон: " + bot.tone + " · ответов сегодня: " + (bot.replies_today || 0);

    const hint = document.createElement("p");
    hint.className = "mt-1 text-xs " + (bot.active ? "text-emerald-400/80" : "text-slate-500");
    hint.textContent = bot.active
      ? isIg
        ? "Бот работает: отвечает клиентам в Direct Instagram круглосуточно."
        : "Бот работает: клики, вопросы и заявки принимает в Telegram круглосуточно."
      : isIg
        ? "Нажмите «Запустить» — и бот начнёт отвечать клиентам в Direct Instagram."
        : "Нажмите «Запустить» — и бот начнёт отвечать клиентам в Telegram.";

    const actions = document.createElement("div");
    actions.className = "mt-3 flex flex-wrap gap-2";
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500";
    toggleBtn.textContent = bot.active ? "Остановить" : "Запустить";
    toggleBtn.dataset.action = bot.active ? "pause" : "activate";
    toggleBtn.dataset.id = bot.id;
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "rounded-lg border border-rose-500/30 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10";
    deleteBtn.textContent = "Удалить";
    deleteBtn.dataset.action = "delete";
    deleteBtn.dataset.id = bot.id;
    actions.append(toggleBtn, deleteBtn);

    card.append(head, meta, hint, actions);
    return card;
  }

  async function loadBots() {
    try {
      const data = await api("/api/bots");
      const list = $("botList");
      list.innerHTML = "";
      if (!data.bots.length) {
        const p = document.createElement("p");
        p.className = "text-sm text-slate-400";
        p.textContent = "Ботов пока нет. Заполните форму выше — это займёт пару минут.";
        list.appendChild(p);
        return;
      }
      for (const bot of data.bots) list.appendChild(botCard(bot));
    } catch (err) {
      toast(err.message, "error");
    }
  }

  $("botForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const platform = $("botPlatform").value;
    const name = $("botName").value.trim();
    const role = $("botRole").value.trim();
    const tone = $("botTone").value;
    const knowledge = $("botKnowledge").value.trim();
    if (name.length < 2) return toast("Введите имя бота.", "error");
    if (role.length < 2) return toast("Выберите или напишите роль бота.", "error");
    if (knowledge.length < 10) return toast("Расскажите боту о бизнесе: минимум 10 символов.", "error");
    const btn = $("botBtn");
    btn.disabled = true;
    try {
      if (platform === "instagram") {
        const access_token = $("botIgToken").value.trim();
        const app_id = $("botIgAppId").value.trim();
        const app_secret = $("botIgSecret").value.trim();
        if (access_token.length < 20) return toast("Вставьте токен из кабинета Meta — 3 разрешения, инструкция в подсказке над формой.", "error");
        if (!app_id || !app_secret) return toast("Вставьте App ID и App Secret из настроек приложения Meta (Настройки приложения → Basic).", "error");
        btn.innerHTML = '<span class="spinner"></span>Подключаем Instagram…';
        await api("/api/bots/instagram", {
          method: "POST",
          body: { name, role, tone, knowledge, access_token, app_id, app_secret },
        });
        toast("Бот создан! Теперь нажмите «Запустить» в списке ниже.", "success");
      } else {
        const bot_token = $("botToken").value.trim();
        if (!bot_token) return toast("Вставьте токен бота, полученный у @BotFather.", "error");
        btn.innerHTML = '<span class="spinner"></span>Проверяем токен…';
        await api("/api/bots", {
          method: "POST",
          body: { name, role, tone, knowledge, bot_token },
        });
        toast("Бот создан! Теперь нажмите «Запустить» в списке ниже.", "success");
      }
      $("botForm").reset();
      document.querySelectorAll("#roleChips .chip").forEach((c) => c.classList.remove("active"));
      selectBotPlatform("telegram");
      loadBots();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Создать бота";
    }
  });

  $("botList").addEventListener("click", async (e) => {
    const btnEl = e.target.closest("button[data-action]");
    if (!btnEl) return;
    const id = btnEl.dataset.id;
    const action = btnEl.dataset.action;
    try {
      if (action === "activate") {
        btnEl.disabled = true;
        btnEl.innerHTML = '<span class="spinner"></span>Запускаем…';
        await api("/api/bots/" + id + "/activate", { method: "POST" });
        toast("Бот запущен! Напишите ему в Telegram и проверьте ответы.", "success");
        loadBots();
      } else if (action === "pause") {
        await api("/api/bots/" + id + "/pause", { method: "POST" });
        toast("Бот остановлен.", "success");
        loadBots();
      } else if (action === "delete") {
        if (!confirm("Удалить бота? Он перестанет отвечать клиентам.")) return;
        await api("/api/bots/" + id, { method: "DELETE" });
        toast("Бот удалён.", "success");
        loadBots();
      }
    } catch (err) {
      toast(err.message, "error");
      loadBots();
    }
  });

  // ===== Старт =====
  warmBackend();
  loadChannelSetup();
  loadChannels();
  loadMpAccounts();
  loadWbCards();
  loadBots();
})();
