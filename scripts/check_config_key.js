// Проверка сборки ключа из служебного блока _v в config.js.
// Печатает только «отпечаток» ключа (длину, края и хеш), не сам ключ.
const fs = require("fs");
const path = process.argv[2];
const code = fs.readFileSync(path, "utf8");

global.window = {};
// eslint-disable-next-line no-eval
eval(code);

const p = (global.window.APP_CONFIG || {}).POLLINATIONS || {};

function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const before = Object.getOwnPropertyDescriptor(p, "KEY") || {};
const key = p.KEY || "";
const after = Object.getOwnPropertyDescriptor(p, "KEY") || {};

console.log(JSON.stringify({
  keyLen: key.length,
  prefix: key.slice(0, 3),
  suffix: key.slice(-2),
  fnv: fnv1a(key),
  wasGetter: typeof before.get === "function",
  cachedAfterFirstRead: typeof after.get !== "function" && after.value === key,
  vaultPresent: !!p._v,
  vaultHasPlainArrays: !!(p._v && p._v.z && p._v.o),
  hasParts: "KEY_PARTS" in p,
}));
