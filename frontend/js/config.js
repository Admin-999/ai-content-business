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
    // --- Служебные данные сборки ключа (обфускация) ------------------------
    // Ключ не хранится открытым текстом: это зашифрованные байты (z),
    // карта их расстановки (o), две половины семени (a, b) и контрольная
    // сумма (h). Ключ собирается в памяти по первому обращению и кешируется.
    // Это защита от копирования из исходников, а НЕ пароль: в DevTools ->
    // Network ключ виден в запросах. Чтобы сменить ключ, запустите
    // scripts/mask_key.py --key <новый_ключ>.
    _v: {
      a: 820097354,
      b: 153342911,
      h: 3485256925,
      o: [
        30, 3, 27, 0, 20, 6, 29, 10, 28, 4, 26, 19, 12, 11,
        34, 9, 16, 22, 31, 8, 2, 18, 25, 14, 5, 13, 7, 24,
        33, 21, 23, 1, 15, 17, 32,
      ],
      z: [
        46, 169, 115, 181, 28, 11, 240, 59, 36, 253, 207, 125, 111, 246,
        54, 120, 207, 201, 89, 195, 138, 117, 164, 213, 101, 215, 238, 168,
        79, 51, 246, 239, 8, 4, 38,
      ],
    },
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


// Сборка ключа из служебного блока _v (см. выше). Ключ вычисляется ЛЕНИВО —
// при первом обращении к POLLINATIONS.KEY — и сразу кешируется как строка.
// Проверяется контрольная сумма; при несовпадении ключ считается невалидным.
(function () {
  var p = window.APP_CONFIG && window.APP_CONFIG.POLLINATIONS;
  if (!p || p.KEY) return;
  var v = p._v;
  if (!v || !v.z || !v.z.length) return;

  function step(x) {
    x ^= (x << 13) & 0xffffffff;
    x ^= (x >>> 17);
    x ^= (x << 5) & 0xffffffff;
    return x >>> 0;
  }

  function assemble() {
    var n = v.z.length;
    var seed = (v.a ^ v.b) >>> 0;
    var c = new Array(n);
    var i, st;
    st = seed;
    for (i = 0; i < n; i++) { st = step(st); c[v.o[i]] = v.z[i]; }
    var k = new Array(n);
    st = seed;
    for (i = 0; i < n; i++) { st = step(st); k[i] = c[i] ^ ((st >>> 24) & 0xff); }
    var h = 2166136261;
    for (i = 0; i < n; i++) { h ^= k[i]; h = Math.imul(h, 16777619) >>> 0; }
    if (h !== (v.h >>> 0)) return "";
    var s = "";
    for (i = 0; i < n; i++) s += String.fromCharCode(k[i]);
    return s;
  }

  Object.defineProperty(p, "KEY", {
    configurable: true,
    enumerable: true,
    get: function () {
      var value = assemble();
      Object.defineProperty(p, "KEY", {
        value: value, writable: false, enumerable: true, configurable: true,
      });
      return value;
    },
  });
})();
