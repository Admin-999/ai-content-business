// Страница оплаты через СБП.
// Ссылки и реквизиты берутся из js/pay-config.js — код трогать не нужно.
(function () {
  "use strict";

  var cfg = window.PAY_CONFIG || {};
  var PLANS = {
    pro: { label: "PRO", amount: 299, days: 30, limit: "100 генераций в день" },
    pro_plus: { label: "PRO+", amount: 990, days: 30, limit: "300 генераций в день" },
  };

  var params = new URLSearchParams(location.search);
  var plan = params.get("plan") === "pro_plus" ? "pro_plus" : "pro";

  function $(id) { return document.getElementById(id); }
  function money(n) { return n.toLocaleString("ru-RU") + " ₽"; }

  function linkFor(p) {
    return String((cfg.links && cfg.links[p]) || "").trim();
  }
  function qrImageFor(p) {
    return String((cfg.qrImages && cfg.qrImages[p]) || "").trim();
  }

  // QR строим локально (js/vendor/qrcode.min.js), без внешних сервисов.
  function renderQr(link, imageUrl) {
    var box = $("payQr");
    var err = $("qrError");
    box.innerHTML = "";
    err.classList.add("hidden");

    if (imageUrl) {
      var img = document.createElement("img");
      img.alt = "QR-код для оплаты через СБП";
      img.className = "h-56 w-56";
      img.onerror = function () {
        img.remove();
        err.classList.remove("hidden");
      };
      img.src = imageUrl;
      box.appendChild(img);
      return;
    }

    if (!window.QRCode) {
      err.classList.remove("hidden");
      return;
    }
    try {
      new window.QRCode(box, {
        text: link,
        width: 224,
        height: 224,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: window.QRCode.CorrectLevel.M,
      });
    } catch (e) {
      err.classList.remove("hidden");
    }
  }

  function selectPlanCard() {
    document.querySelectorAll("[data-plan]").forEach(function (el) {
      var active = el.getAttribute("data-plan") === plan;
      el.setAttribute("aria-pressed", active ? "true" : "false");
      el.classList.toggle("border-indigo-500/60", active);
      el.classList.toggle("bg-indigo-500/10", active);
      el.classList.toggle("border-white/10", !active);
      el.classList.toggle("bg-slate-900/60", !active);
    });
  }

  function render() {
    var p = PLANS[plan];
    selectPlanCard();

    $("payAmount").textContent = money(p.amount);
    $("payPlanLabel").textContent = p.label + " · " + p.days + " дней · " + p.limit;

    var link = linkFor(plan);
    var ready = !!link;

    $("payReady").classList.toggle("hidden", !ready);
    $("payNotReady").classList.toggle("hidden", ready);

    if (ready) {
      var open = $("payOpen");
      open.href = link;
      // На телефоне открываем в этом же окне (чтобы сработал переход в приложение),
      // на компьютере — в новой вкладке, чтобы сайт остался под рукой.
      var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
      if (isMobile) {
        open.removeAttribute("target");
      } else {
        open.target = "_blank";
        open.rel = "noopener";
      }

      renderQr(link, qrImageFor(plan));

      // Запасной вариант по номеру телефона
      var phone = String(cfg.fallbackPhone || "").trim();
      var phoneBox = $("phoneFallback");
      if (phone) {
        $("phoneNumber").textContent = phone;
        $("phoneAmount").textContent = money(p.amount);
        phoneBox.classList.remove("hidden");
      } else {
        phoneBox.classList.add("hidden");
      }
    } else {
      var email = cfg.email || "savolovins@gmail.com";
      var subject = "Оплата тарифа " + p.label + " — AI Контент";
      var body =
        "Здравствуйте!\n\n" +
        "Хочу оплатить тариф " + p.label + " (" + money(p.amount) + ", " + p.days + " дней).\n" +
        "E-mail аккаунта: " + (localStorage.getItem("ac_email") || "") + "\n\n" +
        "Пришлите, пожалуйста, ссылку СБП на оплату.";
      $("payMail").href = "mailto:" + email +
        "?subject=" + encodeURIComponent(subject) +
        "&body=" + encodeURIComponent(body);
    }
  }

  // Показываем e-mail аккаунта, если пользователь вошёл
  var accountEmail = localStorage.getItem("ac_email");
  if (accountEmail) {
    $("payUserLine").classList.remove("hidden");
    $("payUserEmail").textContent = accountEmail;
  }

  document.querySelectorAll("[data-plan]").forEach(function (el) {
    el.addEventListener("click", function () {
      plan = el.getAttribute("data-plan") === "pro_plus" ? "pro_plus" : "pro";
      history.replaceState(null, "", "?plan=" + plan);
      render();
    });
  });

  $("copyLink").addEventListener("click", function () {
    var link = linkFor(plan);
    if (!link) return;
    copyText(link, $("copyHint"));
  });

  $("copyPhone").addEventListener("click", function () {
    var phone = String(cfg.fallbackPhone || "").trim();
    if (phone) copyText(phone, $("copyPhone"));
  });

  function copyText(text, feedbackEl) {
    function done(ok) {
      var old = feedbackEl.textContent;
      if (feedbackEl.id === "copyHint") {
        feedbackEl.textContent = ok ? "Скопировано" : "Не удалось скопировать";
        setTimeout(function () { feedbackEl.textContent = ""; }, 2500);
      } else {
        feedbackEl.textContent = ok ? "Скопировано" : "Не удалось";
        setTimeout(function () { feedbackEl.textContent = old; }, 2000);
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta);
      done(ok);
    }
  }

  render();
})();
