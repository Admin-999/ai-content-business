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
    KEY: "sk_UiWRsEMpXRj0SrwTH85c63qd4VEtrwgx",
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
