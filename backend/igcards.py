"""Генерация PNG-карточек 1080x1080 для автопостинга в Instagram (Pillow).

Instagram не принимает посты без изображения, поэтому автопостинг рисует
карточку: градиентный фон, название канала и анонс поста. Готовый PNG
сохраняется в IG_CARDS_DIR и раздаётся публично по /api/ig/cards/{файл} —
по этому адресу картинку скачивает сам Instagram (см. routers/channels.py).
"""
import os
import uuid

from PIL import Image, ImageDraw, ImageFont

from config import IG_CARDS_DIR

SIZE = 1080
PADDING = 96
MAX_TITLE_LINES = 3
MAX_TEASER_LINES = 8

_FONT_DIRS = (
    "/usr/share/fonts/truetype/dejavu",  # Modal: apt-пакет fonts-dejavu-core
    "/usr/share/fonts/truetype/liberation",
    "/Library/Fonts",
    "C:\\Windows\\Fonts",
)
_FONT_FILES = {
    "bold": ("DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf", "Arial Bold.ttf", "arialbd.ttf"),
    "regular": ("DejaVuSans.ttf", "LiberationSans-Regular.ttf", "Arial.ttf", "arial.ttf"),
}

# Тёмные градиенты (верх -> низ) под фирменный стиль сервиса
_PALETTES = (
    ((79, 70, 229), (30, 27, 75)),    # индиго
    ((139, 92, 246), (76, 29, 149)),  # фиолетовый
    ((14, 165, 233), (12, 74, 110)),  # небесный
    ((16, 185, 129), (6, 78, 59)),    # изумрудный
    ((244, 63, 94), (136, 19, 55)),   # розовый
)


def _load_font(size: int, bold: bool = False):
    kind = "bold" if bold else "regular"
    for directory in _FONT_DIRS:
        for name in _FONT_FILES[kind]:
            path = os.path.join(directory, name)
            if os.path.exists(path):
                try:
                    return ImageFont.truetype(path, size)
                except OSError:
                    continue
    try:  # Pillow >= 10.1: масштабируемый шрифт по умолчанию
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def _teaser(text: str, limit: int = 200) -> str:
    """Короткий анонс поста: без строк из хештегов и пустых строк."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    cleaned = " ".join(lines)
    if len(cleaned) <= limit:
        return cleaned
    cut = cleaned[:limit].rsplit(" ", 1)[0].rstrip(" ,.!?:;-\u2014")
    return cut + "…"


def _wrap(draw, text: str, font, max_width: int):
    lines = []
    for raw in text.splitlines():
        words = raw.split()
        if not words:
            lines.append("")
            continue
        cur = words[0]
        for word in words[1:]:
            trial = cur + " " + word
            if draw.textlength(trial, font=font) <= max_width:
                cur = trial
            else:
                lines.append(cur)
                cur = word
        lines.append(cur)
    return lines


def make_card(title: str, post_text: str, footer: str = "AI Контент") -> str:
    """Рисует карточку по посту и сохраняет в IG_CARDS_DIR. Возвращает имя файла."""
    os.makedirs(IG_CARDS_DIR, exist_ok=True)

    seed = sum(ord(c) for c in (title or "x"))
    top, bottom = _PALETTES[seed % len(_PALETTES)]

    # Вертикальный градиент: рисуем полоску 1xSIZE и растягиваем
    strip = Image.new("RGB", (1, SIZE))
    for y in range(SIZE):
        t = y / (SIZE - 1)
        strip.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)))
    img = strip.resize((SIZE, SIZE))

    # Лёгкие декоративные окружности поверх градиента
    overlay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for cx, cy, r, alpha in (
        (SIZE - 110, 110, 230, 26),
        (110, SIZE - 80, 300, 20),
        (SIZE - 250, SIZE - 170, 90, 22),
    ):
        od.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(255, 255, 255, alpha), width=3)
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")

    draw = ImageDraw.Draw(img)
    text_color = (245, 245, 250)
    max_width = SIZE - PADDING * 2

    # Заголовок
    title_font = _load_font(88, bold=True)
    y = 150
    for line in _wrap(draw, title.strip(), title_font, max_width)[:MAX_TITLE_LINES]:
        draw.text((PADDING, y), line, font=title_font, fill=text_color)
        y += int(88 * 1.22)

    # Акцентная полоса
    y += 26
    draw.rounded_rectangle((PADDING, y, PADDING + 120, y + 10), radius=5, fill=(255, 255, 255))
    y += 70

    # Анонс поста — сколько строк влезет до футера
    teaser_font = _load_font(46)
    line_h = int(46 * 1.26)
    room = (SIZE - 250 - y) // line_h
    lines = _wrap(draw, _teaser(post_text), teaser_font, max_width)[: max(1, min(MAX_TEASER_LINES, room))]
    for line in lines:
        draw.text((PADDING, y), line, font=teaser_font, fill=text_color)
        y += line_h

    # Футер
    footer_font = _load_font(34)
    draw.text((PADDING, SIZE - 140), footer, font=footer_font, fill=(210, 210, 228))

    filename = uuid.uuid4().hex + ".png"
    img.save(os.path.join(IG_CARDS_DIR, filename), "PNG")
    return filename
