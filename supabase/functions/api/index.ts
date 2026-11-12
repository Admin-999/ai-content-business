// ============================================================================
// AI Контент — API на Supabase Edge Functions.
//
// Заменяет Python-backend (FastAPI) для личного кабинета: вход/регистрация,
// лимиты тарифа, серверная история, генерация текста, управление каналами
// (Telegram + Instagram), карточками маркетплейсов (Wildberries, Ozon,
// AliExpress, Яндекс Маркет) и ИИ-ботами (Telegram + Instagram Direct).
//
// Работает в той же базе Supabase (таблицы users/generations/channels/...),
// поэтому Python-backend и эта функция полностью совместимы.
//
// Разворачивается через Supabase Management API (см. scripts/deploy_edge_api.ps1).
// Имя функции: api.  Публичный адрес:
//   https://<project-ref>.supabase.co/functions/v1/api
// ============================================================================

import postgres from "npm:postgres@3";
import bcrypt from "npm:bcryptjs@2";
import satori from "npm:satori@0.10.13";
import { initWasm, Resvg } from "npm:@resvg/resvg-wasm@2.6.2";
import jpeg from "npm:jpeg-js@0.4.4";
import UPNG from "npm:upng-js@2.1.0";
import md5 from "npm:blueimp-md5@2.19.0";

// --- Конфигурация из переменных окружения функции ---------------------------
const DB_URL = Deno.env.get("SUPABASE_DB_URL") || "";
const SECRET_KEY = Deno.env.get("SECRET_KEY") || "dev-secret-change-me";
const TELEGRAM_BOT_TOKEN = (Deno.env.get("TELEGRAM_BOT_TOKEN") || "").trim();
const CRON_SECRET = (Deno.env.get("CRON_SECRET") || "").trim();
const LLM_BASE = (Deno.env.get("OPENAI_COMPAT_BASE_URL") || "").replace(/\/$/, "");
const LLM_KEY = Deno.env.get("OPENAI_COMPAT_API_KEY") || "";
const LLM_MODEL = Deno.env.get("OPENAI_COMPAT_MODEL") || "";
// Vision (анализ фото товара). Работает любой из бесплатных провайдеров с ключом:
//   * Google Gemini           — GEMINI_API_KEY (модель GEMINI_MODEL)
//   * Groq                    — GROQ_API_KEY (модель GROQ_VISION_MODEL)
//   * OpenAI-совместимый      — VISION_BASE_URL / VISION_API_KEY / VISION_MODEL
const GEMINI_API_KEY = (Deno.env.get("GEMINI_API_KEY") || "").trim();
const GEMINI_MODEL = (Deno.env.get("GEMINI_MODEL") || "gemini-2.0-flash").trim();
const GROQ_API_KEY = (Deno.env.get("GROQ_API_KEY") || "").trim();
const GROQ_VISION_MODEL = (Deno.env.get("GROQ_VISION_MODEL") || "meta-llama/llama-4-scout-17b-16e-instruct").trim();
const VISION_BASE = (Deno.env.get("VISION_BASE_URL") || "").replace(/\/$/, "");
const VISION_KEY = Deno.env.get("VISION_API_KEY") || "";
const VISION_MODEL = (Deno.env.get("VISION_MODEL") || "").trim();

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
// Публичный адрес этой же функции: по нему Telegram шлёт обновления ИИ-ботов,
// а Instagram скачивает картинки-карточки постов (Instagram API v23).
const BACKEND_URL = `${SUPABASE_URL}/functions/v1/api`;

const TOKEN_TTL_DAYS = 7;
const LIMITS: Record<string, number> = { free: 5, pro: 100, pro_plus: 300 };
const PRO_PRICE_RUB = 299;
const PRO_PLUS_PRICE_RUB = 990;
const PRO_PERIOD_DAYS = 30;
const BOT_DAILY_REPLY_LIMIT = 200;

// Маркетплейсы
const WB_CONTENT_API = "https://content-api.wildberries.ru";
const CMP_UPLOAD_URL = "https://cmp.wildberries.ru/cmp/uploadApiPhoto";
const OZON_API = "https://api-seller.ozon.ru";
const YM_API = "https://api.partner.market.yandex.ru";
const ALIEXPRESS_GATEWAY = "https://api-sg.aliexpress.com/sync";
const PHOTO_MIME: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const PHOTO_MAX = 8 * 1024 * 1024;
const OZON_TREE_TTL = 7 * 24 * 3600 * 1000;

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
  "Access-Control-Allow-Headers": "authorization, content-type, x-cron-secret, x-telegram-bot-api-secret-token, apikey",
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

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
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

// --- AI: генерация текста ---------------------------------------------------
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

async function llmComplete(prompt: string, temperature = 0.8, maxTokens = 4096): Promise<[string, string]> {
  if (!LLM_BASE || !LLM_MODEL) {
    throw new Error("Не настроен AI-провайдер.");
  }
  const resp = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LLM_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature,
      max_tokens: maxTokens,
      // Не даём модели тратить весь лимит на «размышления» — иначе она
      // возвращает ошибку output_token_limit_exceeded на длинных запросах.
      reasoning_effort: "low",
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

async function runPrompt(prompt: string): Promise<[string, string]> {
  return await llmComplete(prompt);
}

async function chatText(system: string, user: string): Promise<[string, string]> {
  return await runPrompt(`${system}\n\nСообщение клиента: ${user}`);
}

async function generateContent(
  topic: string,
  contentType: string,
  tone: string,
  language: string,
): Promise<[string, string]> {
  return await llmComplete(buildPrompt(topic, contentType, tone, language));
}

// Распознавание фото товара (vision). Пробует провайдеров по очереди и
// возвращает [описание, метка_модели] либо null, если ни один не настроен/не
// ответил. Карточка при этом всё равно строится — по названию и цене.
function geminiText(data: any): string {
  const candidates = data?.candidates || [];
  const parts = candidates.length ? (candidates[0]?.content?.parts || []) : [];
  return parts.map((p: any) => String(p?.text || "")).join("").trim();
}

async function describeImage(imageBytes: Uint8Array, mime: string, prompt: string): Promise<[string, string] | null> {
  const b64 = bytesToBase64(imageBytes);
  const attempts: Array<[string, () => Promise<string>]> = [];

  if (GEMINI_API_KEY) {
    attempts.push([`gemini:${GEMINI_MODEL}`, async () => {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: prompt },
              { inline_data: { mime_type: mime, data: b64 } },
            ] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
          }),
        },
      );
      if (!resp.ok) throw new Error(`Gemini ${resp.status}`);
      const data = await resp.json().catch(() => null);
      return geminiText(data);
    }]);
  }

  if (GROQ_API_KEY) {
    attempts.push([`groq:${GROQ_VISION_MODEL}`, async () => {
      const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({
          model: GROQ_VISION_MODEL,
          messages: [{ role: "user", content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          ] }],
          temperature: 0.4,
          max_tokens: 2048,
        }),
      });
      if (!resp.ok) throw new Error(`Groq ${resp.status}`);
      const data = await resp.json().catch(() => null);
      return String(data?.choices?.[0]?.message?.content || "").trim();
    }]);
  }

  if (VISION_BASE && VISION_MODEL) {
    attempts.push([`vision:${VISION_MODEL}`, async () => {
      const resp = await fetch(`${VISION_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${VISION_KEY}` },
        body: JSON.stringify({
          model: VISION_MODEL,
          messages: [{ role: "user", content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          ] }],
          temperature: 0.4,
          max_tokens: 2048,
        }),
      });
      if (!resp.ok) throw new Error(`Vision ${resp.status}`);
      const data = await resp.json().catch(() => null);
      return String(data?.choices?.[0]?.message?.content || "").trim();
    }]);
  }

  for (const [label, call] of attempts) {
    try {
      const text = await call();
      if (text) return [text, label];
    } catch {
      // провайдер недоступен — пробуем следующего
    }
  }
  return null;
}

// --- Генерация картинок (бесплатный Pollinations, ключ не нужен) -------------
function imagePrompt(topic: string, contentType: string): string {
  const style = contentType === "product"
    ? "professional product photo, clean bright background, studio lighting, high detail, centered"
    : "bright modern illustration, high quality, detailed";
  return `${topic}. ${style}, no watermark, no text, no letters`;
}

// Генерирует картинку по тексту и сохраняет её в хранилище. Возвращает байты,
// mime и публичный URL — либо null, если генератор недоступен (не роняем запрос).
async function generateImageBytes(
  prompt: string,
  width = 1024,
  height = 1024,
): Promise<{ bytes: Uint8Array; mime: string; url: string } | null> {
  try {
    const seed = Math.floor(Math.random() * 1_000_000_000);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
      `?width=${width}&height=${height}&nologo=true&seed=${seed}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.length < 1024) return null;
    const stored = await savePhoto(bytes, "image/jpeg");
    return { bytes, mime: "image/jpeg", url: stored };
  } catch {
    return null;
  }
}

async function generateImage(prompt: string, width = 1024, height = 1024): Promise<string | null> {
  const res = await generateImageBytes(prompt, width, height);
  return res ? res.url : null;
}

// --- Supabase Storage -------------------------------------------------------
async function storageUpload(path: string, bytes: Uint8Array, contentType: string): Promise<string> {
  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/media/${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SERVICE_ROLE}`,
      "Content-Type": contentType,
      "x-upsert": "true",
      "cache-control": "3600",
    },
    body: bytes,
  });
  if (!resp.ok) {
    throw new Error(`Не удалось сохранить файл в хранилище (${resp.status}).`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/media/${path}`;
}

// --- Telegram ---------------------------------------------------------------
class TelegramError extends Error {}

async function tgApi(token: string, method: string, payload: Record<string, unknown> = {}): Promise<any> {
  if (!token) throw new TelegramError("Не задан токен бота.");
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await resp.json().catch(() => null);
  if (!data || !data.ok) {
    throw new TelegramError(`Telegram: ${data?.description || `ошибка ${resp.status}`}`);
  }
  return data.result;
}

async function tgCall(method: string, payload: Record<string, unknown>): Promise<any> {
  if (!TELEGRAM_BOT_TOKEN) throw new TelegramError("Бот сервиса не настроен.");
  return await tgApi(TELEGRAM_BOT_TOKEN, method, payload);
}

function normChannel(name: string): string {
  let s = (name || "").trim();
  if (s.startsWith("https://t.me/")) s = s.slice("https://t.me/".length);
  if (s.startsWith("@")) s = s.slice(1);
  return s.split("/")[0].trim();
}

// --- Instagram Graph API (Instagram API with Instagram Login) ---------------
const IG_BASE = "https://graph.instagram.com";
const IG_VERSION = "v23.0";
const IG_MEDIA_WAIT_TRIES = 15;
const IG_MEDIA_WAIT_STEP = 2000;

class InstagramError extends Error {}

async function igRequest(
  method: string,
  url: string,
  opts: { params?: Record<string, string>; data?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
): Promise<any> {
  const u = new URL(url);
  if (opts.params) for (const [k, v] of Object.entries(opts.params)) u.searchParams.set(k, v);
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  let body: BodyInit | undefined;
  if (opts.data) {
    body = new URLSearchParams(opts.data);
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }
  let resp: Response;
  try {
    resp = await fetch(u.toString(), { method, headers, body });
  } catch (e) {
    throw new InstagramError(`Instagram недоступен: ${e}`);
  }
  const text = await resp.text();
  if (resp.status !== 200) {
    let msg = text.slice(0, 200);
    let code: number | undefined;
    try {
      const err = JSON.parse(text).error || {};
      msg = err.message || msg;
      code = err.code;
    } catch { /* not json */ }
    if (code === 190) {
      msg += " Токен истёк — сгенерируйте новый в кабинете Meta и подключите аккаунт заново.";
    }
    throw new InstagramError(`Instagram: ${msg}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InstagramError("Instagram вернул нечитаемый ответ");
  }
}

async function igExchangeToken(shortToken: string, clientSecret: string): Promise<[string, number]> {
  const data = await igRequest("GET", `${IG_BASE}/access_token`, {
    params: { grant_type: "ig_exchange_token", client_secret: clientSecret, access_token: shortToken },
  });
  return [data.access_token || "", parseInt(data.expires_in || "0", 10) || 0];
}

async function igRefreshToken(longToken: string): Promise<[string, number]> {
  const data = await igRequest("GET", `${IG_BASE}/refresh_access_token`, {
    params: { grant_type: "ig_refresh_token", access_token: longToken },
  });
  return [data.access_token || "", parseInt(data.expires_in || "0", 10) || 0];
}

async function igGetProfile(token: string): Promise<{ user_id: string; username: string }> {
  const data = await igRequest("GET", `${IG_BASE}/${IG_VERSION}/me`, {
    params: { fields: "user_id,username", access_token: token },
  });
  return { user_id: String(data.user_id || ""), username: (data.username || "").trim() };
}

async function igCreateMedia(token: string, igUserId: string, imageUrl: string, caption: string): Promise<string> {
  const data = await igRequest("POST", `${IG_BASE}/${IG_VERSION}/${igUserId}/media`, {
    data: { image_url: imageUrl, caption: caption.slice(0, 2200), access_token: token },
  });
  return data.id || "";
}

async function igMediaStatus(token: string, mediaId: string): Promise<string> {
  const data = await igRequest("GET", `${IG_BASE}/${IG_VERSION}/${mediaId}`, {
    params: { fields: "status_code", access_token: token },
  });
  return String(data.status_code || "").toUpperCase();
}

async function igPublishMedia(token: string, igUserId: string, creationId: string): Promise<string> {
  const data = await igRequest("POST", `${IG_BASE}/${IG_VERSION}/${igUserId}/media_publish`, {
    data: { creation_id: creationId, access_token: token },
  });
  return data.id || "";
}

async function igPublishImage(token: string, igUserId: string, imageUrl: string, caption: string): Promise<string> {
  const creationId = await igCreateMedia(token, igUserId, imageUrl, caption);
  for (let i = 0; i < IG_MEDIA_WAIT_TRIES; i++) {
    const status = await igMediaStatus(token, creationId);
    if (status === "FINISHED") return await igPublishMedia(token, igUserId, creationId);
    if (status === "ERROR" || status === "EXPIRED") {
      throw new InstagramError(`Instagram не принял картинку (${status}).`);
    }
    await new Promise((r) => setTimeout(r, IG_MEDIA_WAIT_STEP));
  }
  throw new InstagramError("Instagram слишком долго обрабатывал картинку — попробуем в следующий запуск.");
}

async function igSendMessage(token: string, igUserId: string, recipientId: string, text: string): Promise<any> {
  return await igRequest("POST", `${IG_BASE}/${IG_VERSION}/${igUserId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
    body: { recipient: { id: recipientId }, message: { text: text.slice(0, 1000) } },
  });
}

async function igConfigureAppWebhook(appId: string, appSecret: string, callbackUrl: string, verifyToken: string): Promise<any> {
  return await igRequest("POST", `https://graph.facebook.com/${IG_VERSION}/${appId}/subscriptions`, {
    params: { access_token: `${appId}|${appSecret}` },
    data: { object: "instagram", callback_url: callbackUrl, fields: "messages", verify_token: verifyToken },
  });
}

// --- Карточки Instagram (satori -> resvg -> UPNG -> JPEG) -------------------
const CARD_SIZE = 1080;
const CARD_PADDING = 96;
const PALETTES: Array<[number[], number[]]> = [
  [[79, 70, 229], [30, 27, 75]],
  [[139, 92, 246], [76, 29, 149]],
  [[14, 165, 233], [12, 74, 110]],
  [[16, 185, 129], [6, 78, 59]],
  [[244, 63, 94], [136, 19, 55]],
];

function rgb(c: number[]): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

let resvgReady = false;
async function ensureResvg(): Promise<void> {
  if (resvgReady) return;
  const wasm = await fetch("https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@2.6.2/index_bg.wasm");
  if (!wasm.ok) throw new Error(`Не удалось загрузить движок картинок (${wasm.status}).`);
  await initWasm(await wasm.arrayBuffer());
  resvgReady = true;
}

let fontCache: { regular: ArrayBuffer; bold: ArrayBuffer } | null = null;
async function loadCardFonts(): Promise<{ regular: ArrayBuffer; bold: ArrayBuffer }> {
  if (fontCache) return fontCache;
  const [a, b] = await Promise.all([
    fetch("https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf"),
    fetch("https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf"),
  ]);
  if (!a.ok || !b.ok) throw new Error("Не удалось загрузить шрифты для картинок.");
  fontCache = { regular: await a.arrayBuffer(), bold: await b.arrayBuffer() };
  return fontCache;
}

function cardTeaser(text: string, limit = 200): string {
  const lines = (text || "").split("\n").map((ln) => ln.trim()).filter((ln) => ln && !ln.startsWith("#"));
  const cleaned = lines.join(" ");
  if (cleaned.length <= limit) return cleaned;
  const cut = cleaned.slice(0, limit).replace(/\s+\S*$/, "").replace(/[ ,.!?:;—-]+$/, "");
  return cut + "…";
}

async function makeCardJpeg(title: string, postText: string, footer = "AI Контент"): Promise<Uint8Array> {
  await ensureResvg();
  const fonts = await loadCardFonts();
  const seed = Array.from(title || "x").reduce((acc, ch) => acc + ch.codePointAt(0)!, 0);
  const [top, bottom] = PALETTES[seed % PALETTES.length];

  const circles = [
    { top: -120, right: -120, size: 460, alpha: 0.10 },
    { bottom: -200, left: -150, size: 600, alpha: 0.08 },
    { top: 820, right: 200, size: 180, alpha: 0.09 },
  ].map((c) => ({
    type: "div",
    props: {
      style: {
        position: "absolute",
        ...(("top" in c) ? { top: c.top } : {}),
        ...(("bottom" in c) ? { bottom: c.bottom } : {}),
        ...(("right" in c) ? { right: c.right } : {}),
        ...(("left" in c) ? { left: c.left } : {}),
        width: c.size,
        height: c.size,
        borderRadius: c.size / 2,
        border: `3px solid rgba(255,255,255,${c.alpha})`,
        display: "flex",
      },
    },
  }));

  const element = {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column",
        width: CARD_SIZE,
        height: CARD_SIZE,
        backgroundImage: `linear-gradient(180deg, ${rgb(top)} 0%, ${rgb(bottom)} 100%)`,
        padding: CARD_PADDING,
        fontFamily: "DejaVu",
        position: "relative",
      },
      children: [
        ...circles,
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              fontSize: 88,
              fontWeight: 700,
              color: "#f5f5fa",
              lineHeight: 1.22,
              maxHeight: 330,
              overflow: "hidden",
            },
            children: (title || "").trim(),
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              width: 120,
              height: 10,
              backgroundColor: "#ffffff",
              borderRadius: 5,
              marginTop: 26,
              marginBottom: 44,
            },
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              fontSize: 46,
              color: "#f5f5fa",
              lineHeight: 1.26,
              maxHeight: 470,
              overflow: "hidden",
            },
            children: cardTeaser(postText),
          },
        },
        {
          type: "div",
          props: {
            style: { display: "flex", marginTop: "auto", fontSize: 34, color: "#d2d2e4" },
            children: footer,
          },
        },
      ],
    },
  };

  const svg = await satori(element as any, {
    width: CARD_SIZE,
    height: CARD_SIZE,
    fonts: [
      { name: "DejaVu", data: fonts.regular, weight: 400, style: "normal" },
      { name: "DejaVu", data: fonts.bold, weight: 700, style: "normal" },
    ],
  });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: CARD_SIZE } }).render().asPng();
  const img = UPNG.decode(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer);
  const rgba = UPNG.toRGBA8(img)[0];
  const out = jpeg.encode({ data: new Uint8Array(rgba), width: img.width, height: img.height }, 90);
  return out.data as Uint8Array;
}

// ============================================================================
// Маркетплейсы: логика
// ============================================================================
const MARKETPLACES: Record<string, { name: string; persona: string; description: string; characters: string; keywords: string }> = {
  wb: {
    name: "Wildberries",
    persona: "Ты — специалист по карточкам товаров Wildberries с опытом 10 лет.",
    description: "продающее описание 500–800 символов, без указания цены",
    characters: "6–10 шт.",
    keywords: "10–15 поисковых слов через запятую",
  },
  ozon: {
    name: "Ozon",
    persona: "Ты — специалист по карточкам товаров Ozon с опытом 10 лет.",
    description: "продающее описание 500–1000 символов с выгодами для покупателя, без указания цены",
    characters: "6–10 шт.",
    keywords: "10–15 поисковых слов через запятую",
  },
  aliexpress: {
    name: "AliExpress",
    persona: "Ты — специалист по карточкам товаров AliExpress с опытом 10 лет.",
    description: "простое продающее описание 300–600 символов короткими фразами, без указания цены",
    characters: "6–10 шт.",
    keywords: "10–15 поисковых слов через запятую: русские и 3–5 английских",
  },
  yamarket: {
    name: "Яндекс Маркет",
    persona: "Ты — специалист по карточкам товаров Яндекс Маркета с опытом 10 лет.",
    description: "фактическое описание 500–800 символов: факты и преимущества без воды, без указания цены",
    characters: "8–12 шт.",
    keywords: "10–15 поисковых слов через запятую",
  },
};

class MarketplaceError extends Error {}

const STOP_WORDS = new Set(["и", "в", "для", "на", "с", "из", "по", "от", "без", "the", "a"]);

function mpWords(text: string): Set<string> {
  const parts = (text || "").toLowerCase().split(/[^0-9a-zа-яё]+/).filter(Boolean);
  return new Set(parts.filter((w) => !STOP_WORDS.has(w)));
}

function mpStems(words: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const w of words) {
    if (w.length >= 5) out.add(w.slice(0, 5));
    else if (w.length >= 3) out.add(w);
  }
  return out;
}

function pickCategory(categories: Array<{ id: number; p: string }>, name: string, keywords: string) {
  const stems = mpStems(mpWords(`${name} ${keywords || ""}`));
  let best: { id: number; p: string } | null = null;
  let bestScore = 0;
  for (const cat of categories) {
    let score = 0;
    for (const s of mpStems(mpWords(cat.p || ""))) if (stems.has(s)) score++;
    if (score > bestScore) {
      best = cat;
      bestScore = score;
    }
  }
  return best;
}

function visionPrompt(): string {
  return "Рассмотри фото товара для карточки маркетплейса. Опиши только то, что видно: " +
    "тип товара, материал, цвет, конструкцию, детали и комплектацию. " +
    "Пиши связным текстом, 3–5 предложений, без советов и оценки качества.";
}

function cardPrompt(name: string, price: number, visionText: string | null, platform: string): string {
  const mp = MARKETPLACES[platform] || MARKETPLACES.wb;
  const visionLine = visionText ? `- Что видно на фото: ${visionText}\n` : "";
  return `${mp.persona}\n` +
    `Данные товара:\n- Название: ${name}\n- Цена: ${price} руб.\n` +
    visionLine +
    "Составь карточку товара. Верни СТРОГО один JSON-объект без markdown и пояснений:\n" +
    `{"description": "${mp.description}", ` +
    `"characteristics": [{"name": "название характеристики", "value": "значение"}] — ${mp.characters}, ` +
    `"keywords": "${mp.keywords}"}`;
}

function extractJson(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Модель вернула ответ не в формате JSON");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("Не удалось разобрать карточку из ответа модели");
  }
}

async function savePhoto(bytes: Uint8Array, mime: string): Promise<string> {
  const ext = PHOTO_MIME[mime] || "jpg";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const name = toHex(digest).slice(0, 24) + "." + ext;
  return await storageUpload(`mp/${name}`, bytes, mime);
}

async function sha1Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", enc.encode(text)));
  return toHex(digest);
}

// ===== Wildberries =====
async function wbGetSubjects(token: string): Promise<string[]> {
  let resp: Response;
  try {
    resp = await fetch(`${WB_CONTENT_API}/content/v2/object/all?lang=ru&limit=1000`, {
      headers: { Authorization: token },
    });
  } catch (e) {
    throw new MarketplaceError(`Wildberries недоступен: ${e}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new MarketplaceError("Токен Wildberries отклонён (проверьте кабинет продавца).");
  }
  if (resp.status !== 200) {
    throw new MarketplaceError(`Wildberries HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => ({ data: [] }));
  return (data.data || []).map((d: any) => d.subjectName || "").filter(Boolean);
}

function pickSubject(subjects: string[], name: string, keywords: string): string | null {
  const stems = mpStems(mpWords(`${name} ${keywords || ""}`));
  let best: string | null = null;
  let bestScore = 0;
  for (const subject of subjects) {
    let score = 0;
    for (const s of mpStems(mpWords(subject))) if (stems.has(s)) score++;
    if (score > bestScore) {
      best = subject;
      bestScore = score;
    }
  }
  return best;
}

async function wbPublish(token: string, photoBytes: Uint8Array, mime: string, name: string, card: any): Promise<string> {
  const subjects = await wbGetSubjects(token);
  const subject = pickSubject(subjects, name, card.keywords || "");
  if (!subject) throw new MarketplaceError("Не удалось подобрать категорию товара в Wildberries.");
  const ext = PHOTO_MIME[mime] || "jpg";

  const fd = new FormData();
  fd.append("photo", new Blob([photoBytes], { type: mime }), `item.${ext}`);
  let resp: Response;
  try {
    resp = await fetch(CMP_UPLOAD_URL, { method: "POST", headers: { Authorization: token }, body: fd });
  } catch (e) {
    throw new MarketplaceError(`Не удалось загрузить фото в Wildberries: ${e}`);
  }
  if (resp.status !== 200) {
    throw new MarketplaceError(`Загрузка фото: WB HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const up = await resp.json().catch(() => null);
  const filename = up?.result?.filename;
  if (!filename) throw new MarketplaceError("Wildberries не вернул имя загруженного фото.");

  const props: Array<{ title: string; value: string }> = [{ title: "Наименование", value: name }];
  for (const char of card.characteristics || []) {
    if (char?.name && char?.value) {
      props.push({ title: String(char.name).slice(0, 100), value: String(char.value).slice(0, 800) });
    }
  }
  props.push({ title: "Описание", value: String(card.description || "").slice(0, 2000) });

  try {
    resp = await fetch(`${WB_CONTENT_API}/content/v2/cards/multifactor`, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({
        cards: [{ subject: { name: subject, props }, variants: [{ title: name }], photos: [{ filename }] }],
      }),
    });
  } catch (e) {
    throw new MarketplaceError(`Не удалось создать карточку: ${e}`);
  }
  if (resp.status !== 200 && resp.status !== 201) {
    throw new MarketplaceError(`Создание карточки: WB HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  return subject;
}

// ===== Ozon =====
function ozonHeaders(clientId: string, apiKey: string): Record<string, string> {
  return { "Client-Id": clientId, "Api-Key": apiKey, "Content-Type": "application/json" };
}

async function ozonValidate(clientId: string, apiKey: string): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(`${OZON_API}/v3/product/list`, {
      method: "POST",
      headers: ozonHeaders(clientId, apiKey),
      body: JSON.stringify({ filter: {}, limit: 1 }),
    });
  } catch (e) {
    throw new MarketplaceError(`Ozon недоступен: ${e}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new MarketplaceError("Ключи Ozon отклонены (проверьте кабинет продавца).");
  }
  if (resp.status !== 200) {
    throw new MarketplaceError(`Ozon HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
}

function flattenCategory(node: any, prefix: string, out: Array<{ id: number; p: string }>): void {
  const title = String(node.category_name || "").trim();
  const path = prefix ? `${prefix} > ${title}` : title;
  const cid = node.description_category_id;
  const children = node.children || [];
  if (cid && !children.length) out.push({ id: cid, p: path });
  for (const child of children) flattenCategory(child, path, out);
}

let ozonTreeCache: { at: number; data: Array<{ id: number; p: string }> } | null = null;
async function ozonLoadCategories(clientId: string, apiKey: string): Promise<Array<{ id: number; p: string }>> {
  if (ozonTreeCache && Date.now() - ozonTreeCache.at < OZON_TREE_TTL) return ozonTreeCache.data;
  let resp: Response;
  try {
    resp = await fetch(`${OZON_API}/v1/description-category/tree`, {
      method: "POST",
      headers: ozonHeaders(clientId, apiKey),
    });
  } catch (e) {
    throw new MarketplaceError(`Не удалось получить категории Ozon: ${e}`);
  }
  if (resp.status !== 200) {
    throw new MarketplaceError(`Категории Ozon: HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const out: Array<{ id: number; p: string }> = [];
  const body = await resp.json().catch(() => ({ result: [] }));
  for (const node of body.result || []) flattenCategory(node, "", out);
  ozonTreeCache = { at: Date.now(), data: out };
  return out;
}

async function ozonPublish(clientId: string, apiKey: string, photoUrl: string, name: string, price: number, card: any): Promise<string> {
  const categories = await ozonLoadCategories(clientId, apiKey);
  const cat = pickCategory(categories, name, card.keywords || "");
  if (!cat) throw new MarketplaceError("Не удалось подобрать категорию товара в Ozon.");
  const sku = "ac-" + (await sha1Hex(name)).slice(0, 8);
  const item = {
    name,
    offer_id: sku,
    price: String(price),
    vat: "0",
    description_category_id: cat.id,
    attributes: [
      { complex_id: 0, id: 4180, values: [{ value: name }] },
      { complex_id: 0, id: 4190, values: [{ value: String(card.description || "").slice(0, 6000) }] },
    ],
    images: [photoUrl],
  };
  const headers = ozonHeaders(clientId, apiKey);
  let resp: Response;
  try {
    resp = await fetch(`${OZON_API}/v2/product/import`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items: [item] }),
    });
  } catch (e) {
    throw new MarketplaceError(`Не удалось создать карточку в Ozon: ${e}`);
  }
  if (resp.status !== 200 && resp.status !== 201) {
    throw new MarketplaceError(`Создание в Ozon: HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const body = await resp.json().catch(() => ({ result: {} }));
  const taskId = body?.result?.task_id;
  if (taskId === undefined || taskId === null) return `категория: ${cat.p}`;

  let errors: string[] = [];
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    let info: Response;
    try {
      info = await fetch(`${OZON_API}/v1/product/import/info`, {
        method: "POST",
        headers,
        body: JSON.stringify({ task_id: taskId }),
      });
    } catch {
      break;
    }
    if (info.status !== 200) break;
    const ib = await info.json().catch(() => ({ result: {} }));
    const items = ib?.result?.items || [];
    if (items.length) {
      errors = items.flatMap((it: any) => (it.errors || []).map((err: any) => String(err.message || err).slice(0, 200)));
      break;
    }
  }
  if (errors.length) throw new MarketplaceError(`Ozon: ${errors.slice(0, 2).join("; ")}`);
  return `категория: ${cat.p}`;
}

// ===== Яндекс Маркет =====
function ymHeaders(token: string): Record<string, string> {
  return { Authorization: `OAuth ${token}`, "Content-Type": "application/json", Accept: "application/json" };
}

async function yamarketValidate(token: string): Promise<number> {
  let resp: Response;
  try {
    resp = await fetch(`${YM_API}/v2/campaigns`, { headers: ymHeaders(token) });
  } catch (e) {
    throw new MarketplaceError(`Яндекс Маркет недоступен: ${e}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new MarketplaceError("Токен Яндекс Маркета отклонён (проверьте кабинет магазина).");
  }
  if (resp.status !== 200) {
    throw new MarketplaceError(`Яндекс Маркет HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const body = await resp.json().catch(() => ({ campaigns: [] }));
  const campaigns = body.campaigns || [];
  if (!campaigns.length) {
    throw new MarketplaceError("У этого токена нет ни одного магазина — проверьте кабинет Яндекс Маркета.");
  }
  return campaigns[0].id;
}

async function yamarketPublish(token: string, campaignId: number, photoUrl: string, name: string, price: number, card: any): Promise<string> {
  const headers = ymHeaders(token);
  const sku = "ac-" + (await sha1Hex(name)).slice(0, 8);
  const cardBody = {
    cards: [{
      offer: { shopSku: sku, name, description: String(card.description || "").slice(0, 6000) },
      media: [{ type: "PHOTO", url: photoUrl }],
    }],
  };
  let resp: Response;
  try {
    resp = await fetch(`${YM_API}/v2/campaigns/${campaignId}/offer-cards`, {
      method: "PUT",
      headers,
      body: JSON.stringify(cardBody),
    });
  } catch (e) {
    throw new MarketplaceError(`Не удалось создать карточку в Маркете: ${e}`);
  }
  if (resp.status !== 200 && resp.status !== 201 && resp.status !== 204) {
    throw new MarketplaceError(`Создание в Маркете: HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  let priceResp: Response | null;
  try {
    priceResp = await fetch(`${YM_API}/v2/campaigns/${campaignId}/offer-prices`, {
      method: "POST",
      headers,
      body: JSON.stringify({ offers: [{ shopSku: sku, price: { value: String(price), currencyId: "RUR" } }] }),
    });
  } catch {
    priceResp = null;
  }
  if (priceResp && priceResp.status !== 200 && priceResp.status !== 201 && priceResp.status !== 204) {
    throw new MarketplaceError(`Карточка создана, но цена не обновилась: HTTP ${priceResp.status}: ${(await priceResp.text()).slice(0, 200)}`);
  }
  return `артикул: ${sku}`;
}

// ===== AliExpress (протокол TOP) =====
function aliSign(params: Record<string, string>, secret: string): string {
  const keys = Object.keys(params).sort();
  let src = secret;
  for (const k of keys) src += k + params[k];
  src += secret;
  return md5(src).toUpperCase();
}

async function aliCall(
  appKey: string,
  appSecret: string,
  accessToken: string,
  method: string,
  apiParams: Record<string, unknown> = {},
  file: { name: string; bytes: Uint8Array; mime: string } | null = null,
): Promise<any> {
  const params: Record<string, string> = {
    method,
    app_key: appKey,
    session: accessToken,
    timestamp: String(Date.now()),
    format: "JSON",
    v: "2.0",
    sign_method: "md5",
  };
  for (const [k, v] of Object.entries(apiParams)) params[k] = String(v);
  params["sign"] = aliSign(params, appSecret);

  let body: BodyInit;
  const headers: Record<string, string> = {};
  if (file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(params)) fd.append(k, v);
    fd.append("image", new Blob([file.bytes], { type: file.mime }), file.name);
    body = fd;
  } else {
    body = new URLSearchParams(params);
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  let resp: Response;
  try {
    resp = await fetch(ALIEXPRESS_GATEWAY, { method: "POST", headers, body });
  } catch (e) {
    throw new MarketplaceError(`AliExpress недоступен: ${e}`);
  }
  const text = await resp.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new MarketplaceError(`AliExpress: неожиданный ответ HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  if (data && typeof data === "object" && data.error_response) {
    const err = data.error_response || {};
    const msg = ["msg", "sub_msg"].map((k) => (err[k] ? String(err[k]) : "")).filter(Boolean).join(" ").trim();
    throw new MarketplaceError(`AliExpress отклонил запрос: ${(msg || text).slice(0, 220)}`);
  }
  return data;
}

function aliFind(obj: any, keys: string[]): any {
  if (obj && typeof obj === "object") {
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = aliFind(item, keys);
        if (found !== undefined && found !== null) return found;
      }
    } else {
      for (const [k, v] of Object.entries(obj)) {
        if (keys.includes(k) && v !== null && v !== "" && !(Array.isArray(v) && !v.length) &&
          !(typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)) {
          return v;
        }
      }
      for (const v of Object.values(obj)) {
        const found = aliFind(v, keys);
        if (found !== undefined && found !== null) return found;
      }
    }
  }
  return null;
}

async function aliValidate(appKey: string, appSecret: string, accessToken: string): Promise<void> {
  await aliCall(appKey, appSecret, accessToken, "aliexpress.category.recommendfun.get", { title: "test" });
}

async function aliUploadPhoto(appKey: string, appSecret: string, accessToken: string, bytes: Uint8Array, mime: string): Promise<string> {
  const ext = PHOTO_MIME[mime] || "jpg";
  const data = await aliCall(appKey, appSecret, accessToken, "aliexpress.photobank.image.upload", {}, {
    name: `item.${ext}`,
    bytes,
    mime,
  });
  const url = aliFind(data, ["url", "image_url", "image_full_path", "full_image_url"]);
  if (typeof url !== "string" || !url.startsWith("http")) {
    throw new MarketplaceError("AliExpress не вернул адрес загруженного фото.");
  }
  return url;
}

async function aliPickCategory(appKey: string, appSecret: string, accessToken: string, name: string): Promise<any> {
  const data = await aliCall(appKey, appSecret, accessToken, "aliexpress.category.recommendfun.get", { title: name.slice(0, 50) });
  const cats = aliFind(data, ["result_list", "category_list", "categories", "list"]);
  if (!Array.isArray(cats) || !cats.length) {
    throw new MarketplaceError("Не удалось подобрать категорию товара в AliExpress.");
  }
  const catId = aliFind(cats[0], ["category_id", "cat_id", "id"]);
  if (!catId) throw new MarketplaceError("Не удалось подобрать категорию товара в AliExpress.");
  return catId;
}

async function aliPublish(creds: any, bytes: Uint8Array, mime: string, name: string, price: number, card: any): Promise<string> {
  const appKey = creds.app_key, appSecret = creds.app_secret, token = creds.access_token;
  const imageUrl = await aliUploadPhoto(appKey, appSecret, token, bytes, mime);
  const catId = await aliPickCategory(appKey, appSecret, token, name);
  const keywords = (card.keywords || "").split(",").map((w: string) => w.trim()).filter(Boolean).slice(0, 3).join(", ");
  const product = {
    subject: name.slice(0, 128),
    image_urls: [imageUrl],
    product_units: [{ price: String(price), sku_id: "default" }],
    keyword_product: keywords.slice(0, 128),
    description: String(card.description || "").slice(0, 3000),
  };
  const data = await aliCall(appKey, appSecret, token, "aliexpress.solution.open.product.publish", {
    product: JSON.stringify(product),
    cat_id: String(catId),
  });
  const productId = aliFind(data, ["product_id", "productId"]);
  return productId ? `ID товара: ${productId}` : "отправлена в AliExpress";
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
    { id: string; topic: string; content_type: string; result: string; model: string | null; image_url: string | null; created_at: Date | null }[]
  >`SELECT id, topic, content_type, result, model, image_url, created_at FROM generations
    WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT ${limit}`;
  return json({
    items: rows.map((r) => ({
      id: r.id,
      topic: r.topic,
      content_type: r.content_type,
      result: r.result,
      model: r.model,
      image_url: r.image_url,
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

  const imageUrl = await generateImage(imagePrompt(topic, contentType));

  const gid = uuid();
  await sql`INSERT INTO generations (id, user_id, topic, content_type, tone, language, result, model, image_url, created_at)
            VALUES (${gid}, ${user.id}, ${topic}, ${contentType}, ${tone}, ${language}, ${text}, ${model}, ${imageUrl}, ${now()})`;
  used += 1;
  return json({
    id: gid,
    content: text,
    model,
    image_url: imageUrl,
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

// --- Админка: управление пользователями и подписками ------------------------
// Доступ есть только у аккаунта из ADMIN_EMAIL (по умолчанию — владелец сайта).
// Секрет ADMIN_EMAIL необязателен: без него работает адрес по умолчанию.
const ADMIN_EMAIL = (Deno.env.get("ADMIN_EMAIL") || "vsvolodin2014@gmail.com").trim().toLowerCase();

async function requireAdmin(req: Request): Promise<{ user?: UserRow; error?: Response }> {
  const user = await currentUser(req);
  if (!user) return { error: fail(401, "Требуется авторизация. Войдите в аккаунт.") };
  if ((user.email || "").toLowerCase() !== ADMIN_EMAIL) {
    return { error: fail(403, "Доступ только для администратора сайта.") };
  }
  return { user };
}

// Сводка: сколько всего пользователей, по тарифам, активные подписки, свежие регистрации.
route("GET", /^\/api\/admin\/overview$/, async (ctx) => {
  const guard = await requireAdmin(ctx.req);
  if (guard.error) return guard.error;
  const start = dayStartUtc();

  const agg = await sql<{ total: number; free: number; pro: number; pro_plus: number }[]>`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE plan = 'free')::int AS free,
           COUNT(*) FILTER (WHERE plan = 'pro')::int AS pro,
           COUNT(*) FILTER (WHERE plan = 'pro_plus')::int AS pro_plus
    FROM users`;
  const a = agg[0] || { total: 0, free: 0, pro: 0, pro_plus: 0 };

  const newToday = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM users WHERE created_at >= ${start}`;
  const genToday = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM generations WHERE created_at >= ${start}`;
  const genAll = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM generations`;
  const active = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM users
    WHERE plan <> 'free' AND plan_expires_at IS NOT NULL AND plan_expires_at > ${now()}`;
  const recent = await sql<{ id: string; email: string; plan: string; created_at: Date | null }[]>`
    SELECT id, email, plan, created_at FROM users ORDER BY created_at DESC LIMIT 8`;

  return json({
    admin_email: ADMIN_EMAIL,
    users_total: Number(a.total),
    plans: { free: Number(a.free), pro: Number(a.pro), pro_plus: Number(a.pro_plus) },
    active_subscriptions: Number(active[0]?.n || 0),
    new_today: Number(newToday[0]?.n || 0),
    generations_today: Number(genToday[0]?.n || 0),
    generations_total: Number(genAll[0]?.n || 0),
    recent_users: recent.map((r) => ({ id: r.id, email: r.email, plan: r.plan, created_at: iso(r.created_at) })),
  });
});

// Поиск и список пользователей. q — поиск по email, имени или id; plan — фильтр тарифа.
route("GET", /^\/api\/admin\/users$/, async (ctx) => {
  const guard = await requireAdmin(ctx.req);
  if (guard.error) return guard.error;
  const url = new URL(ctx.req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const plan = (url.searchParams.get("plan") || "").trim();
  let limit = parseInt(url.searchParams.get("limit") || "25", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 25;
  if (limit > 100) limit = 100;
  let offset = parseInt(url.searchParams.get("offset") || "0", 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const like = `%${q.toLowerCase()}%`;
  const start = dayStartUtc();
  const rows = await sql<{
    id: string; email: string; name: string | null; plan: string;
    plan_expires_at: Date | null; created_at: Date | null;
    used_today: number; total_generated: number;
  }[]>`
    SELECT u.id, u.email, u.name, u.plan, u.plan_expires_at, u.created_at,
           (SELECT COUNT(*) FROM generations g WHERE g.user_id = u.id AND g.created_at >= ${start})::int AS used_today,
           (SELECT COUNT(*) FROM generations g WHERE g.user_id = u.id)::int AS total_generated
    FROM users u
    WHERE (${q} = '' OR lower(u.email) LIKE ${like} OR lower(COALESCE(u.name, '')) LIKE ${like} OR u.id = ${q})
      AND (${plan} = '' OR u.plan = ${plan})
    ORDER BY u.created_at DESC
    LIMIT ${limit} OFFSET ${offset}`;

  const countRows = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM users u
    WHERE (${q} = '' OR lower(u.email) LIKE ${like} OR lower(COALESCE(u.name, '')) LIKE ${like} OR u.id = ${q})
      AND (${plan} = '' OR u.plan = ${plan})`;

  return json({
    total: Number(countRows[0]?.n || 0),
    limit,
    offset,
    items: rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      plan: r.plan,
      plan_expires_at: iso(r.plan_expires_at),
      created_at: iso(r.created_at),
      used_today: Number(r.used_today),
      total_generated: Number(r.total_generated),
    })),
  });
});

// Карточка одного пользователя: подписки и последние генерации.
route("GET", /^\/api\/admin\/users\/([^/]+)$/, async (ctx, m) => {
  const guard = await requireAdmin(ctx.req);
  if (guard.error) return guard.error;
  const uid = m[1];
  const rows = await sql<UserRow[]>`
    SELECT id, email, password_hash, plan, plan_expires_at, created_at FROM users WHERE id = ${uid} LIMIT 1`;
  if (!rows.length) return fail(404, "Пользователь не найден.");
  const u = rows[0];
  const prof = await sql<{ name: string | null }[]>`SELECT name FROM users WHERE id = ${uid} LIMIT 1`;
  const subs = await sql<{
    plan: string; status: string; payment_ref: string | null; started_at: Date | null; expires_at: Date | null;
  }[]>`SELECT plan, status, payment_ref, started_at, expires_at FROM subscriptions
     WHERE user_id = ${uid} ORDER BY started_at DESC LIMIT 10`;
  const gens = await sql<{ id: string; topic: string; created_at: Date | null }[]>`
    SELECT id, topic, created_at FROM generations
    WHERE user_id = ${uid} ORDER BY created_at DESC LIMIT 10`;

  return json({
    id: u.id,
    email: u.email,
    name: prof[0]?.name ?? null,
    plan: u.plan,
    plan_expires_at: iso(u.plan_expires_at),
    created_at: iso(u.created_at),
    used_today: await usedToday(uid),
    daily_limit: dailyLimit(u.plan),
    subscriptions: subs.map((s) => ({
      plan: s.plan, status: s.status, payment_ref: s.payment_ref,
      started_at: iso(s.started_at), expires_at: iso(s.expires_at),
    })),
    generations: gens.map((g) => ({ id: g.id, topic: g.topic, created_at: iso(g.created_at) })),
  });
});

// Выдать подписку: plan = pro/pro_plus/free, days — срок в днях (по умолчанию 30).
// plan=free просто сбрасывает тариф на бесплатный.
route("POST", /^\/api\/admin\/users\/([^/]+)\/grant$/, async (ctx, m) => {
  const guard = await requireAdmin(ctx.req);
  if (guard.error) return guard.error;
  const uid = m[1];
  const body = await ctx.req.json().catch(() => ({}));
  const plan = String(body.plan || "pro").trim();
  if (!["free", "pro", "pro_plus"].includes(plan)) return fail(422, "Доступны тарифы: free, pro, pro_plus.");
  let days = parseInt(body.days, 10);
  if (!Number.isFinite(days) || days < 1) days = PRO_PERIOD_DAYS;
  if (days > 3650) days = 3650;

  const rows = await sql<{ id: string; email: string }[]>`
    SELECT id, email FROM users WHERE id = ${uid} LIMIT 1`;
  if (!rows.length) return fail(404, "Пользователь не найден.");
  const email = rows[0].email;

  if (plan === "free") {
    await sql`UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = ${uid}`;
    return json({ id: uid, email, plan: "free", plan_expires_at: null, message: "Подписка отключена — тариф FREE." });
  }

  const started = now();
  const expires = new Date(started.getTime() + days * 86400_000);
  const price = plan === "pro" ? PRO_PRICE_RUB : PRO_PLUS_PRICE_RUB;
  const paymentRef = `ADMIN-${uuid().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  await sql`INSERT INTO subscriptions (id, user_id, plan, status, amount_rub, payment_ref, started_at, expires_at)
            VALUES (${uuid()}, ${uid}, ${plan}, 'active', 0, ${paymentRef}, ${started}, ${expires})`;
  await sql`UPDATE users SET plan = ${plan}, plan_expires_at = ${expires} WHERE id = ${uid}`;
  const title = plan === "pro" ? "PRO" : "PRO+";
  return json({
    id: uid,
    email,
    plan,
    plan_expires_at: iso(expires),
    daily_limit: plan === "pro" ? LIMITS.pro : LIMITS.pro_plus,
    payment_ref: paymentRef,
    message: `Выдан тариф ${title} на ${days} дн. (подарок администратора).`,
  });
});

// Отозвать подписку (сброс на FREE).
route("POST", /^\/api\/admin\/users\/([^/]+)\/revoke$/, async (ctx, m) => {
  const guard = await requireAdmin(ctx.req);
  if (guard.error) return guard.error;
  const uid = m[1];
  const rows = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${uid} LIMIT 1`;
  if (!rows.length) return fail(404, "Пользователь не найден.");
  await sql`UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = ${uid}`;
  return json({ id: uid, email: rows[0].email, plan: "free", message: "Подписка отключена — тариф FREE." });
});

// --- Каналы (Telegram + Instagram) ---
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

route("POST", /^\/api\/channels\/instagram$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const body = await ctx.req.json().catch(() => ({}));
  const title = String(body.title || "").trim();
  const description = String(body.description || "").trim();
  const tone = String(body.tone || "дружелюбный");
  const interval = parseInt(body.interval_hours ?? 12, 10);
  const accessToken = String(body.access_token || "").trim();
  const appSecret = String(body.app_secret || "").trim();

  if (title.length < 2) return fail(422, "Введите название канала.");
  if (description.length < 10) return fail(422, "Опишите канал подробнее: минимум 10 символов.");
  if (![6, 12, 24].includes(interval)) return fail(422, "Интервал постинга: 6, 12 или 24 часа.");
  if (accessToken.length < 20) return fail(422, "Вставьте токен из кабинета Meta (он живёт ~1 час).");
  if (appSecret.length < 16) return fail(422, "Вставьте App Secret из настроек приложения Meta.");

  let token: string, expiresIn: number;
  try {
    [token, expiresIn] = await igExchangeToken(accessToken, appSecret);
  } catch (e) {
    return fail(422,
      `Не удалось активировать токен: ${e} ` +
      "Проверьте, что токен скопирован целиком и свежий (живёт ~1 час после генерации), " +
      "а App Secret взят из настроек того же приложения Meta.");
  }
  if (!token || !expiresIn) return fail(502, "Instagram вернул пустой ответ при обмене токена.");

  let profile: { user_id: string; username: string };
  try {
    profile = await igGetProfile(token);
  } catch (e) {
    return fail(422, `Токен отклонён Instagram: ${e}`);
  }
  if (!profile.user_id) return fail(502, "Instagram не вернул id аккаунта — попробуйте ещё раз.");

  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  const cid = uuid();
  await sql`INSERT INTO channels (id, user_id, title, description, bot_token, channel_username,
              tone, interval_hours, active, last_post_at, created_at, platform, access_token,
              ig_user_id, ig_username, token_expires_at)
            VALUES (${cid}, ${user.id}, ${title}, ${description}, '', ${profile.username},
              ${tone}, ${interval}, 1, NULL, ${now()}, 'instagram', ${token},
              ${profile.user_id}, ${profile.username}, ${expiresAt})`;
  return json({
    id: cid,
    status: "created",
    ig_username: profile.username,
    token_expires_at: expiresAt.toISOString(),
  });
});

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

// Продление долгосрочного токена Instagram (за неделю до истечения).
async function freshIgToken(channelId: string, token: string | null, expiresAt: Date | null, ts: Date): Promise<string | null> {
  const exp = expiresAt ? (expiresAt instanceof Date ? expiresAt : new Date(expiresAt)) : null;
  if (token && exp && (exp.getTime() - ts.getTime()) / 1000 > 7 * 86400) return token;
  if (!token) return null;
  try {
    const [newToken, expiresIn] = await igRefreshToken(token);
    if (!newToken) return token;
    const newExp = new Date(ts.getTime() + (expiresIn || 60 * 86400) * 1000);
    await sql`UPDATE channels SET access_token = ${newToken}, token_expires_at = ${newExp} WHERE id = ${channelId}`;
    return newToken;
  } catch {
    return token;
  }
}

type PubChannel = {
  id: string; user_id: string; title: string; description: string; tone: string;
  channel_username: string; platform: string | null;
  access_token: string | null; ig_user_id: string | null; token_expires_at: Date | null;
};

function channelSubject(platform: string, title: string, description: string): string {
  if (platform === "instagram") {
    return `Пост для Instagram-аккаунта «${title}» (публикуется как картинка с подписью). О чём аккаунт: ${description}`;
  }
  return `Пост для Telegram-канала «${title}». О чём канал: ${description}`;
}

// Публикация одного поста в канал. Возвращает {status, text, error}.
async function publishChannelOnce(ch: PubChannel, ts: Date): Promise<{ status: string; text: string; error: string | null }> {
  const platform = ch.platform || "telegram";
  if (platform === "telegram" && !TELEGRAM_BOT_TOKEN) {
    return { status: "failed", text: "", error: "Автопостинг в Telegram недоступен: администратор сервиса не настроил бота." };
  }
  if (platform === "instagram" && !(ch.access_token && ch.ig_user_id)) {
    return { status: "failed", text: "", error: "Аккаунт Instagram подключён не полностью — удалите канал и подключите заново." };
  }

  let text: string, model: string;
  try {
    [text, model] = await generateContent(channelSubject(platform, ch.title, ch.description), "post", ch.tone, "ru");
  } catch (e) {
    return { status: "failed", text: "", error: String(e) };
  }

  if (platform === "instagram") {
    const token = await freshIgToken(ch.id, ch.access_token, ch.token_expires_at, ts);
    if (!token) {
      return { status: "failed", text, error: "Токен Instagram истёк — сгенерируйте новый в кабинете Meta и подключите аккаунт заново." };
    }
    try {
      const jpg = await makeCardJpeg(ch.title, text);
      const imageUrl = await storageUpload(`ig/${uuid()}.jpg`, jpg, "image/jpeg");
      await igPublishImage(token, ch.ig_user_id!, imageUrl, text);
    } catch (e) {
      return { status: "failed", text, error: String((e as Error)?.message || e) };
    }
  } else {
    try {
      const chat = ch.channel_username.replace(/^@/, "");
      await tgCall("sendMessage", {
        chat_id: /^-?\d+$/.test(chat) ? chat : `@${chat}`,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      });
    } catch (e) {
      return { status: "failed", text, error: String(e) };
    }
  }

  await sql`UPDATE channels SET last_post_at = ${ts} WHERE id = ${ch.id}`;
  await sql`INSERT INTO generations (id, user_id, topic, content_type, tone, language, result, model, created_at)
            VALUES (${uuid()}, ${ch.user_id}, ${"Автопостинг: " + ch.title}, 'post', ${ch.tone}, 'ru', ${text}, ${model}, ${ts})`;
  return { status: "sent", text, error: null };
}

route("POST", /^\/api\/channels\/([^/]+)\/publish$/, async (ctx, m) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const cid = m[1];
  const rows = await sql<PubChannel[]>`
    SELECT id, user_id, title, description, tone, channel_username, platform,
           access_token, ig_user_id, token_expires_at
    FROM channels WHERE id = ${cid} AND user_id = ${user.id} LIMIT 1`;
  if (!rows.length) return fail(404, "Канал не найден.");
  const ch = rows[0];

  const limit = dailyLimit(user.plan);
  const used = await usedToday(user.id);
  if (used >= limit) {
    return fail(429, `Дневной лимит генераций исчерпан (${used} из ${limit}). Обновите тариф или попробуйте завтра.`);
  }

  const res = await publishChannelOnce(ch, now());
  await logPost(cid, user.id, res.text, res.status, res.error);
  if (res.status !== "sent") return fail(502, res.error || "Не удалось опубликовать пост.");
  const usedAfter = await usedToday(user.id);
  return json({ status: "sent", text: res.text, remaining: Math.max(0, limit - usedAfter) });
});

// --- Автопостинг по расписанию (Telegram + Instagram) ---
route("POST", /^\/api\/cron\/autopost$/, async (ctx) => {
  const secret = ctx.req.headers.get("x-cron-secret") || "";
  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return fail(403, "Недействительный секрет cron-задачи.");
  }
  const ts = now();
  const rows = await sql<(PubChannel & { interval_hours: number; last_post_at: Date | null; plan: string })[]>`
    SELECT c.id, c.user_id, c.title, c.description, c.tone, c.interval_hours,
           c.channel_username, c.last_post_at, u.plan, c.platform, c.access_token,
           c.ig_user_id, c.token_expires_at
    FROM channels c JOIN users u ON u.id = c.user_id
    WHERE c.active = 1`;
  let sent = 0, failed = 0, skipped = 0;
  for (const r of rows) {
    const last = r.last_post_at ? new Date(r.last_post_at) : null;
    if (last && (ts.getTime() - last.getTime()) / 1000 < r.interval_hours * 3600 - 600) { skipped++; continue; }
    if (await usedToday(r.user_id) >= dailyLimit(r.plan)) { skipped++; continue; }
    if ((r.platform || "telegram") === "telegram" && !TELEGRAM_BOT_TOKEN) { skipped++; continue; }
    const res = await publishChannelOnce(r, ts);
    await logPost(r.id, r.user_id, res.text, res.status, res.error);
    if (res.status === "sent") sent++; else failed++;
  }
  return json({ status: "ok", checked: rows.length, sent, failed, skipped });
});

// ============================================================================
// Маркетплейсы: маршруты
// ============================================================================
route("POST", /^\/api\/wb\/connect$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const body = await ctx.req.json().catch(() => ({}));
  const platform = String(body.platform || "wb").trim().toLowerCase();
  if (!MARKETPLACES[platform]) return fail(422, "Неизвестный маркетплейс.");

  let creds: string, extra: string | null = null;
  let subjectsCount = 0;
  if (platform === "wb") {
    const token = String(body.api_token || "").trim();
    if (token.length < 10) return fail(422, "Вставьте API-токен кабинета Wildberries.");
    try {
      subjectsCount = (await wbGetSubjects(token)).length;
    } catch (e) {
      return fail(422, `${e} Токен берётся в кабинете WB: Настройки → Доступ к API.`);
    }
    creds = token;
  } else if (platform === "ozon") {
    const clientId = String(body.client_id || "").trim();
    const apiKey = String(body.api_key || "").trim();
    if (clientId.length < 4 || apiKey.length < 8) return fail(422, "Вставьте Client-Id и Api-Key из кабинета Ozon.");
    try {
      await ozonValidate(clientId, apiKey);
    } catch (e) {
      return fail(422, `${e} Ключи создаются в кабинете Ozon: Настройки → API-ключи (доступ «Продукты»).`);
    }
    creds = JSON.stringify({ client_id: clientId, api_key: apiKey });
  } else if (platform === "yamarket") {
    const token = String(body.api_token || "").trim();
    if (token.length < 10) return fail(422, "Вставьте API-ключ кабинета Яндекс Маркета.");
    let campaignId: number;
    try {
      campaignId = await yamarketValidate(token);
    } catch (e) {
      return fail(422, `${e} Ключ создаётся в кабинете Маркета: Настройки → API-ключи.`);
    }
    creds = token;
    extra = JSON.stringify({ campaign_id: campaignId });
  } else {
    const appKey = String(body.app_key || "").trim();
    const appSecret = String(body.app_secret || "").trim();
    const accessToken = String(body.access_token || "").trim();
    if (appKey.length < 4 || appSecret.length < 8 || accessToken.length < 10) {
      return fail(422, "Вставьте app_key, app_secret и access_token приложения из AliExpress Open Platform.");
    }
    try {
      await aliValidate(appKey, appSecret, accessToken);
    } catch (e) {
      return fail(422, `${e} Ключи берутся в кабинете разработчика AliExpress Open Platform (приложение с доступом к товарам).`);
    }
    creds = JSON.stringify({ app_key: appKey, app_secret: appSecret, access_token: accessToken });
  }

  await sql`DELETE FROM wb_accounts WHERE user_id = ${user.id} AND platform = ${platform}`;
  await sql`INSERT INTO wb_accounts (id, user_id, platform, api_token, extra, added_at)
            VALUES (${uuid()}, ${user.id}, ${platform}, ${creds}, ${extra}, ${now()})`;
  const result: Record<string, unknown> = {
    connected: true,
    platform,
    platform_name: MARKETPLACES[platform].name,
  };
  if (platform === "wb") result.categories_available = subjectsCount;
  return json(result);
});

route("GET", /^\/api\/wb\/accounts$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const rows = await sql<{ platform: string; added_at: Date | null }[]>`
    SELECT platform, added_at FROM wb_accounts WHERE user_id = ${user.id}`;
  const connected: Record<string, Date | null> = {};
  for (const r of rows) connected[r.platform] = r.added_at;
  return json({
    accounts: Object.entries(MARKETPLACES).map(([key, meta]) => ({
      platform: key,
      name: meta.name,
      auto: true,
      connected: key in connected,
      added_at: key in connected ? iso(connected[key]) : null,
    })),
  });
});

route("DELETE", /^\/api\/wb\/account\/([^/]+)$/, async (ctx, m) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const platform = m[1];
  if (!MARKETPLACES[platform]) return fail(422, "Неизвестный маркетплейс.");
  await sql`DELETE FROM wb_accounts WHERE user_id = ${user.id} AND platform = ${platform}`;
  return json({ connected: false, platform });
});

// Публичная раздача фото товара (Ozon и Яндекс Маркет скачивают картинку по ссылке).
route("GET", /^\/api\/wb\/photos\/([A-Za-z0-9]+\.(?:jpg|png|webp))$/, async (_ctx, m) => {
  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/public/media/mp/${m[1]}`);
  if (!resp.ok) return fail(404, "Фото не найдено.");
  const ext = m[1].split(".").pop();
  const mediaType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return new Response(resp.body, { headers: { "Content-Type": mediaType, ...CORS } });
});

route("POST", /^\/api\/wb\/cards$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const form = await ctx.req.formData().catch(() => null);
  if (!form) return fail(422, "Не удалось прочитать форму. Попробуйте ещё раз.");
  const file = form.get("photo");
  const name = String(form.get("name") || "").trim();
  const priceRub = parseInt(String(form.get("price_rub") || ""), 10);
  const platform = String(form.get("platform") || "wb").trim().toLowerCase();

  if (name.length < 3) return fail(422, "Укажите название товара (минимум 3 символа).");
  if (!(priceRub >= 1 && priceRub <= 10_000_000)) return fail(422, "Укажите цену в рублях от 1 до 10 000 000.");
  if (!MARKETPLACES[platform]) return fail(422, "Неизвестный маркетплейс. Доступны: Wildberries, Ozon, AliExpress, Яндекс Маркет.");
  const hasPhoto = file instanceof File && file.size > 0;
  let mime = "image/jpeg";
  if (hasPhoto) {
    if (file.size > PHOTO_MAX) return fail(422, "Фото слишком большое: максимум 8 МБ.");
    mime = (file.type || "").split(";")[0].trim().toLowerCase();
    if (!PHOTO_MIME[mime]) return fail(422, "Поддерживаются фото: JPEG, PNG, WebP.");
  }

  const limit = dailyLimit(user.plan);
  let used = await usedToday(user.id);
  if (used >= limit) {
    return fail(429, `Достигнут дневной лимит: ${used} из ${limit} генераций. Лимит обновится в 00:00 UTC.`);
  }

  const mpName = MARKETPLACES[platform].name;

  let photoBytes: Uint8Array;
  let imageUrl: string | null = null;
  let visionText: string | null = null;
  let visionModel = "нет (карточка по названию и цене)";

  if (hasPhoto) {
    photoBytes = new Uint8Array(await file.arrayBuffer());
    imageUrl = await savePhoto(photoBytes, mime);
    try {
      const vision = await describeImage(photoBytes, mime, visionPrompt());
      if (vision) {
        visionText = vision[0];
        visionModel = vision[1];
      }
    } catch {
      visionText = null;
    }
  } else {
    // Фото не загружено — бесплатно генерируем изображение товара в браузере ИИ.
    const gen = await generateImageBytes(
      `${name}, professional product photo, clean bright background, studio lighting, high detail, centered`,
    );
    if (!gen) return fail(502, "Не удалось сгенерировать изображение товара. Загрузите фото или попробуйте позже.");
    photoBytes = gen.bytes;
    mime = gen.mime;
    imageUrl = gen.url;
    visionModel = "нет (фото сгенерировано)";
  }

  let card: any, model: string;
  try {
    const [raw, m] = await runPrompt(cardPrompt(name, priceRub, visionText, platform));
    model = m;
    card = extractJson(raw);
  } catch (e) {
    return fail(502, `Сервис генерации временно недоступен, попробуйте ещё раз через минуту. (${e})`);
  }

  const description = String(card.description || "").trim();
  const characteristics = Array.isArray(card.characteristics) ? card.characteristics : [];
  const keywords = String(card.keywords || "").trim();
  if (!description) return fail(502, "Модель вернула пустое описание, попробуйте ещё раз.");

  let status = "ready";
  let error: string | null = null;
  let subject: string | null = null;

  const account = await sql<{ api_token: string; extra: string | null }[]>`
    SELECT api_token, extra FROM wb_accounts WHERE user_id = ${user.id} AND platform = ${platform} LIMIT 1`;
  if (account.length) {
    try {
      const acc = account[0];
      if (platform === "wb") {
        subject = await wbPublish(acc.api_token, photoBytes, mime, name, card);
      } else if (platform === "ozon") {
        const creds = JSON.parse(acc.api_token);
        subject = await ozonPublish(creds.client_id, creds.api_key, imageUrl!, name, priceRub, card);
      } else if (platform === "yamarket") {
        const extraData = JSON.parse(acc.extra || "{}");
        const campaignId = extraData.campaign_id;
        if (!campaignId) throw new MarketplaceError("Магазин Маркета подключён без кампании — подключите его заново.");
        subject = await yamarketPublish(acc.api_token, campaignId, imageUrl!, name, priceRub, card);
      } else {
        const creds = JSON.parse(acc.api_token);
        subject = await aliPublish(creds, photoBytes, mime, name, priceRub, card);
      }
      status = "published";
    } catch (e) {
      status = "error";
      error = String((e as Error)?.message || e).slice(0, 300);
    }
  }

  await sql`INSERT INTO generations (id, user_id, topic, content_type, tone, language, result, model, image_url, created_at)
            VALUES (${uuid()}, ${user.id}, ${"Карточка " + mpName + ": " + name}, 'product', 'продающий', 'ru', ${description}, ${model}, ${imageUrl}, ${now()})`;
  const wid = uuid();
  await sql`INSERT INTO wb_cards (id, user_id, platform, name, price_rub, description, characteristics, keywords, status, error, image_url, created_at)
            VALUES (${wid}, ${user.id}, ${platform}, ${name}, ${priceRub}, ${description},
              ${JSON.stringify(characteristics)}, ${keywords}, ${status}, ${error}, ${imageUrl}, ${now()})`;
  used += 1;
  return json({
    id: wid,
    platform,
    platform_name: mpName,
    name,
    price_rub: priceRub,
    description,
    characteristics,
    keywords,
    image_url: imageUrl,
    publish_status: status,
    publish_subject: subject,
    publish_error: error,
    vision_model: visionModel,
    model,
    used_today: used,
    limit,
    remaining: Math.max(limit - used, 0),
  });
});

route("GET", /^\/api\/wb\/cards$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const rows = await sql<
    { id: string; platform: string; name: string; price_rub: number; description: string;
      characteristics: string | null; keywords: string | null; status: string; error: string | null;
      image_url: string | null; created_at: Date | null }[]
  >`SELECT id, platform, name, price_rub, description, characteristics, keywords, status, error, image_url, created_at
    FROM wb_cards WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT 20`;
  const cards = rows.map((r) => {
    let chars: any[] = [];
    try {
      chars = r.characteristics ? JSON.parse(r.characteristics) : [];
    } catch {
      chars = [];
    }
    const plat = r.platform || "wb";
    return {
      id: r.id,
      platform: plat,
      platform_name: (MARKETPLACES[plat] || MARKETPLACES.wb).name,
      name: r.name,
      price_rub: r.price_rub,
      description: r.description,
      characteristics: chars,
      keywords: r.keywords,
      status: r.status,
      error: r.error,
      image_url: r.image_url,
      created_at: iso(r.created_at),
    };
  });
  return json({ cards });
});

// ============================================================================
// ИИ-боты (Telegram + Instagram Direct)
// ============================================================================
const BOT_COLS = `id, name, role, tone, knowledge, webhook_secret, active, replies_today,
  stat_date, created_at, platform, ig_user_id, token_expires_at`;

type BotRow = {
  id: string; name: string; role: string; tone: string; knowledge: string;
  webhook_secret: string; active: number; replies_today: number; stat_date: string | null;
  created_at: Date | null; platform: string | null; ig_user_id: string | null; token_expires_at: Date | null;
};

type BotFull = BotRow & { bot_token: string };

function rowToBot(r: BotRow) {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    tone: r.tone,
    knowledge: r.knowledge,
    active: !!r.active,
    replies_today: r.replies_today,
    stat_date: r.stat_date,
    created_at: iso(r.created_at),
    platform: r.platform || "telegram",
    token_expires_at: iso(r.token_expires_at),
  };
}

function botSystemPrompt(name: string, role: string, tone: string, knowledge: string, platform = "telegram"): string {
  const who = platform === "instagram"
    ? `ИИ-помощник в Direct Instagram «${name}» малого бизнеса`
    : `Telegram-бот «${name}» малого бизнеса`;
  return `Ты — ${who}. Твоя роль: ${role}.\n` +
    `Тон общения: ${tone}.\n` +
    `Знания о бизнесе, товарах и ценах: ${knowledge}\n` +
    "Правила ответов:\n" +
    "- Отвечай кратко (до 600 символов), простым языком, по-русски.\n" +
    "- Не выдумывай факты, которых нет в знаниях.\n" +
    "- Если не знаешь ответа — честно скажи и предложи связаться с менеджером.\n" +
    "- Если клиент заинтересовался — мягко позови к покупке или попроси контакт.";
}

// Сброс дневного счётчика ответов, если наступил новый день.
function botStat(statDate: string | null, repliesToday: number): { replies: number; statDate: string; reset: boolean } {
  const today = new Date().toISOString().slice(0, 10);
  if (statDate !== today) return { replies: 0, statDate: today, reset: true };
  return { replies: repliesToday, statDate: today, reset: false };
}

route("POST", /^\/api\/bots$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const body = await ctx.req.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  const role = String(body.role || "").trim();
  const tone = String(body.tone || "дружелюбный");
  const knowledge = String(body.knowledge || "").trim();
  const botToken = String(body.bot_token || "").trim();
  if (name.length < 2) return fail(422, "Введите имя бота.");
  if (role.length < 2) return fail(422, "Выберите или напишите роль бота.");
  if (knowledge.length < 10) return fail(422, "Расскажите боту о бизнесе: минимум 10 символов.");
  if (botToken.length < 20) return fail(422, "Вставьте токен бота, полученный у @BotFather.");

  let me: any;
  try {
    me = await tgApi(botToken, "getMe");
  } catch (e) {
    return fail(422, `Токен бота не подошёл: ${e}. Создайте бота у @BotFather и скопируйте токен.`);
  }
  const bid = uuid();
  await sql`INSERT INTO bots (id, user_id, name, role, tone, knowledge, bot_token, webhook_secret,
              active, replies_today, stat_date, created_at)
            VALUES (${bid}, ${user.id}, ${name}, ${role}, ${tone}, ${knowledge}, ${botToken},
              ${uuid().replace(/-/g, "")}, 0, 0, NULL, ${now()})`;
  return json({ id: bid, bot_username: me?.username || null, active: false, status: "created" });
});

route("POST", /^\/api\/bots\/instagram$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const body = await ctx.req.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  const role = String(body.role || "").trim();
  const tone = String(body.tone || "дружелюбный");
  const knowledge = String(body.knowledge || "").trim();
  const accessToken = String(body.access_token || "").trim();
  const appId = String(body.app_id || "").trim();
  const appSecret = String(body.app_secret || "").trim();
  if (name.length < 2) return fail(422, "Введите имя бота.");
  if (role.length < 2) return fail(422, "Выберите или напишите роль бота.");
  if (knowledge.length < 10) return fail(422, "Расскажите боту о бизнесе: минимум 10 символов.");
  if (accessToken.length < 20) return fail(422, "Вставьте токен из кабинета Meta.");
  if (appId.length < 10 || appSecret.length < 16) return fail(422, "Вставьте App ID и App Secret из настроек приложения Meta.");

  let token: string, expiresIn: number;
  try {
    [token, expiresIn] = await igExchangeToken(accessToken, appSecret);
  } catch (e) {
    return fail(422,
      `Не удалось активировать токен: ${e} ` +
      "Проверьте, что токен свежий (живёт ~1 час), а App ID и App Secret взяты " +
      "из того же приложения Meta. Для бота нужен скоуп instagram_business_manage_messages.");
  }
  if (!token || !expiresIn) return fail(502, "Instagram вернул пустой ответ при обмене токена.");

  let profile: { user_id: string; username: string };
  try {
    profile = await igGetProfile(token);
  } catch (e) {
    return fail(422, `Токен отклонён Instagram: ${e}`);
  }
  if (!profile.user_id) return fail(502, "Instagram не вернул id аккаунта — попробуйте ещё раз.");

  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  const bid = uuid();
  await sql`INSERT INTO bots (id, user_id, name, role, tone, knowledge, bot_token, webhook_secret,
              active, replies_today, stat_date, created_at, platform, app_id, app_secret,
              ig_user_id, token_expires_at)
            VALUES (${bid}, ${user.id}, ${name}, ${role}, ${tone}, ${knowledge}, ${token},
              ${uuid().replace(/-/g, "")}, 0, 0, NULL, ${now()}, 'instagram', ${appId}, ${appSecret},
              ${profile.user_id}, ${expiresAt})`;
  return json({ id: bid, ig_username: profile.username, active: false, status: "created" });
});

route("GET", /^\/api\/bots$/, async (ctx) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const rows = await sql<BotRow[]>`
    SELECT ${sql.unsafe(BOT_COLS)} FROM bots WHERE user_id = ${user.id} ORDER BY created_at DESC`;
  return json({ bots: rows.map(rowToBot) });
});

route("POST", /^\/api\/bots\/([^/]+)\/activate$/, async (ctx, m) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const bid = m[1];
  const rows = await sql<{
    bot_token: string; active: number; platform: string | null;
    app_id: string | null; app_secret: string | null; webhook_secret: string;
  }[]>`SELECT bot_token, active, platform, app_id, app_secret, webhook_secret FROM bots
    WHERE id = ${bid} AND user_id = ${user.id} LIMIT 1`;
  if (!rows.length) return fail(404, "Бот не найден.");
  const r = rows[0];
  if (r.active) return json({ id: bid, active: true, status: "already_active" });

  if ((r.platform || "telegram") === "instagram") {
    const callback = `${BACKEND_URL}/api/bots/ig-webhook/${bid}`;
    try {
      await igConfigureAppWebhook(r.app_id || "", r.app_secret || "", callback, r.webhook_secret);
    } catch (e) {
      return fail(502,
        `Не удалось автоматически настроить приём сообщений: ${e} ` +
        `Настройте вручную в кабинете Meta: приложение → Webhooks → Instagram → ` +
        `поле «messages»; Callback URL: ${callback}; Verify token: ${r.webhook_secret}. ` +
        "После сохранения нажмите «Запустить» ещё раз.");
    }
    await sql`UPDATE bots SET active = 1 WHERE id = ${bid}`;
    return json({ id: bid, active: true, status: "activated" });
  }

  try {
    await tgApi(r.bot_token, "setWebhook", {
      url: `${BACKEND_URL}/api/bot-webhook/${bid}`,
      secret_token: r.webhook_secret,
      allowed_updates: ["message"],
    });
  } catch (e) {
    return fail(502, `Telegram не принял webhook: ${e}. Попробуйте ещё раз через минуту.`);
  }
  await sql`UPDATE bots SET active = 1 WHERE id = ${bid}`;
  return json({ id: bid, active: true, status: "activated" });
});

route("POST", /^\/api\/bots\/([^/]+)\/pause$/, async (ctx, m) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const bid = m[1];
  const rows = await sql<{ bot_token: string; platform: string | null; active: number }[]>`
    SELECT bot_token, platform, active FROM bots WHERE id = ${bid} AND user_id = ${user.id} LIMIT 1`;
  if (!rows.length) return fail(404, "Бот не найден.");
  const r = rows[0];
  if ((r.platform || "telegram") === "telegram" && r.active) {
    try {
      await tgApi(r.bot_token, "deleteWebhook");
    } catch { /* webhook уже снят */ }
  }
  // Instagram: подписка приложения остаётся, но бот со active=0 игнорирует сообщения.
  await sql`UPDATE bots SET active = 0 WHERE id = ${bid}`;
  return json({ id: bid, active: false, status: "paused" });
});

route("DELETE", /^\/api\/bots\/([^/]+)$/, async (ctx, m) => {
  const user = await currentUser(ctx.req);
  if (!user) return fail(401, "Требуется авторизация. Войдите в аккаунт.");
  const bid = m[1];
  const rows = await sql<{ bot_token: string; platform: string | null; active: number }[]>`
    SELECT bot_token, platform, active FROM bots WHERE id = ${bid} AND user_id = ${user.id} LIMIT 1`;
  if (!rows.length) return fail(404, "Бот не найден.");
  const r = rows[0];
  if ((r.platform || "telegram") === "telegram" && r.active) {
    try {
      await tgApi(r.bot_token, "deleteWebhook");
    } catch { /* webhook уже снят */ }
  }
  await sql`DELETE FROM bots WHERE id = ${bid}`;
  return json({ status: "deleted" });
});

// --- Webhook Telegram ---
route("POST", /^\/api\/bot-webhook\/([^/]+)$/, async (ctx, m) => {
  const bid = m[1];
  const secret = ctx.req.headers.get("x-telegram-bot-api-secret-token") || "";
  const rows = await sql<BotFull[]>`
    SELECT ${sql.unsafe(BOT_COLS)}, bot_token FROM bots WHERE id = ${bid} LIMIT 1`;
  if (!rows.length || secret !== rows[0].webhook_secret) {
    return fail(403, "Недействительный webhook.");
  }
  const bot = rows[0];
  if (!bot.active) return json({ ok: true });

  const update = await ctx.req.json().catch(() => ({}));
  const message = update.message || update.edited_message || {};
  const chatId = message?.chat?.id;
  if (!chatId) return json({ ok: true });
  let text = String(message.text || "").trim();
  if (!text || text.startsWith("/start")) text = "здравствуйте, расскажите о себе";

  const stat = botStat(bot.stat_date, bot.replies_today);
  if (stat.reset) {
    await sql`UPDATE bots SET replies_today = 0, stat_date = ${stat.statDate} WHERE id = ${bid}`;
  }
  if (stat.replies >= BOT_DAILY_REPLY_LIMIT) {
    try {
      await tgApi(bot.bot_token, "sendMessage", {
        chat_id: chatId,
        text: "Сегодня я уже ответил на много вопросов и отдыхаю. Пожалуйста, напишите завтра.",
      });
    } catch { /* ignore */ }
    return json({ ok: true });
  }

  let answer: string;
  try {
    [answer] = await chatText(botSystemPrompt(bot.name, bot.role, bot.tone, bot.knowledge, bot.platform || "telegram"), text);
  } catch {
    answer = "Извините, я временно перегружен. Напишите, пожалуйста, через пару минут.";
  }
  try {
    await tgApi(bot.bot_token, "sendMessage", { chat_id: chatId, text: answer.slice(0, 4000) });
  } catch {
    return json({ ok: true });
  }
  await sql`UPDATE bots SET replies_today = replies_today + 1 WHERE id = ${bid}`;
  return json({ ok: true });
});

// Продление долгосрочного токена бота Instagram.
async function freshIgBotToken(botId: string, token: string | null, expiresAt: Date | null): Promise<string | null> {
  const exp = expiresAt ? (expiresAt instanceof Date ? expiresAt : new Date(expiresAt)) : null;
  if (token && exp && (exp.getTime() - Date.now()) / 1000 > 7 * 86400) return token;
  if (!token) return null;
  try {
    const [newToken, expiresIn] = await igRefreshToken(token);
    if (!newToken) return token;
    const newExp = new Date(Date.now() + (expiresIn || 60 * 86400) * 1000);
    await sql`UPDATE bots SET bot_token = ${newToken}, token_expires_at = ${newExp} WHERE id = ${botId}`;
    return newToken;
  } catch {
    return token;
  }
}

// --- Webhook Instagram Direct ---
route("GET", /^\/api\/bots\/ig-webhook\/([^/]+)$/, async (ctx, m) => {
  const bid = m[1];
  const url = new URL(ctx.req.url);
  const rows = await sql<{ webhook_secret: string }[]>`
    SELECT webhook_secret FROM bots WHERE id = ${bid} LIMIT 1`;
  if (!rows.length || url.searchParams.get("hub.verify_token") !== rows[0].webhook_secret) {
    return fail(403, "Недействительный verify token.");
  }
  const challenge = url.searchParams.get("hub.challenge") || "";
  return new Response(challenge, { headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS } });
});

route("POST", /^\/api\/bots\/ig-webhook\/([^/]+)$/, async (ctx, m) => {
  const bid = m[1];
  const rows = await sql<BotFull[]>`
    SELECT ${sql.unsafe(BOT_COLS)}, bot_token FROM bots WHERE id = ${bid} LIMIT 1`;
  if (!rows.length) return fail(403, "Недействительный webhook.");
  const bot = rows[0];
  if (bot.platform !== "instagram" || !bot.active) return json({ ok: true });

  const igUserId = bot.ig_user_id || "";
  const token = await freshIgBotToken(bid, bot.bot_token, bot.token_expires_at);
  if (!token) return json({ ok: true });

  const stat = botStat(bot.stat_date, bot.replies_today);
  if (stat.reset) {
    await sql`UPDATE bots SET replies_today = 0, stat_date = ${stat.statDate} WHERE id = ${bid}`;
  }
  let replies = stat.replies;

  const payload = await ctx.req.json().catch(() => ({}));
  const events: any[] = [];
  for (const entry of payload.entry || []) for (const ev of entry.messaging || []) events.push(ev);
  for (const event of events) {
    const message = event.message || {};
    if (message.is_echo || message.is_deleted) continue;
    const text = String(message.text || "").trim();
    const senderId = String(event?.sender?.id || "");
    if (!text || !senderId || senderId === igUserId) continue;
    if (replies >= BOT_DAILY_REPLY_LIMIT) {
      try {
        await igSendMessage(token, igUserId, senderId, "Сегодня я уже ответил на много вопросов и отдыхаю. Пожалуйста, напишите завтра.");
      } catch { /* ignore */ }
      break;
    }
    let answer: string;
    try {
      [answer] = await chatText(botSystemPrompt(bot.name, bot.role, bot.tone, bot.knowledge, "instagram"), text);
    } catch {
      answer = "Извините, я временно перегружен. Напишите, пожалуйста, через пару минут.";
    }
    try {
      await igSendMessage(token, igUserId, senderId, answer);
    } catch {
      continue;
    }
    await sql`UPDATE bots SET replies_today = replies_today + 1 WHERE id = ${bid}`;
    replies += 1;
  }
  return json({ ok: true });
});

// ============================================================================
// Диспетчер запросов
// ============================================================================
// Публичный адрес функции содержит префикс (/functions/v1/api), поэтому один и
// тот же роут доступен по нескольким путям. Перебираем все варианты.
function candidatePaths(reqUrl: string): string[] {
  const pathname = new URL(reqUrl).pathname;
  const out: string[] = [];
  const add = (v: string) => {
    if (!v) return;
    const norm = v.startsWith("/") ? v : "/" + v;
    if (!out.includes(norm)) out.push(norm);
  };
  add(pathname);
  for (const pref of ["/functions/v1/api", "/functions/v1", "/api"]) {
    if (pathname === pref) add("/");
    else if (pathname.startsWith(pref + "/")) add(pathname.slice(pref.length));
  }
  return out;
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const paths = candidatePaths(req.url);
    for (const path of paths) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = path.match(r.re);
        if (m) return await r.fn({ req, method: req.method, path }, m);
      }
    }
    return fail(404, "Такого адреса нет. Проверьте, что backend обновлён.");
  } catch (e) {
    console.error("Необработанная ошибка:", e);
    return fail(500, `Внутренняя ошибка сервера: ${(e as Error)?.message || e}`);
  }
});
