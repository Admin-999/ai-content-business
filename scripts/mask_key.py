# -*- coding: utf-8 -*-
"""Обфускация ключа Pollinations в frontend/js/config.js.

Ключ НЕ хранится в файле открытым текстом. Вместо этого в config.js
записывается «сейф» (_v) из нескольких частей:

  z  — зашифрованные байты ключа (порядок байтов перемешан),
  o  — карта расстановки байтов (перестановка),
  a  — первая половина числа-семени,
  b  — вторая половина числа-семени (семя = a XOR b),
  h  — контрольная сумма (FNV-1a) для проверки целостности.

Шифр — поток байтов генератора xorshift32, наложенный на байты ключа
операцией XOR. В браузере ключ собирается ЛЕНИВО (по первому обращению)
и кешируется как обычная строка.

Использование:
  python scripts/mask_key.py --from-existing   # взять ключ из текущего KEY_PARTS
  python scripts/mask_key.py --key sk_XXXX     # задать новый ключ напрямую
  set POLLI_KEY=sk_XXXX && python scripts/mask_key.py

ВНИМАНИЕ: это обфускация, а НЕ настоящая защита. Ключ подставляется в
запросы из браузера, поэтому в DevTools -> Network он всё равно виден.
Смысл — не дать скопировать ключ из исходников и из git.
"""

import argparse
import base64
import io
import os
import re
import sys

MASK = 0xFFFFFFFF
FNV_OFFSET = 2166136261
FNV_PRIME = 16777619


def xorshift(x):
    x &= MASK
    x ^= (x << 13) & MASK
    x ^= (x >> 17)
    x ^= (x << 5) & MASK
    return x & MASK


def fnv1a(data):
    h = FNV_OFFSET
    for byte in data:
        h ^= byte
        h = (h * FNV_PRIME) & MASK
    return h


def match_block(s, start):
    """start — индекс открывающей скобки ( [ или { ). Возвращает индекс закрывающей."""
    open_ch = s[start]
    close_ch = "]" if open_ch == "[" else "}"
    depth = 0
    i = start
    while i < len(s):
        c = s[i]
        if c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError("несбалансированные скобки")


def comment_run_start(s, pos):
    """Находит начало блока // комментариев, стоящего прямо перед строкой с token (pos)."""
    line_start = s.rfind("\n", 0, pos) + 1
    start = line_start
    while start > 0:
        prev_end = start - 1
        if s[prev_end] != "\n":
            break
        prev_start = s.rfind("\n", 0, prev_end) + 1
        if s[prev_start:prev_end].strip().startswith("//"):
            start = prev_start
        else:
            break
    return start


def read_existing_key(s):
    m = re.search(r"KEY_PARTS\s*:\s*\[", s)
    if not m:
        return None
    b = s.find("[", m.start())
    e = match_block(s, b)
    parts = re.findall(r'"([^"]*)"', s[b:e])
    if not parts:
        return None
    try:
        return base64.b64decode("".join(parts)).decode("ascii")
    except Exception:
        return None


def remove_obfuscation_block(s):
    """Удаляет прежний блок (KEY_PARTS или _v) вместе с его комментариями."""
    for token in ("KEY_PARTS", "_v"):
        idx = s.find(token)
        if idx == -1:
            continue
        m = re.search(re.escape(token) + r"\s*:\s*[\[{]", s)
        if not m:
            continue
        b = m.end() - 1
        if s[b] not in "[{":
            continue
        e = match_block(s, b)
        start = comment_run_start(s, m.start())
        end = e + 1
        has_more = False
        while end < len(s) and s[end] in " \t,":
            has_more = True
            end += 1
        return s[:start], s[end:], has_more
    return None, None, None


def remove_trailing_decoder(s):
    """Удаляет хвостовой IIFE-декодер вместе с его комментариями."""
    idx = s.rfind("(function")
    if idx == -1:
        return s
    start = comment_run_start(s, idx)
    return s[:start]


def build_numbers_js(values, indent, per_line=14):
    lines = []
    for i in range(0, len(values), per_line):
        chunk = ", ".join(str(v) for v in values[i:i + per_line])
        lines.append(indent + chunk + ",")
    return "\n".join(lines)


def build_vault_block(key_bytes, indent="    "):
    n = len(key_bytes)
    seed = int.from_bytes(os.urandom(4), "big") or 0x9E3779B9

    st = seed & MASK
    stream = []
    for _ in range(n):
        st = xorshift(st)
        stream.append((st >> 24) & 0xFF)
    cipher = [key_bytes[k] ^ stream[k] for k in range(n)]

    order = list(range(n))
    st2 = (seed ^ 0x5BD1E995) & MASK
    for k in range(n - 1, 0, -1):
        st2 = xorshift(st2)
        j = st2 % (k + 1)
        order[k], order[j] = order[j], order[k]
    blob = [cipher[order[k]] for k in range(n)]

    a = int.from_bytes(os.urandom(4), "big") or 0x27D4EB2F
    b = a ^ seed
    chk = fnv1a(key_bytes)

    inner = indent + "  "
    block = []
    block.append(indent + "// --- Служебные данные сборки ключа (обфускация) ------------------------")
    block.append(indent + "// Ключ не хранится открытым текстом: это зашифрованные байты (z),")
    block.append(indent + "// карта их расстановки (o), две половины семени (a, b) и контрольная")
    block.append(indent + "// сумма (h). Ключ собирается в памяти по первому обращению и кешируется.")
    block.append(indent + "// Это защита от копирования из исходников, а НЕ пароль: в DevTools ->")
    block.append(indent + "// Network ключ виден в запросах. Чтобы сменить ключ, запустите")
    block.append(indent + "// scripts/mask_key.py --key <новый_ключ>.")
    block.append(indent + "_v: {")
    block.append(inner + "a: " + str(a) + ",")
    block.append(inner + "b: " + str(b) + ",")
    block.append(inner + "h: " + str(chk) + ",")
    block.append(inner + "o: [")
    block.append(build_numbers_js(order, inner + "  "))
    block.append(inner + "],")
    block.append(inner + "z: [")
    block.append(build_numbers_js(blob, inner + "  "))
    block.append(inner + "],")
    block.append(indent + "},")
    return "\n".join(block), {"n": n, "seed": seed, "chk": chk}


def build_decoder():
    return """\n
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
"""


def verify(block_key, key):
    return block_key == key


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?", default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "frontend", "js", "config.js",
    ))
    ap.add_argument("--key", default=None)
    ap.add_argument("--from-existing", action="store_true")
    args = ap.parse_args()

    with io.open(args.path, "r", encoding="utf-8", newline="") as fh:
        s = fh.read()

    key = None
    if args.key:
        key = args.key
    elif os.environ.get("POLLI_KEY"):
        key = os.environ["POLLI_KEY"]
    elif args.from_existing:
        key = read_existing_key(s)
    else:
        key = read_existing_key(s)

    if not key:
        print("Не найден ключ. Укажите --key <ключ> или --from-existing.")
        return 1

    key_bytes = key.encode("ascii")
    has_bom = s.startswith("\ufeff")

    # 1) Убираем прежний хвостовой декодер.
    s = remove_trailing_decoder(s)

    # 2) Убираем прежний блок обфускации.
    head, tail, had_comma = remove_obfuscation_block(s)
    if head is None:
        print("Не найден блок KEY_PARTS/_v — не знаю, куда вставлять.")
        return 1

    block, meta = build_vault_block(key_bytes)
    s = head + block + tail

    # 3) Добавляем новый декодер в конец.
    s = s.rstrip("\n") + "\n" + build_decoder()

    if has_bom:
        s = "\ufeff" + s

    with io.open(args.path, "w", encoding="utf-8", newline="") as fh:
        fh.write(s)

    # --- Проверки ---
    plain_left = ('"' + key + '"') in s
    b64 = base64.b64encode(key_bytes).decode("ascii")
    b64_left = b64 in s
    print("key_length:", len(key))
    print("bytes_encrypted:", meta["n"])
    print("checksum:", meta["chk"])
    print("plain_key_in_file:", plain_left)
    print("base64_key_in_file:", b64_left)
    print("has_vault_block:", "_v:" in s)
    print("has_old_KEY_PARTS:", "KEY_PARTS" in s)
    return 0 if not plain_left and not b64_left else 2


if __name__ == "__main__":
    sys.exit(main())
