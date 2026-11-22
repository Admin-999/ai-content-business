// ============ НАСТРОЙКА ПОСЛЕ ДЕПЛОЯ ============
// Backend работает на Supabase Edge Functions (функция "api").
// Публичный адрес: https://<project-ref>.supabase.co/functions/v1/api
// Фронтенд обращается к API_URL + "/api/...".
window.APP_CONFIG = {
  API_URL: "https://yapnxwamxmyobnffdhvu.supabase.co/functions/v1/api",

  // --- Прямая генерация в браузере через Pollinations ----------------------
  // Используется, когда серверная генерация недоступна или вернула ошибку.
  // Тогда текст и картинка создаются прямо в браузере, без сервера.
  POLLINATIONS: {
    // Ключевой API Pollinations (OpenAI-совместимый). Доступ к бесплатным моделям.
    BASE: "https://gen.pollinations.ai/v1",
    // Ключ хранится в замаскированном виде (base64, разбит на части) и
    // собирается в браузере при запуске страницы. Это защита от простого
    // копирования из исходников, а НЕ настоящая защита: в DevTools -> Network
    // ключ всё равно виден в запросах. Чтобы сменить ключ — замените части ниже.
    KEY_PARTS: [
      "c2tfVWlXUnNFTXBY",
      "UmowU3J3VEg4NWM2",
      "M3FkNFZFdHJ3Z3g=",
    ],
    // Модели по порядку: если одна недоступна, пробуем следующую.
    MODELS: [
      "openai/gpt-5.4-nano",
      "openai/gpt-5.5",
      "meta/llama-3.3-70b-instruct",
      "mistralai/mistral-large-3",
      "z-ai/glm-5.3-flash",
    ],
    // Резервный вариант без ключа (одна бесплатная модель, лимит 1 запрос/45 с).
    CLASSIC: "https://text.pollinations.ai/openai/chat/completions",

    // --- Картинки ---
    // С ключом — качественная модель без водяного знака (расходует бесплатный
    // Pollen: ~0.004 за картинку 1024x1024).
    IMAGE_KEYED: "https://gen.pollinations.ai/image/",
    IMAGE_MODEL: "z-image-turbo",
    // Резерв без ключа — работает всегда, но с водяным знаком pollinations.ai.
    IMAGE_FALLBACK: "https://image.pollinations.ai/prompt/",
  },
};

// Собираем ключ из частей KEY_PARTS (см. выше) в обычную строку KEY.
// Делается один раз при загрузке страницы.
(function () {
  var p = window.APP_CONFIG && window.APP_CONFIG.POLLINATIONS;
  if (!p || p.KEY) return;
  var parts = p.KEY_PARTS;
  if (!parts || !parts.length) return;
  try {
    p.KEY = atob(parts.join(""));
  } catch (e) {
    p.KEY = "";
  }
  try { delete p.KEY_PARTS; } catch (e) { p.KEY_PARTS = null; }
})();
