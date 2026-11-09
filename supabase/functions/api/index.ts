// ============================================================================
// AI Контент — API на Supabase Edge Functions.
//
// Заменяет Python-backend (FastAPI) для личного кабинета: вход/регистрация,
// лимиты тарифа, серверная история, генерация текста и управление
// Telegram-каналами (подключение, публикация «сейчас», вкл/выкл, удаление).
//
// Работает в той же базе Supabase (таблицы users/generations/channels/...),
// поэтому Python-backend и эта функция полностью совместимы: их можно
// запускать попеременно, данные одни и те же.
//
// Разворачивается через Supabase Management API (см. scripts/deploy_edge_api.ps1).
// Имя функции: api.  Публичный адрес:
//   https://<project-ref>.supabase.co/functions/v1/api
// ============================================================================

import postgres from "npm:postgres@3";
import bcrypt from "npm:bcryptjs@2";

// --- Конфигурация из переменных окружения функции ---------------------------
const DB_URL = Deno.env.get("SUPABASE_DB_URL") || "";
const SECRET_KEY = Deno.env.get("SECRET_KEY") || "dev-secret-change-me";
const TELEGRAM_BOT_TOKEN = (Deno.env.get("TELEGRAM_BOT_TOKEN") || "").trim();
const CRON_SECRET = (Deno.env.get("CRON_SECRET") || "").trim();
const LLM_BASE = (Deno.env.get("OPENAI_COMPAT_BASE_URL") || "").replace(/\/$/, "");
const LLM_KEY = Deno.env.get("OPENAI_COMPAT_API_KEY") || "";
const LLM_MODEL = Deno.env.get("OPENAI_COMPAT_MODEL") || "";

const TOKEN_TTL_DAYS = 7;
const LIMITS: Record<string, number> = { free: 5, pro: 100, pro_plus: 300 };
const PRO_PRICE_RUB = 299;
const PRO_PLUS_PRICE_RUB = 990;
const PRO_PERIOD_DAYS = 30;

const sql = postgres(DB_URL, {
  ssl: "require",
  prepare: false,
  max: 2,
  idle_timeout: 20,
  connect_timeout: 15,
});

// --- CORS -------------------------------------------------------------------
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, x-cron-secret, apikey",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function fail(status: number, detail: string): Response {
  return json({ detail }, status);
}

// --- Утилиты ----------------------------------------------------------------
const enc = new TextEncoder();

function uuid(): string {
  return crypto.randomUUID();
}

function now(): Date {
  return new Date();
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function dayStartUtc(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    enc.encode(SECRET_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function createToken(userId: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(enc.encode(JSON.stringify({
    sub: userId,
    iat,
    exp: iat + TOKEN_TTL_DAYS * 86400,
  })));
  const data = `${header}.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(data)));
  return `${data}.${b64url(sig)}`;
}

async function decodeToken(token: string): Promise<string> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("bad token");
  const data = `${parts[0]}.${parts[1]}`;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(), b64urlDecode(parts[2]), enc.encode(data));
  if (!ok) throw new Error("bad signature");
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error("expired");
  return payload.sub;
}

// --- Пользователи -----------------------------------------------------------
type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  plan: string;
  plan_expires_at: Date | null;
  created_at: Date | null;
};

async function ensureActivePlan(user: UserRow): Promise<UserRow> {
  if (user.plan !== "free" && user.plan_expires_at) {
    const exp = user.plan_expires_at instanceof Date ? user.plan_expires_at : new Date(user.plan_expires_at);
    if (exp.getTime() < Date.now()) {
      await sql`UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = ${user.id}`;
      return { ...user, plan: "free", plan_expires_at: null };
    }
  }
  return user;
}

async function currentUser(req: Request): Promise<UserRow | null> {
  const h = req.headers.get("authorization") || "";
  if (!h.toLowerCase().startsWith("bearer ")) return null;
  let uid: string;
  try {
    uid = await decodeToken(h.slice(7).trim());
  } catch {
    return null;
  }
  if (!uid) return null;
  const rows = await sql<UserRow[]>`
    SELECT id, email, password_hash, plan, plan_expires_at, created_at
    FROM users WHERE id = ${uid} LIMIT 1`;
  if (!rows.length) return null;
  return await ensureActivePlan(rows[0]);
}

async function usedToday(userId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM generations
    WHERE user_id = ${userId} AND created_at >= ${dayStartUtc()}`;
  return rows.length ? Number(rows[0].n) : 0;
}

function dailyLimit(plan: string): number {
  return LIMITS[plan] ?? LIMITS.free;
}

// --- Генерация текста -------------------------------------------------------
const GEN_TASKS: Record<string, string> = {
  post: "Напиши вовлекающий пост для социальных сетей на тему: «{topic}». " +
    "Объём 150–250 слов. Первый абзац должен цеплять внимание. " +
    "В конце добавь призыв к действию и 3–5 хештегов.",
  article: "Напиши статью для корпоративного блога на тему: «{topic}». " +
    "Объём 500–800 слов. Структура: цепляющий заголовок, вступление, " +
    "3–4 смысловых блока с подзаголовками, практические советы, короткий вывод.",
  product: "Напиши продающее описание товара для интернет-магазина: «{topic}». " +
    "Объём 150–300 слов. Структура: цепляющий заголовок, 3–5 ключевых выгод " +
    "списком, краткое описание, призыв к действию.",
};

function buildPrompt(topic: string, contentType: string, tone: string, language: string): string {
  const task = (GEN_TASKS[contentType] || GEN_TASKS.post).replace("{topic}", topic);
  const toneLine = tone ? `Тон текста: ${tone}.` : "";
  const langLine = language === "ru" ? "русском" : language === "en" ? "английском" : language;
  return "Ты — профессиональный коммерческий копирайтер с опытом 10 лет.\n" +
    `Задача: ${task}\n` +
    `${toneLine}\n` +
    `Напиши текст на ${langLine} языке.\n` +
    "В ответе выведи только готовый текст, без пояснений и служебных пометок.\n" +
    "Не используй Markdown-разметку (звёздочки, решётки, подчёркивания) — только чистый текст.";
}

async function generateContent(
  topic: string,
  contentType: string,
  tone: string,
  language: string,
): Promise<[string, string]> {
  if (!LLM_BASE || !LLM_MODEL) {
    throw new Error("Не настроен AI-провайдер.");
  }
  const resp = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LLM_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: "user", content: buildPrompt(topic, contentType, tone, language) }],
      temperature: 0.8,
      max_tokens: 2048,
    }),
  });
  if (!resp.ok) {
    throw new Error(
      resp.status === 429
        ? "AI-провайдер: превышен лимит запросов, попробуйте через минуту."
        : `AI-провайдер вернул ошибку ${resp.status}.`,
    );
  }
  const data = await resp.json().catch(() => null);
  const text = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("AI-провайдер вернул пустой ответ.");
  return [text, `compat:${LLM_MODEL}`];
}

// --- Telegram ---------------------------------------------------------------
async function tgCall(method: string, payload: Record<string, unknown>): Promise<any> {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("Бот сервиса не настроен.");
  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await resp.json().catch(() => null);
  if (!data || !data.ok) {
    throw new Error(`Telegram: ${data?.description || "неизвестная ошибка"}`);
  }
  return data.result;
}

function normChannel(name: string): string {
  let s = (name || "").trim();
  if (s.startsWith("https://t.me/")) s = s.slice("https://t.me/".length);
  if (s.startsWith("@")) s = s.slice(1);
  return s.split("/")[0].trim();
}

// ============================================================================
// Маршруты
// ============================================================================
type Ctx = { req: Request; method: string; path: string };
type Handler = (ctx: Ctx, m: RegExpMatchArray) => Promise<Response> | Response;

const routes: Array<{ method: string; re: RegExp; fn: Handler }> = [];
const route = (method: string, re: RegExp, fn: Handler) => routes.push({ method, re, fn });

// --- Служебные ---
route("GET", /^\/api\/health$/, () => json({ status: "ok" }));
route("GET", /^\/$/, () => json({ service: "AI Content API (Supabase Edge Functions)", status: "ok" }));

// --- Auth ---
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const AVATAR_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;

route("POST", /^\/api\/auth\/register$/, async (ctx) => {
  const body = await ctx.req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!EMAIL_RE.test(email)) return fail(422, "Введите корректный email.");
  if (password.length < 8) return fail(422, "Пароль должен содержать минимум 8 символов.");
  if (password.length > 64) return fail(422, "Пароль слишком длинный: максимум 64 символа.");
  const exists = await sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
  if (exists.length) return fail(409, "Пользователь с таким email уже зарегистрирован.");

  const uid = uuid();
  const hash = bcrypt.hashSync(password, bcrypt.genSaltSync(10));
  await sql`INSERT INTO users (id, email, password_hash, plan, created_at)
            VALUES (${uid}, ${email}, ${hash}, 'free', ${now()})`;
  return json({
    token: await createToken(uid),
    email,
    plan: "free",
    message: "Аккаунт создан. Доступно 5 бесплатных генераций в день.",
  });
});

route("POST", /^\/api\/auth\/login$/, async (ctx) => {
  const body = await ctx.req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const rows = await sql<UserRow[]>`
    SELECT id, email, password_hash, plan, plan_expires_at, created_at
    FROM users WHERE email = ${email} LIMIT 1`;
  if (!rows.length || !bcrypt.compareSync(password, rows[0].password_hash || "")) {
    return fail(401, "Неверный email или пароль.");
  }
  const user = await ensureActivePlan(rows[0]);
  return json({ token: await createToken(user.id), email: user.email, plan: user.plan });
});

route("GET", /^\/api\/auth\/me$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  return json({
    id: user.id,
    email: user.email,
    plan: user.plan,
    plan_expires_at: iso(user.plan_expires_at),
  });
});

route("GET", /^\/api\/auth\/profile$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const rows = await sql<{ name: string | null; avatar: string | null }[]>`
    SELECT name, avatar FROM users WHERE id = ${user.id} LIMIT 1`;
  return json({
    email: user.email,
    name: rows.length ? rows[0].name : null,
    avatar: rows.length ? rows[0].avatar : null,
  });
});

route("PATCH", /^\/api\/auth\/profile$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const body = await ctx.req.json().catch(() => ({}));
  const rows = await sql<{ name: string | null; avatar: string | null }[]>`
    SELECT name, avatar FROM users WHERE id = ${user.id} LIMIT 1`;
  let name = rows.length ? rows[0].name : null;
  let avatar = rows.length ? rows[0].avatar : null;

  if (body.name !== undefined && body.name !== null) {
    name = String(body.name).trim() || null;
  }
  if (body.avatar !== undefined && body.avatar !== null) {
    avatar = String(body.avatar) || null;
    if (avatar) {
      if (avatar.length > 500_000) return fail(422, "Файл аватара слишком большой. Выберите изображение поменьше.");
      if (!AVATAR_RE.test(avatar)) return fail(422, "Аватар должен быть изображением PNG, JPEG или WebP.");
    }
  }
  await sql`UPDATE users SET name = ${name}, avatar = ${avatar} WHERE id = ${user.id}`;
  return json({ email: user.email, name, avatar, message: "Профиль сохранён." });
});

// --- Лимиты и история ---
route("GET", /^\/api\/usage$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const used = await usedToday(user.id);
  const limit = dailyLimit(user.plan);
  const totalRows = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM generations WHERE user_id = ${user.id}`;
  return json({
    plan: user.plan,
    plan_expires_at: iso(user.plan_expires_at),
    used_today: used,
    limit,
    remaining: Math.max(limit - used, 0),
    total_generated: totalRows.length ? Number(totalRows[0].n) : 0,
  });
});

route("GET", /^\/api\/history$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const url = new URL(ctx.req.url);
  let limit = parseInt(url.searchParams.get("limit") || "20", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  if (limit > 50) limit = 50;
  const rows = await sql<
    { id: string; topic: string; content_type: string; result: string; model: string | null; created_at: Date | null }[]
  >`SELECT id, topic, content_type, result, model, created_at FROM generations
    WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT ${limit}`;
  return json({
    items: rows.map((r) => ({
      id: r.id,
      topic: r.topic,
      content_type: r.content_type,
      result: r.result,
      model: r.model,
      created_at: iso(r.created_at),
    })),
  });
});

// --- Генерация ---
route("POST", /^\/api\/generate$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const body = await ctx.req.json().catch(() => ({}));
  const topic = String(body.topic || "").trim();
  const contentType = String(body.content_type || "post");
  const tone = String(body.tone || "дружелюбный");
  const language = String(body.language || "ru");
  if (topic.length < 3) return fail(422, "Опишите тему подробнее: минимум 3 символа.");
  if (!["post", "article", "product"].includes(contentType)) {
    return fail(422, "Неизвестный тип контента. Доступно: post, article, product.");
  }

  const limit = dailyLimit(user.plan);
  let used = await usedToday(user.id);
  if (used >= limit) {
    return fail(429,
      `Достигнут дневной лимит: ${used} из ${limit} генераций. Лимит обновится в 00:00 UTC` +
      (user.plan === "free" ? " — или оформите тариф PRO или PRO+." : "."));
  }

  let text: string, model: string;
  try {
    [text, model] = await generateContent(topic, contentType, tone, language);
  } catch (e) {
    return fail(502, `Сервис генерации временно недоступен, попробуйте ещё раз через минуту. (${e})`);
  }

  const gid = uuid();
  await sql`INSERT INTO generations (id, user_id, topic, content_type, tone, language, result, model, created_at)
            VALUES (${gid}, ${user.id}, ${topic}, ${contentType}, ${tone}, ${language}, ${text}, ${model}, ${now()})`;
  used += 1;
  return json({
    id: gid,
    content: text,
    model,
    used_today: used,
    limit,
    remaining: Math.max(limit - used, 0),
  });
});

// --- Оплата (тестовый режим, как и в Python-backend) ---
route("POST", /^\/api\/subscribe$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const body = await ctx.req.json().catch(() => ({}));
  const plan = String(body.plan || "pro");
  if (!["pro", "pro_plus"].includes(plan)) return fail(422, "Доступны тарифы 'pro' и 'pro_plus'.");
  const price = plan === "pro" ? PRO_PRICE_RUB : PRO_PLUS_PRICE_RUB;
  const limit = plan === "pro" ? LIMITS.pro : LIMITS.pro_plus;
  const started = now();
  const expires = new Date(started.getTime() + PRO_PERIOD_DAYS * 86400_000);
  const paymentRef = `TEST-${uuid().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  await sql`INSERT INTO subscriptions (id, user_id, plan, status, amount_rub, payment_ref, started_at, expires_at)
            VALUES (${uuid()}, ${user.id}, ${plan}, 'active', ${price}, ${paymentRef}, ${started}, ${expires})`;
  await sql`UPDATE users SET plan = ${plan}, plan_expires_at = ${expires} WHERE id = ${user.id}`;
  const title = plan === "pro" ? "PRO" : "PRO+";
  return json({
    status: "active",
    plan,
    price_rub: price,
    daily_limit: limit,
    expires_at: iso(expires),
    payment_ref: paymentRef,
    message: `Тариф ${title} активирован (тестовый режим, деньги не списаны). Лимит: ${limit} генераций в день.`,
  });
});

route("GET", /^\/api\/subscription$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const rows = await sql<
    { plan: string; status: string; amount_rub: number | null; payment_ref: string | null; started_at: Date | null; expires_at: Date | null }[]
  >`SELECT plan, status, amount_rub, payment_ref, started_at, expires_at FROM subscriptions
    WHERE user_id = ${user.id} ORDER BY started_at DESC LIMIT 1`;
  const r = rows[0];
  return json({
    current_plan: user.plan,
    plan_expires_at: iso(user.plan_expires_at),
    last_payment: !r ? null : {
      plan: r.plan,
      status: r.status,
      amount_rub: r.amount_rub,
      payment_ref: r.payment_ref,
      started_at: iso(r.started_at),
      expires_at: iso(r.expires_at),
    },
  });
});

// --- Telegram-каналы ---
const CHANNEL_COLS = `id, title, description, channel_username, tone, interval_hours, active,
  last_post_at, created_at, platform, ig_username, token_expires_at`;

type ChannelRow = {
  id: string; title: string; description: string; channel_username: string; tone: string;
  interval_hours: number; active: number; last_post_at: Date | null; created_at: Date | null;
  platform: string | null; ig_username: string | null; token_expires_at: Date | null;
};

function rowToChannel(r: ChannelRow) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    channel_username: r.channel_username,
    tone: r.tone,
    interval_hours: r.interval_hours,
    active: !!r.active,
    last_post_at: iso(r.last_post_at),
    created_at: iso(r.created_at),
    platform: r.platform || "telegram",
    ig_username: r.ig_username,
    token_expires_at: iso(r.token_expires_at),
  };
}

async function logPost(channelId: string, userId: string, text: string, status: string, error: string | null) {
  await sql`INSERT INTO channel_posts (id, channel_id, user_id, text, status, error, created_at)
            VALUES (${uuid()}, ${channelId}, ${userId}, ${text}, ${status}, ${error}, ${now()})`;
}

route("GET", /^\/api\/channels\/setup$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  if (!TELEGRAM_BOT_TOKEN) return json({ ready: false, bot_username: null });
  try {
    const me = await tgCall("getMe", {});
    return json({ ready: true, bot_username: me?.username || null });
  } catch {
    return json({ ready: false, bot_username: null });
  }
});

// Instagram требует хранения PNG-карточек на диске backend — на Edge Functions недоступно.
route("POST", /^\/api\/channels\/instagram$/, () =>
  fail(503, "Подключение Instagram сейчас недоступно: перенос картинок-карточек на новый backend ещё не завершён. Telegram-каналы работают полностью."));

route("POST", /^\/api\/channels$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const body = await ctx.req.json().catch(() => ({}));
  const title = String(body.title || "").trim();
  const description = String(body.description || "").trim();
  const tone = String(body.tone || "дружелюбный");
  const interval = parseInt(body.interval_hours ?? 12, 10);
  const username = normChannel(String(body.channel_username || ""));

  if (title.length < 2) return fail(422, "Введите название канала.");
  if (description.length < 10) return fail(422, "Опишите канал подробнее: минимум 10 символов.");
  if (!username) return fail(422, "Укажите адрес канала: @my_channel или https://t.me/my_channel");
  if (![6, 12, 24].includes(interval)) return fail(422, "Интервал постинга: 6, 12 или 24 часа.");
  if (!TELEGRAM_BOT_TOKEN) {
    return fail(503, "Автопостинг подключается: администратор сервиса регистрирует бота. Попробуйте чуть позже.");
  }

  let me: any;
  try {
    me = await tgCall("getMe", {});
  } catch (e) {
    return fail(502, `Бот сервиса недоступен: ${e}`);
  }
  const botUsername = me?.username || "бота сервиса";

  let status: string | null = null;
  try {
    const member = await tgCall("getChatMember", {
      chat_id: username.startsWith("-") ? username : `@${username}`,
      user_id: me?.id,
    });
    status = member?.status ?? null;
  } catch {
    status = null;
  }
  if (status !== "administrator" && status !== "creator") {
    return fail(422,
      `Бот сервиса ещё не администратор канала @${username}. ` +
      `Откройте канал → Администраторы → добавьте @${botUsername} администратором ` +
      "с правом публикации сообщений — и нажмите кнопку ещё раз.");
  }

  const cid = uuid();
  await sql`INSERT INTO channels (id, user_id, title, description, bot_token, channel_username,
              tone, interval_hours, active, last_post_at, created_at, platform)
            VALUES (${cid}, ${user.id}, ${title}, ${description}, '', ${username},
              ${tone}, ${interval}, 1, NULL, ${now()}, 'telegram')`;
  return json({ id: cid, bot_username: botUsername, status: "created" });
});

route("GET", /^\/api\/channels$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const rows = await sql<ChannelRow[]>`
    SELECT ${sql.unsafe(CHANNEL_COLS)} FROM channels
    WHERE user_id = ${user.id} ORDER BY created_at DESC`;
  const channels = [];
  for (const r of rows) {
    const stat = await sql<{ total: number; sent: number }[]>`
      SELECT COUNT(*)::int AS total,
             COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0)::int AS sent
      FROM channel_posts WHERE channel_id = ${r.id}`;
    const ch = rowToChannel(r) as Record<string, unknown>;
    ch.posts_total = stat.length ? Number(stat[0].total) : 0;
    ch.posts_sent = stat.length ? Number(stat[0].sent) : 0;
    channels.push(ch);
  }
  return json({ channels });
});

route("GET", /^\/api\/channels\/([^/]+)\/posts$/, async (ctx, m) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const cid = m[1];
  const own = await sql`SELECT id FROM channels WHERE id = ${cid} AND user_id = ${user.id} LIMIT 1`;
  if (!own.length) return fail(404, "Канал не найден.");
  const posts = await sql<
    { id: string; text: string; status: string; error: string | null; created_at: Date | null }[]
  >`SELECT id, text, status, error, created_at FROM channel_posts
    WHERE channel_id = ${cid} ORDER BY created_at DESC LIMIT 10`;
  return json({
    posts: posts.map((p) => ({
      id: p.id,
      text: p.text,
      status: p.status,
      error: p.error,
      created_at: iso(p.created_at),
    })),
  });
});

route("POST", /^\/api\/channels\/([^/]+)\/toggle$/, async (ctx, m) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const cid = m[1];
  const rows = await sql<{ active: number }[]>`
    SELECT active FROM channels WHERE id = ${cid} AND user_id = ${user.id} LIMIT 1`;
  if (!rows.length) return fail(404, "Канал не найден.");
  const next = rows[0].active ? 0 : 1;
  await sql`UPDATE channels SET active = ${next} WHERE id = ${cid}`;
  return json({ id: cid, active: !!next });
});

route("DELETE", /^\/api\/channels\/([^/]+)$/, async (ctx, m) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const cid = m[1];
  const rows = await sql`SELECT id FROM channels WHERE id = ${cid} AND user_id = ${user.id} LIMIT 1`;
  if (!rows.length) return fail(404, "Канал не найден.");
  await sql`DELETE FROM channel_posts WHERE channel_id = ${cid}`;
  await sql`DELETE FROM channels WHERE id = ${cid}`;
  return json({ status: "deleted" });
});

// Публикация одного поста в канал. Возвращает {status, text, error}.
async function publishOnce(
  channelId: string, userId: string, title: string, description: string, tone: string,
  username: string,
): Promise<{ status: string; text: string; error: string | null }> {
  if (!TELEGRAM_BOT_TOKEN) {
    return { status: "failed", text: "", error: "Автопостинг в Telegram недоступен: администратор сервиса не настроил бота." };
  }
  let text: string, model: string;
  try {
    const subject = `Пост для Telegram-канала «${title}». О чём канал: ${description}`;
    [text, model] = await generateContent(subject, "post", tone, "ru");
  } catch (e) {
    return { status: "failed", text: "", error: String(e) };
  }
  try {
    const chat = username.replace(/^@/, "");
    await tgCall("sendMessage", {
      chat_id: /^-?\d+$/.test(chat) ? chat : `@${chat}`,
      text: text.slice(0, 4000),
      disable_web_page_preview: true,
    });
  } catch (e) {
    return { status: "failed", text, error: String(e) };
  }
  await sql`UPDATE channels SET last_post_at = ${now()} WHERE id = ${channelId}`;
  await sql`INSERT INTO generations (id, user_id, topic, content_type, tone, language, result, model, created_at)
            VALUES (${uuid()}, ${userId}, ${"Автопостинг: " + title}, 'post', ${tone}, 'ru', ${text}, ${model}, ${now()})`;
  return { status: "sent", text, error: null };
}

route("POST", /^\/api\/channels\/([^/]+)\/publish$/, async (ctx, m) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const cid = m[1];
  const rows = await sql<{ id: string; title: string; description: string; tone: string; channel_username: string }[]>`
    SELECT id, title, description, tone, channel_username FROM channels
    WHERE id = ${cid} AND user_id = ${user.id} LIMIT 1`;
  if (!rows.length) return fail(404, "Канал не найден.");
  const ch = rows[0];

  const limit = dailyLimit(user.plan);
  const used = await usedToday(user.id);
  if (used >= limit) {
    return fail(429, `Дневной лимит генераций исчерпан (${used} из ${limit}). Обновите тариф или попробуйте завтра.`);
  }

  const res = await publishOnce(cid, user.id, ch.title, ch.description, ch.tone, ch.channel_username);
  await logPost(cid, user.id, res.text, res.status, res.error);
  if (res.status !== "sent") return fail(502, res.error || "Не удалось опубликовать пост.");
  const usedAfter = await usedToday(user.id);
  return json({ status: "sent", text: res.text, remaining: Math.max(0, limit - usedAfter) });
});

// --- Автопостинг по расписанию (Telegram). Запускается внешним cron-секретом. ---
route("POST", /^\/api\/cron\/autopost$/, async (ctx) => {
  const secret = ctx.req.headers.get("x-cron-secret") || "";
  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return fail(403, "Недействительный секрет cron-задачи.");
  }
  const ts = now();
  const rows = await sql<
    { id: string; user_id: string; title: string; description: string; tone: string; interval_hours: number;
      channel_username: string; last_post_at: Date | null; plan: string }[]
  >`SELECT c.id, c.user_id, c.title, c.description, c.tone, c.interval_hours,
           c.channel_username, c.last_post_at, u.plan
    FROM channels c JOIN users u ON u.id = c.user_id
    WHERE c.active = 1 AND COALESCE(c.platform, 'telegram') = 'telegram'`;
  let sent = 0, failed = 0, skipped = 0;
  for (const r of rows) {
    const last = r.last_post_at ? new Date(r.last_post_at) : null;
    if (last && (ts.getTime() - last.getTime()) / 1000 < r.interval_hours * 3600 - 600) { skipped++; continue; }
    if (await usedToday(r.user_id) >= dailyLimit(r.plan)) { skipped++; continue; }
    const res = await publishOnce(r.id, r.user_id, r.title, r.description, r.tone, r.channel_username);
    await logPost(r.id, r.user_id, res.text, res.status, res.error);
    if (res.status === "sent") sent++; else failed++;
  }
  return json({ status: "ok", checked: rows.length, sent, failed, skipped });
});

// ============================================================================
// Диспетчер
// ============================================================================
// Гейтвей может отдавать путь в разных видах:
//   /functions/v1/api/api/health   (полный путь)
//   /api/api/health                (без /functions/v1, но со слагом «api»)
//   /api/health                    (уже без слаг-префикса)
// Поэтому пробуем несколько кандидатов и берём первый, который совпал с маршрутом.
function candidatePaths(pathname: string): string[] {
  const cands: string[] = [pathname];
  for (const marker of ["/functions/v1/api", "/api"]) {
    if (pathname.startsWith(marker)) {
      let rest = pathname.slice(marker.length);
      if (!rest.startsWith("/")) rest = "/" + rest;
      if (rest && !cands.includes(rest)) cands.push(rest);
    }
  }
  return cands;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const cands = candidatePaths(url.pathname);

  for (const path of cands) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = path.match(r.re);
      if (!m) continue;
      try {
        return await r.fn({ req, method, path }, m);
      } catch (e) {
        console.error("Ошибка обработки", method, path, String(e));
        return fail(500, "Внутренняя ошибка сервера. Попробуйте позже.");
      }
    }
  }
  return fail(404, `Не найдено: ${method} ${url.pathname}`);
});
