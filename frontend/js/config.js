// ============ НАСТРОЙКА ПОСЛЕ ДЕПЛОЯ ============
// Backend работает на Supabase Edge Functions (функция "api").
// Публичный адрес: https://<project-ref>.supabase.co/functions/v1/api
// Фронтенд обращается к API_URL + "/api/...".
window.APP_CONFIG = {
  API_URL: "https://yapnxwamxmyobnffdhvu.supabase.co/functions/v1/api"
};
