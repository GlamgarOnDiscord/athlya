from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Callable, Iterable, Sequence

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parent
OUT = ROOT / "exports"
LOGO_OUT = OUT / "logo-system"
PROMPT_OUT = OUT / "prompts"


COLORS = {
    "bg0": "#09090B",
    "bg1": "#18181B",
    "bg2": "#27272A",
    "border": "#3F3F46",
    "text_hi": "#FAFAFA",
    "text_mid": "#A1A1AA",
    "text_lo": "#52525B",
    "lime": "#84CC16",
    "lime_2": "#A3E635",
    "cyan": "#06B6D4",
    "cyan_2": "#38BDF8",
    "amber": "#F59E0B",
    "red": "#EF4444",
    "white": "#FFFFFF",
    "black": "#000000",
    "light_bg": "#FFFFFF",
    "light_surface": "#F4F4F5",
    "light_text": "#09090B",
}


CONCEPTS = [
    {
        "slug": "v1-summit-pulse",
        "name": "Summit Pulse",
        "short": "ATHLYA / SUMMIT PULSE",
        "accent": COLORS["lime"],
        "accent2": COLORS["cyan"],
        "bg": COLORS["bg0"],
        "surface": COLORS["bg1"],
        "copy": "Own your gym. Own your data.",
        "brief": "A monogram as a peak with a pulse crossbar. Best for app icon and premium dark UI.",
    },
    {
        "slug": "v2-glass-grid",
        "name": "Glass Grid",
        "short": "ATHLYA / GLASS GRID",
        "accent": COLORS["cyan_2"],
        "accent2": COLORS["lime_2"],
        "bg": "#07111F",
        "surface": "#102033",
        "copy": "Edge-first fitness operations.",
        "brief": "A controlled glass dashboard language with measured cyan and lime signals.",
    },
    {
        "slug": "v3-edge-motion",
        "name": "Edge Motion",
        "short": "ATHLYA / EDGE MOTION",
        "accent": "#65A30D",
        "accent2": "#0891B2",
        "bg": "#F8FAFC",
        "surface": "#FFFFFF",
        "copy": "Votre salle. Vos donnees. Votre rythme.",
        "brief": "A light-compatible identity with strong black geometry and edge-data motion.",
    },
]


def ensure_dirs() -> None:
    for path in (OUT, LOGO_OUT, PROMPT_OUT):
        path.mkdir(parents=True, exist_ok=True)


def hex_to_rgba(value: str, alpha: int = 255) -> tuple[int, int, int, int]:
    value = value.lstrip("#")
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), alpha)


def rgb(value: str) -> tuple[int, int, int]:
    r, g, b, _ = hex_to_rgba(value)
    return r, g, b


def lerp(a: int, b: int, t: float) -> int:
    return int(a + (b - a) * t)


def blend(c1: str, c2: str, t: float, alpha: int = 255) -> tuple[int, int, int, int]:
    a = rgb(c1)
    b = rgb(c2)
    return (lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), alpha)


def gradient(size: tuple[int, int], stops: Sequence[str], diagonal: bool = True) -> Image.Image:
    w, h = size
    # Build the gradient at a moderate resolution, then upscale. This keeps
    # 4K batch generation fast while preserving smooth backgrounds.
    max_side = 768
    if max(w, h) > max_side:
        if w >= h:
            sw = max_side
            sh = max(1, int(h * (max_side / w)))
        else:
            sh = max_side
            sw = max(1, int(w * (max_side / h)))
    else:
        sw, sh = w, h
    im = Image.new("RGBA", (sw, sh))
    px = im.load()
    stop_count = len(stops) - 1
    for y in range(sh):
        for x in range(sw):
            pos = ((x / max(sw - 1, 1)) + (y / max(sh - 1, 1))) / 2 if diagonal else y / max(sh - 1, 1)
            pos = max(0.0, min(1.0, pos))
            idx = min(stop_count - 1, int(pos * stop_count))
            local = (pos * stop_count) - idx
            px[x, y] = blend(stops[idx], stops[idx + 1], local)
    if (sw, sh) != size:
        im = im.resize(size, Image.Resampling.BICUBIC)
    return im


def font(size: int, weight: str = "regular") -> ImageFont.FreeTypeFont:
    candidates: list[Path] = []
    if weight == "bold":
        candidates.extend([
            Path("C:/Windows/Fonts/segoeuib.ttf"),
            Path("C:/Windows/Fonts/arialbd.ttf"),
        ])
    if weight == "mono":
        candidates.extend([
            Path("C:/Windows/Fonts/consola.ttf"),
            Path("C:/Windows/Fonts/cascadiamono.ttf"),
        ])
    candidates.extend([
        Path("C:/Users/Tom/Downloads/appli-salle-de-sport/apps/web/node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"),
        Path("C:/Windows/Fonts/segoeui.ttf"),
        Path("C:/Windows/Fonts/arial.ttf"),
    ])
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default(size=size)  # type: ignore[call-arg]


def text_size(draw: ImageDraw.ImageDraw, text: str, fnt: ImageFont.FreeTypeFont) -> tuple[int, int]:
    box = draw.textbbox((0, 0), text, font=fnt)
    return box[2] - box[0], box[3] - box[1]


def draw_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    content: str,
    size: int,
    fill: str | tuple[int, int, int, int],
    weight: str = "regular",
    anchor: str = "la",
    spacing: int = 0,
) -> None:
    draw.text(xy, content, font=font(size, weight), fill=fill, anchor=anchor, spacing=spacing)


def rounded(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], radius: int, fill: str | tuple[int, int, int, int], outline: str | tuple[int, int, int, int] | None = None, width: int = 1) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def glow(base: Image.Image, box: tuple[int, int, int, int], color: str, radius: int, blur: int, alpha: int) -> None:
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle(box, radius=radius, fill=hex_to_rgba(color, alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    base.alpha_composite(layer)


def soft_grid(base: Image.Image, color: str, step: int = 96, alpha: int = 22) -> None:
    d = ImageDraw.Draw(base)
    w, h = base.size
    c = hex_to_rgba(color, alpha)
    for x in range(0, w, step):
        d.line([(x, 0), (x, h)], fill=c, width=1)
    for y in range(0, h, step):
        d.line([(0, y), (w, y)], fill=c, width=1)


def data_texture(base: Image.Image, accent: str, accent2: str, dark: bool = True) -> None:
    w, h = base.size
    d = ImageDraw.Draw(base, "RGBA")
    line_alpha = 58 if dark else 44
    for i in range(16):
        y = int(h * (0.12 + i * 0.055))
        points: list[tuple[int, int]] = []
        for x in range(-200, w + 240, 80):
            amp = math.sin((x * 0.006) + i * 0.9) * (22 + i % 4 * 7)
            points.append((x, y + int(amp)))
        c = blend(accent, accent2, i / 15, line_alpha)
        d.line(points, fill=c, width=3)
    for i in range(55):
        x = int((i * 311) % w)
        y = int((i * 197) % h)
        r = 3 + (i % 4)
        c = hex_to_rgba(accent2 if i % 2 else accent, 70 if dark else 55)
        d.ellipse((x - r, y - r, x + r, y + r), fill=c)


def diagonal_band(base: Image.Image, accent: str, accent2: str, alpha: int = 86) -> None:
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    g = gradient(base.size, [accent, accent2])
    mask = Image.new("L", base.size, 0)
    md = ImageDraw.Draw(mask)
    w, h = base.size
    md.polygon([(w * 0.55, -200), (w + 420, -200), (w * 0.72, h + 240), (w * 0.36, h + 240)], fill=alpha)
    g.putalpha(mask)
    layer.alpha_composite(g)
    base.alpha_composite(layer.filter(ImageFilter.GaussianBlur(2)))


def draw_mark(
    canvas: Image.Image,
    concept_index: int,
    box: tuple[int, int, int, int],
    color: str | tuple[int, int, int, int] = COLORS["white"],
    accent: str | None = None,
    accent2: str | None = None,
    gradient_mode: bool = False,
) -> None:
    x0, y0, x1, y1 = box
    size = min(x1 - x0, y1 - y0)
    x0 += ((x1 - x0) - size) // 2
    y0 += ((y1 - y0) - size) // 2
    x = lambda p: int(x0 + p * size)
    y = lambda p: int(y0 + p * size)
    d = ImageDraw.Draw(canvas, "RGBA")

    base_color = color if isinstance(color, tuple) else hex_to_rgba(color)
    ac = accent or COLORS["lime"]
    ac2 = accent2 or COLORS["cyan"]

    if concept_index == 0:
        width = int(size * 0.095)
        d.line([(x(0.26), y(0.78)), (x(0.50), y(0.18)), (x(0.74), y(0.78))], fill=base_color, width=width, joint="curve")
        d.line([(x(0.34), y(0.58)), (x(0.43), y(0.58)), (x(0.48), y(0.47)), (x(0.54), y(0.66)), (x(0.59), y(0.56)), (x(0.68), y(0.56))], fill=hex_to_rgba(ac, 255), width=int(size * 0.052), joint="curve")
        if gradient_mode:
            d.ellipse((x(0.68), y(0.535), x(0.735), y(0.59)), fill=hex_to_rgba(ac2, 255))
    elif concept_index == 1:
        width = int(size * 0.078)
        d.rounded_rectangle((x(0.17), y(0.17), x(0.83), y(0.83)), radius=int(size * 0.22), outline=hex_to_rgba(ac2 if gradient_mode else COLORS["white"], 255) if gradient_mode else base_color, width=width)
        d.line([(x(0.31), y(0.75)), (x(0.50), y(0.28)), (x(0.69), y(0.75))], fill=base_color, width=int(size * 0.085), joint="curve")
        d.line([(x(0.38), y(0.56)), (x(0.48), y(0.56)), (x(0.52), y(0.48)), (x(0.57), y(0.61)), (x(0.64), y(0.53))], fill=hex_to_rgba(ac, 255), width=int(size * 0.041), joint="curve")
    else:
        c = base_color
        d.polygon([(x(0.18), y(0.80)), (x(0.40), y(0.20)), (x(0.51), y(0.20)), (x(0.31), y(0.80))], fill=c)
        d.polygon([(x(0.49), y(0.20)), (x(0.60), y(0.20)), (x(0.83), y(0.80)), (x(0.70), y(0.80))], fill=c)
        d.rounded_rectangle((x(0.37), y(0.52), x(0.64), y(0.61)), radius=int(size * 0.035), fill=hex_to_rgba(ac, 255))
        d.line([(x(0.22), y(0.86)), (x(0.82), y(0.86))], fill=hex_to_rgba(ac2, 230), width=int(size * 0.028))


def save_png(im: Image.Image, path: Path) -> dict[str, object]:
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, optimize=True)
    return {"path": str(path), "width": im.size[0], "height": im.size[1], "mode": im.mode}


def write_svg(concept: dict[str, str], idx: int) -> list[dict[str, object]]:
    slug = concept["slug"]
    base = LOGO_OUT / f"athlya-logo-{slug}-currentcolor.svg"
    if idx == 0:
        body = """
<path d="M 265 795 L 500 175 L 735 795" fill="none" stroke="currentColor" stroke-width="100" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M 350 575 H 430 L 480 465 L 540 665 L 590 555 H 675" fill="none" stroke="currentColor" stroke-width="54" stroke-linecap="round" stroke-linejoin="round"/>
"""
    elif idx == 1:
        body = """
<rect x="170" y="170" width="660" height="660" rx="210" fill="none" stroke="currentColor" stroke-width="78"/>
<path d="M 315 760 L 500 285 L 685 760" fill="none" stroke="currentColor" stroke-width="88" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M 380 560 H 480 L 520 485 L 570 615 L 645 530" fill="none" stroke="currentColor" stroke-width="42" stroke-linecap="round" stroke-linejoin="round"/>
"""
    else:
        body = """
<path d="M 180 805 L 405 205 H 515 L 315 805 Z" fill="currentColor"/>
<path d="M 495 205 H 610 L 835 805 H 700 Z" fill="currentColor"/>
<rect x="370" y="520" width="275" height="92" rx="34" fill="currentColor"/>
<rect x="220" y="855" width="600" height="28" rx="14" fill="currentColor"/>
"""
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" role="img" aria-label="Athlya {concept['name']} logo">
<title>Athlya {concept['name']}</title>
{body}</svg>
"""
    base.write_text(svg, encoding="utf-8")

    grad = LOGO_OUT / f"athlya-logo-{slug}-gradient.svg"
    grad_svg = svg.replace("currentColor", "url(#athlyaPulse)").replace("<title>", f"<defs><linearGradient id=\"athlyaPulse\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"{concept['accent']}\"/><stop offset=\"1\" stop-color=\"{concept['accent2']}\"/></linearGradient></defs>\n<title>")
    grad.write_text(grad_svg, encoding="utf-8")
    return [
        {"path": str(base), "width": 1000, "height": 1000, "mode": "svg"},
        {"path": str(grad), "width": 1000, "height": 1000, "mode": "svg"},
    ]


def make_logo_assets() -> list[dict[str, object]]:
    manifest: list[dict[str, object]] = []
    for idx, concept in enumerate(CONCEPTS):
        slug = concept["slug"]
        manifest.extend(write_svg(concept, idx))
        for variant, color, bg in [
            ("mark-white-transparent", COLORS["white"], None),
            ("mark-black-transparent", COLORS["black"], None),
            ("mark-lime-transparent", concept["accent"], None),
        ]:
            im = Image.new("RGBA", (4096, 4096), (0, 0, 0, 0))
            draw_mark(im, idx, (520, 520, 3576, 3576), color=color, accent=concept["accent"], accent2=concept["accent2"], gradient_mode=variant.startswith("mark-lime"))
            manifest.append(save_png(im, LOGO_OUT / f"athlya-logo-{slug}-{variant}-4096.png"))

        app = gradient((4096, 4096), [concept["accent"], concept["accent2"]])
        overlay = Image.new("RGBA", app.size, (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay, "RGBA")
        od.rounded_rectangle((0, 0, 4095, 4095), radius=920, fill=(0, 0, 0, 0))
        app.putalpha(255)
        shade = Image.new("RGBA", app.size, (0, 0, 0, 0))
        sd = ImageDraw.Draw(shade, "RGBA")
        sd.ellipse((-900, -900, 3300, 3300), fill=(255, 255, 255, 38))
        sd.ellipse((1500, 1900, 5100, 5300), fill=(0, 0, 0, 72))
        app.alpha_composite(shade.filter(ImageFilter.GaussianBlur(65)))
        draw_mark(app, idx, (820, 820, 3276, 3276), color=COLORS["white"], accent=COLORS["white"], accent2=COLORS["white"])
        manifest.append(save_png(app, LOGO_OUT / f"athlya-app-icon-{slug}-4096.png"))

        word = Image.new("RGBA", (4096, 1152), (0, 0, 0, 0))
        draw_mark(word, idx, (180, 205, 900, 925), color=COLORS["white"], accent=concept["accent"], accent2=concept["accent2"], gradient_mode=True)
        wd = ImageDraw.Draw(word, "RGBA")
        draw_text(wd, (980, 570), "Athlya", 430, COLORS["white"], "regular", anchor="lm")
        draw_text(wd, (990, 825), concept["copy"], 86, hex_to_rgba(COLORS["text_mid"], 255), "regular", anchor="la")
        manifest.append(save_png(word, LOGO_OUT / f"athlya-wordmark-{slug}-white-4096x1152.png"))
    return manifest


def pill(draw: ImageDraw.ImageDraw, xy: tuple[int, int], label: str, color: str, text_color: str, size: int = 42) -> None:
    f = font(size, "regular")
    w, h = text_size(draw, label, f)
    x, y = xy
    rounded(draw, (x, y, x + w + 54, y + h + 34), 999, hex_to_rgba(color, 36), hex_to_rgba(color, 150), 2)
    draw.text((x + 27, y + 16), label, font=f, fill=hex_to_rgba(text_color, 255))


def draw_palette(draw: ImageDraw.ImageDraw, x: int, y: int, concept: dict[str, str], light: bool = False) -> None:
    swatches = [
        ("bg", concept["bg"]),
        ("surface", concept["surface"]),
        ("lime", concept["accent"]),
        ("cyan", concept["accent2"]),
        ("text", COLORS["black"] if light else COLORS["white"]),
        ("muted", COLORS["text_mid"]),
    ]
    for i, (name, val) in enumerate(swatches):
        sx = x + i * 215
        rounded(draw, (sx, y, sx + 160, y + 160), 36, val, hex_to_rgba(COLORS["border"], 120), 2)
        draw_text(draw, (sx, y + 205), name.upper(), 30, COLORS["text_mid"] if not light else "#475569", "mono")
        draw_text(draw, (sx, y + 250), val.upper(), 34, COLORS["white"] if not light else COLORS["light_text"], "mono")


def draw_metric_card(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], title: str, value: str, delta: str, accent: str, dark: bool = True) -> None:
    fill = hex_to_rgba(COLORS["bg1"] if dark else COLORS["white"], 218)
    outline = hex_to_rgba(COLORS["border"], 170 if dark else 90)
    rounded(draw, box, 34, fill, outline, 2)
    x0, y0, x1, y1 = box
    draw_text(draw, (x0 + 42, y0 + 56), title.upper(), 32, COLORS["text_mid"] if dark else "#64748B", "mono")
    draw_text(draw, (x0 + 42, y0 + 142), value, 84, COLORS["white"] if dark else COLORS["light_text"], "bold")
    pill(draw, (x0 + 42, y1 - 88), delta, accent, COLORS["white"] if dark else COLORS["light_text"], 30)
    cx = x1 - 125
    cy = y0 + 124
    draw.arc((cx - 72, cy - 72, cx + 72, cy + 72), 120, 420, fill=hex_to_rgba(accent, 255), width=17)
    draw.arc((cx - 72, cy - 72, cx + 72, cy + 72), 420, 480, fill=hex_to_rgba(COLORS["border"], 150), width=17)


def brand_board(concept: dict[str, str], idx: int) -> Image.Image:
    dark = idx != 2
    bg = gradient((3840, 2160), [concept["bg"], "#020617" if dark else "#E2E8F0", concept["bg"]])
    if not dark:
        bg = gradient((3840, 2160), ["#FFFFFF", "#E2E8F0", "#F8FAFC"])
    soft_grid(bg, concept["accent2"], step=112, alpha=16 if dark else 22)
    data_texture(bg, concept["accent"], concept["accent2"], dark=dark)
    diagonal_band(bg, concept["accent"], concept["accent2"], alpha=54 if dark else 38)
    d = ImageDraw.Draw(bg, "RGBA")
    text_hi = COLORS["white"] if dark else COLORS["light_text"]
    text_mid = COLORS["text_mid"] if dark else "#475569"
    panel_fill = hex_to_rgba(COLORS["bg1"] if dark else COLORS["white"], 214)
    outline = hex_to_rgba(COLORS["border"], 170 if dark else 80)

    draw_text(d, (170, 150), concept["short"], 46, concept["accent"], "mono")
    draw_text(d, (170, 270), concept["name"], 156, text_hi, "bold")
    draw_text(d, (178, 450), concept["copy"], 74, text_mid, "regular")
    rounded(d, (165, 570, 1580, 1820), 52, panel_fill, outline, 2)
    draw_mark(bg, idx, (250, 670, 850, 1270), color=text_hi, accent=concept["accent"], accent2=concept["accent2"], gradient_mode=True)
    draw_text(d, (900, 885), "Athlya", 188, text_hi, "regular", anchor="lm")
    draw_text(d, (910, 1040), concept["brief"], 42, text_mid, "regular")
    draw_palette(d, 250, 1320, concept, light=not dark)

    rounded(d, (1705, 570, 3635, 1820), 52, panel_fill, outline, 2)
    draw_text(d, (1790, 690), "Product Language", 72, text_hi, "bold")
    draw_text(d, (1790, 795), "Dense operational UI, quiet dark surfaces, measured pulse accents.", 44, text_mid, "regular")
    draw_metric_card(d, (1790, 940, 2325, 1215), "Bookings", "2,418", "+12.4%", concept["accent"], dark)
    draw_metric_card(d, (2370, 940, 2905, 1215), "Revenue", "18.2k", "+8.1%", concept["accent2"], dark)
    draw_metric_card(d, (2950, 940, 3485, 1215), "Churn", "2.1%", "-0.6%", COLORS["amber"], dark)

    rounded(d, (1790, 1340, 3485, 1675), 34, hex_to_rgba(COLORS["bg2"] if dark else "#F8FAFC", 205), outline, 2)
    draw_text(d, (1835, 1410), "10:00  HIIT Strength", 46, text_hi, "bold")
    draw_text(d, (1835, 1490), "Coach Karim  |  18 / 20 seats  |  waitlist off", 34, text_mid, "regular")
    d.rounded_rectangle((1835, 1575, 3040, 1600), radius=13, fill=hex_to_rgba(COLORS["border"], 150))
    d.rounded_rectangle((1835, 1575, 2890, 1600), radius=13, fill=hex_to_rgba(concept["accent"], 255))
    rounded(d, (3075, 1540, 3400, 1635), 999, hex_to_rgba(concept["accent"], 255), None)
    draw_text(d, (3238, 1587), "Reserve", 36, COLORS["black"] if concept["accent"].lower() in ("#84cc16", "#a3e635", "#65a30d") else COLORS["white"], "bold", anchor="mm")

    return bg


def banner(concept: dict[str, str], idx: int) -> Image.Image:
    dark = idx != 2
    im = gradient((3840, 2160), [concept["bg"], "#020617" if dark else "#FFFFFF", concept["surface"]])
    soft_grid(im, concept["accent2"], 128, 18 if dark else 16)
    data_texture(im, concept["accent"], concept["accent2"], dark)
    glow(im, (1880, 160, 3720, 1970), concept["accent"], 120, 180, 70 if dark else 44)
    diagonal_band(im, concept["accent"], concept["accent2"], 92 if dark else 68)
    d = ImageDraw.Draw(im, "RGBA")
    text_hi = COLORS["white"] if dark else COLORS["light_text"]
    text_mid = COLORS["text_mid"] if dark else "#475569"
    draw_mark(im, idx, (2300, 560, 3370, 1630), color=text_hi, accent=concept["accent"], accent2=concept["accent2"], gradient_mode=True)
    draw_text(d, (220, 350), "Athlya", 258, text_hi, "regular")
    draw_text(d, (235, 650), concept["copy"], 88, text_mid, "regular")
    pill(d, (240, 815), "Open-source fitness platform", concept["accent"], text_hi if dark else COLORS["light_text"], 42)
    pill(d, (800, 815), "RGPD-first", concept["accent2"], text_hi if dark else COLORS["light_text"], 42)
    draw_text(d, (240, 1165), "Reservations, access, members, billing and progress data in one resilient product.", 62, text_mid, "regular")
    d.line((240, 1420, 1440, 1420), fill=hex_to_rgba(concept["accent"], 255), width=10)
    for i, val in enumerate(["p99 < 500 ms", "3 taps to book", "data export native"]):
        draw_text(d, (250, 1540 + i * 112), val, 58, text_hi, "regular")
    return im


def og_image(concept: dict[str, str], idx: int) -> Image.Image:
    dark = idx != 2
    im = gradient((3840, 2016), [concept["bg"], "#020617" if dark else "#F8FAFC", concept["surface"]])
    soft_grid(im, concept["accent2"], 120, 20 if dark else 18)
    data_texture(im, concept["accent"], concept["accent2"], dark)
    d = ImageDraw.Draw(im, "RGBA")
    text_hi = COLORS["white"] if dark else COLORS["light_text"]
    text_mid = COLORS["text_mid"] if dark else "#475569"
    draw_mark(im, idx, (2440, 430, 3370, 1360), color=text_hi, accent=concept["accent"], accent2=concept["accent2"], gradient_mode=True)
    draw_text(d, (250, 315), "Athlya", 252, text_hi, "regular")
    draw_text(d, (260, 625), concept["copy"], 92, text_mid, "regular")
    draw_text(d, (260, 900), "Open-source fitness operations for studios that own their data.", 74, text_hi, "regular")
    pill(d, (260, 1180), "Dark-first", concept["accent"], text_hi if dark else COLORS["light_text"], 44)
    pill(d, (650, 1180), "Multi-tenant", concept["accent2"], text_hi if dark else COLORS["light_text"], 44)
    pill(d, (1090, 1180), "Edge-ready", concept["accent"], text_hi if dark else COLORS["light_text"], 44)
    return im


def draw_sidebar(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], dark: bool, concept: dict[str, str], idx: int, canvas: Image.Image, active: str) -> None:
    x0, y0, x1, y1 = box
    rounded(draw, box, 38, hex_to_rgba(COLORS["bg1"] if dark else COLORS["white"], 232), hex_to_rgba(COLORS["border"], 160 if dark else 90), 2)
    draw_mark(canvas, idx, (x0 + 42, y0 + 46, x0 + 128, y0 + 132), COLORS["white"] if dark else COLORS["light_text"], concept["accent"], concept["accent2"], True)
    draw_text(draw, (x0 + 150, y0 + 92), "Athlya", 50, COLORS["white"] if dark else COLORS["light_text"], "regular", anchor="lm")
    items = ["Overview", "Planning", "Members", "Branding", "Billing"]
    for i, item in enumerate(items):
        yy = y0 + 220 + i * 92
        is_active = item == active
        if is_active:
            rounded(draw, (x0 + 30, yy - 22, x1 - 30, yy + 52), 22, hex_to_rgba(concept["accent"], 42), hex_to_rgba(concept["accent"], 180), 2)
        draw_text(draw, (x0 + 80, yy + 16), item, 38, COLORS["white"] if dark or is_active else COLORS["light_text"], "regular", anchor="lm")


def draw_chart(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], concept: dict[str, str], dark: bool) -> None:
    x0, y0, x1, y1 = box
    rounded(draw, box, 34, hex_to_rgba(COLORS["bg1"] if dark else COLORS["white"], 230), hex_to_rgba(COLORS["border"], 150 if dark else 90), 2)
    draw_text(draw, (x0 + 44, y0 + 62), "Booking velocity", 44, COLORS["white"] if dark else COLORS["light_text"], "bold")
    draw_text(draw, (x0 + 44, y0 + 120), "Last 14 days", 30, COLORS["text_mid"] if dark else "#64748B", "regular")
    area = (x0 + 60, y0 + 180, x1 - 55, y1 - 70)
    for i in range(5):
        y = area[1] + int((area[3] - area[1]) * i / 4)
        draw.line((area[0], y, area[2], y), fill=hex_to_rgba(COLORS["border"], 90 if dark else 70), width=1)
    pts: list[tuple[int, int]] = []
    for i in range(14):
        t = i / 13
        val = 0.55 + 0.26 * math.sin(i * 0.8) + 0.16 * math.sin(i * 1.9)
        val = max(0.12, min(0.95, val))
        x = int(area[0] + t * (area[2] - area[0]))
        y = int(area[3] - val * (area[3] - area[1]))
        pts.append((x, y))
    draw.line(pts, fill=hex_to_rgba(concept["accent"], 255), width=8, joint="curve")
    for p in pts[::3]:
        draw.ellipse((p[0] - 10, p[1] - 10, p[0] + 10, p[1] + 10), fill=hex_to_rgba(concept["accent2"], 255))


def web_member_mockup(concept: dict[str, str], idx: int) -> Image.Image:
    dark = idx != 2
    im = gradient((3840, 2160), [concept["bg"], "#020617" if dark else "#F8FAFC", concept["surface"]])
    soft_grid(im, concept["accent2"], 128, 12 if dark else 16)
    d = ImageDraw.Draw(im, "RGBA")
    text_hi = COLORS["white"] if dark else COLORS["light_text"]
    text_mid = COLORS["text_mid"] if dark else "#64748B"
    draw_sidebar(d, (150, 150, 560, 2010), dark, concept, idx, im, "Planning")
    draw_text(d, (650, 210), "Good morning, Karim", 78, text_hi, "bold")
    draw_text(d, (655, 300), "3 sessions booked this week. Next check-in opens in 42 min.", 42, text_mid, "regular")
    pill(d, (2920, 200), "Paris 11", concept["accent2"], text_hi if dark else COLORS["light_text"], 36)
    pill(d, (3200, 200), "Unlimited", concept["accent"], text_hi if dark else COLORS["light_text"], 36)

    draw_metric_card(d, (650, 430, 1155, 710), "Week load", "7.4h", "+1.2h", concept["accent"], dark)
    draw_metric_card(d, (1200, 430, 1705, 710), "Streak", "18d", "+3", concept["accent2"], dark)
    draw_metric_card(d, (1750, 430, 2255, 710), "PRs", "4", "+2", COLORS["amber"], dark)

    rounded(d, (650, 800, 2260, 1850), 44, hex_to_rgba(COLORS["bg1"] if dark else COLORS["white"], 228), hex_to_rgba(COLORS["border"], 150 if dark else 90), 2)
    draw_text(d, (720, 895), "Available classes", 58, text_hi, "bold")
    classes = [
        ("07:00", "Mobility Flow", "12 / 16", concept["accent"]),
        ("12:30", "HIIT Strength", "18 / 20", COLORS["amber"]),
        ("18:00", "Boxing Core", "Full", COLORS["red"]),
        ("19:15", "Endurance Ride", "9 / 18", concept["accent2"]),
    ]
    for i, (time, name, seats, color) in enumerate(classes):
        y = 1030 + i * 185
        rounded(d, (720, y, 2185, y + 135), 30, hex_to_rgba(COLORS["bg2"] if dark else "#F8FAFC", 214), hex_to_rgba(COLORS["border"], 120 if dark else 80), 2)
        draw_text(d, (775, y + 70), time, 42, color, "mono", anchor="lm")
        draw_text(d, (980, y + 58), name, 44, text_hi, "bold", anchor="lm")
        draw_text(d, (980, y + 104), "Coach Marie", 30, text_mid, "regular", anchor="lm")
        pill(d, (1880, y + 35), seats, color, text_hi if dark else COLORS["light_text"], 30)

    rounded(d, (2350, 430, 3610, 1850), 44, hex_to_rgba(COLORS["bg1"] if dark else COLORS["white"], 226), hex_to_rgba(COLORS["border"], 150 if dark else 90), 2)
    draw_text(d, (2430, 535), "Check-in", 58, text_hi, "bold")
    draw_text(d, (2430, 610), "Rotating QR token", 36, text_mid, "regular")
    qx, qy, qs = 2580, 760, 720
    rounded(d, (qx, qy, qx + qs, qy + qs), 42, COLORS["white"], None)
    for yy in range(13):
        for xx in range(13):
            if (xx * 7 + yy * 5 + xx * yy) % 4 in (0, 1):
                d.rectangle((qx + 70 + xx * 44, qy + 70 + yy * 44, qx + 98 + xx * 44, qy + 98 + yy * 44), fill=hex_to_rgba(COLORS["black"], 255))
    draw_mark(im, idx, (qx + 285, qy + 285, qx + 435, qy + 435), COLORS["black"], concept["accent"], concept["accent2"])
    draw_text(d, (2430, 1605), "Progress", 52, text_hi, "bold")
    for i, label in enumerate(["Strength", "Cardio", "Recovery"]):
        y = 1690 + i * 68
        draw_text(d, (2430, y), label, 32, text_mid, "regular")
        d.rounded_rectangle((2660, y + 8, 3420, y + 30), radius=12, fill=hex_to_rgba(COLORS["border"], 120))
        d.rounded_rectangle((2660, y + 8, 2660 + int(760 * (0.58 + i * 0.12)), y + 30), radius=12, fill=hex_to_rgba(concept["accent"] if i != 1 else concept["accent2"], 255))
    return im


def studio_admin_mockup(concept: dict[str, str], idx: int) -> Image.Image:
    dark = idx != 2
    im = gradient((3840, 2160), [concept["bg"], "#020617" if dark else "#F8FAFC", concept["surface"]])
    soft_grid(im, concept["accent2"], 128, 12 if dark else 16)
    d = ImageDraw.Draw(im, "RGBA")
    text_hi = COLORS["white"] if dark else COLORS["light_text"]
    text_mid = COLORS["text_mid"] if dark else "#64748B"
    draw_sidebar(d, (150, 150, 560, 2010), dark, concept, idx, im, "Overview")
    draw_text(d, (650, 210), "Studio cockpit", 78, text_hi, "bold")
    draw_text(d, (655, 300), "Live planning, member capacity and revenue health.", 42, text_mid, "regular")

    draw_metric_card(d, (650, 430, 1155, 710), "Classes", "42", "+6", concept["accent"], dark)
    draw_metric_card(d, (1200, 430, 1705, 710), "Members", "486", "+31", concept["accent2"], dark)
    draw_metric_card(d, (1750, 430, 2255, 710), "MRR", "18.2k", "+8.1%", COLORS["amber"], dark)
    draw_metric_card(d, (2300, 430, 2805, 710), "No-show", "4.8%", "-1.2%", concept["accent"], dark)
    draw_chart(d, (650, 800, 2255, 1510), concept, dark)

    rounded(d, (2300, 800, 3610, 1510), 44, hex_to_rgba(COLORS["bg1"] if dark else COLORS["white"], 226), hex_to_rgba(COLORS["border"], 150 if dark else 90), 2)
    draw_text(d, (2370, 900), "Today timeline", 52, text_hi, "bold")
    schedule = [
        ("07:00", "Mobility Flow", "12/16"),
        ("10:00", "HIIT Strength", "18/20"),
        ("12:30", "Boxing Core", "20/20"),
        ("18:00", "Endurance Ride", "9/18"),
    ]
    for i, (time, name, seats) in enumerate(schedule):
        y = 1010 + i * 105
        draw_text(d, (2380, y + 34), time, 34, concept["accent"], "mono", anchor="lm")
        draw_text(d, (2555, y + 34), name, 36, text_hi, "bold", anchor="lm")
        draw_text(d, (3340, y + 34), seats, 34, text_mid, "mono", anchor="rm")
        d.line((2380, y + 82, 3520, y + 82), fill=hex_to_rgba(COLORS["border"], 120 if dark else 75), width=1)

    rounded(d, (650, 1600, 3610, 2010), 44, hex_to_rgba(COLORS["bg1"] if dark else COLORS["white"], 226), hex_to_rgba(COLORS["border"], 150 if dark else 90), 2)
    draw_text(d, (725, 1700), "Member queue", 52, text_hi, "bold")
    headers = ["Name", "Plan", "Last check-in", "Status", "Action"]
    xs = [725, 1280, 1820, 2430, 3050]
    for x, h in zip(xs, headers):
        draw_text(d, (x, 1780), h.upper(), 28, text_mid, "mono")
    rows = [
        ("Sarah M.", "Unlimited", "6 min ago", "Active", "Open"),
        ("Nadia B.", "10 pack", "Yesterday", "Renew soon", "Message"),
        ("Lucas R.", "Unlimited", "2 days ago", "Active", "Open"),
    ]
    for i, row in enumerate(rows):
        y = 1845 + i * 55
        for x, cell in zip(xs, row):
            draw_text(d, (x, y), cell, 32, text_hi if cell not in ("Renew soon", "Message") else concept["accent"], "regular")
    return im


def contact_sheet(files: Sequence[Path]) -> Image.Image:
    im = gradient((3840, 2160), [COLORS["bg0"], "#020617", COLORS["bg1"]])
    d = ImageDraw.Draw(im, "RGBA")
    draw_text(d, (120, 120), "Athlya asset iterations", 88, COLORS["white"], "bold")
    draw_text(d, (124, 220), "Modern DA preview sheet - exports live in this folder.", 42, COLORS["text_mid"], "regular")
    thumb_w, thumb_h = 710, 398
    x0, y0 = 120, 340
    for i, path in enumerate(files[:15]):
        r = i // 5
        c = i % 5
        x = x0 + c * 740
        y = y0 + r * 560
        src = Image.open(path).convert("RGBA")
        src.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
        rounded(d, (x - 10, y - 10, x + thumb_w + 10, y + thumb_h + 10), 28, hex_to_rgba(COLORS["bg1"], 230), hex_to_rgba(COLORS["border"], 150), 2)
        im.alpha_composite(src, (x + (thumb_w - src.width) // 2, y + (thumb_h - src.height) // 2))
        draw_text(d, (x, y + thumb_h + 48), path.stem[:34], 28, COLORS["text_mid"], "mono")
    return im


def logo_contact_sheet() -> Image.Image:
    im = gradient((3840, 2160), [COLORS["bg0"], "#020617", COLORS["bg1"]])
    d = ImageDraw.Draw(im, "RGBA")
    draw_text(d, (120, 120), "Athlya logo system", 88, COLORS["white"], "bold")
    draw_text(d, (124, 220), "CurrentColor SVG masters, transparent 4096 PNG marks, app icons and wordmarks.", 42, COLORS["text_mid"], "regular")
    briefs = [
        ("Peak plus pulse crossbar.", "Strongest core logo route."),
        ("Rounded data-gate mark.", "Best for dashboard/admin tone."),
        ("Sharp light-compatible A.", "Best for austere B2B surfaces."),
    ]

    for idx, concept in enumerate(CONCEPTS):
        y = 380 + idx * 560
        draw_text(d, (130, y + 62), concept["name"], 54, COLORS["white"], "bold")
        draw_text(d, (130, y + 130), briefs[idx][0], 32, COLORS["text_mid"], "regular")
        draw_text(d, (130, y + 176), briefs[idx][1], 32, COLORS["text_mid"], "regular")

        rounded(d, (800, y, 1180, y + 380), 42, hex_to_rgba(COLORS["bg1"], 245), hex_to_rgba(COLORS["border"], 160), 2)
        draw_mark(im, idx, (880, y + 70, 1100, y + 290), COLORS["white"], concept["accent"], concept["accent2"], True)
        draw_text(d, (990, y + 345), "white", 28, COLORS["text_mid"], "mono", anchor="mm")

        rounded(d, (1280, y, 1660, y + 380), 42, COLORS["white"], hex_to_rgba(COLORS["border"], 160), 2)
        draw_mark(im, idx, (1360, y + 70, 1580, y + 290), COLORS["black"], concept["accent"], concept["accent2"], False)
        draw_text(d, (1470, y + 345), "black", 28, "#475569", "mono", anchor="mm")

        app_path = LOGO_OUT / f"athlya-app-icon-{concept['slug']}-4096.png"
        if app_path.exists():
            icon = Image.open(app_path).convert("RGBA")
            icon.thumbnail((380, 380), Image.Resampling.LANCZOS)
            im.alpha_composite(icon, (1760, y))
        draw_text(d, (1950, y + 425), "app icon", 28, COLORS["text_mid"], "mono", anchor="mm")

        rounded(d, (2300, y + 80, 3560, y + 300), 34, hex_to_rgba(COLORS["bg1"], 230), hex_to_rgba(COLORS["border"], 150), 2)
        draw_mark(im, idx, (2360, y + 112, 2520, y + 272), COLORS["white"], concept["accent"], concept["accent2"], True)
        draw_text(d, (2590, y + 190), "Athlya", 118, COLORS["white"], "regular", anchor="lm")
        draw_text(d, (2595, y + 275), concept["copy"], 34, COLORS["text_mid"], "regular")

    return im


def make_og_standard_derivatives() -> list[dict[str, object]]:
    items: list[dict[str, object]] = []
    for concept in CONCEPTS:
        src = OUT / f"athlya-og-{concept['slug']}-3840x2016.png"
        if not src.exists():
            continue
        with Image.open(src).convert("RGBA") as im:
            small = im.resize((1200, 630), Image.Resampling.LANCZOS)
            items.append(save_png(small, OUT / f"athlya-og-{concept['slug']}-1200x630.png"))
            mid = im.resize((2400, 1260), Image.Resampling.LANCZOS)
            items.append(save_png(mid, OUT / f"athlya-og-{concept['slug']}-2400x1260.png"))
    return items


def write_prompts() -> dict[str, object]:
    prompts = [
        ("logo-brand", "Logo system", "Create a vector-friendly Athlya monogram A, mountain peak + pulse signal, adaptable to monochrome, dark and light backgrounds. Dark-first premium fitness SaaS identity, lime #84CC16 and cyan #06B6D4 accents, no mascot, no athlete figure, no generic dumbbell, no watermark."),
        ("logo-brand", "Brand identity board", "Create a 4K brand identity board for Athlya, open-source fitness platform. Dark zinc background #09090B, Geist-like geometric typography, lime and cyan accents, palette swatches, logo lockups, data visualization components, refined SaaS fitness mood, no figurative illustration."),
        ("ads-marketing", "Banner", "Create a 4K cinematic web banner for Athlya. Real product signal first: abstract high-contrast fitness motion, data lines, progress rings, dark mode, lime/cyan gradient, large wordmark space, premium and operational, no stock-photo posing, no emoji, no watermark."),
        ("ui-mockup", "Member web app", "Create a 4K high-fidelity UI mockup for the Athlya member web app: booking classes, QR check-in, progress data, dark-first Runna/Bevel-inspired style, dense but airy layout, Geist typography, lime/cyan accents, accessible contrast, no marketing landing page."),
        ("ui-mockup", "Studio admin", "Create a 4K high-fidelity UI mockup for the Athlya studio admin app: planning, members, branding, billing, metrics and timeline. Dark operational SaaS dashboard, restrained panels, data-dense but calm, lime/cyan accents, no nested decorative cards, no mascot."),
        ("ads-marketing", "OG image", "Create a 4K-width Open Graph image for Athlya with text 'Athlya' and 'Own your gym. Own your data.' Dark-first premium fitness software, abstract data visualization, lime/cyan accents, no athlete photo, no watermark."),
    ]
    lines = ["# Athlya imagegen prompt set", "", "Generated from project.md DA for later AI reruns.", ""]
    for use_case, asset, prompt in prompts:
        lines.extend([
            f"## {asset}",
            "",
            f"Use case: {use_case}",
            f"Asset type: {asset}",
            f"Primary request: {prompt}",
            "Constraints: 4K where applicable; dark-first; no figurative illustration; no Basic-Fit yellow; no motivational emoji; no watermark.",
            "",
        ])
    path = PROMPT_OUT / "imagegen-prompts.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    return {"path": str(path), "mode": "markdown"}


def write_readme(manifest: Sequence[dict[str, object]]) -> dict[str, object]:
    readme = OUT / "README.md"
    counts = {
        "png": sum(1 for item in manifest if str(item["path"]).lower().endswith(".png")),
        "svg": sum(1 for item in manifest if str(item["path"]).lower().endswith(".svg")),
    }
    lines = [
        "# Athlya temporary asset iterations",
        "",
        "Scope: generated only inside `.kiro/temp/athlya-assets/exports`.",
        "",
        "Important: the built-in image generation tool was not exposed in this session and OPENAI_API_KEY was not set for the skill CLI fallback. These files are procedural 4K exports plus a ready-to-rerun imagegen prompt set.",
        "",
        f"PNG files: {counts['png']}",
        f"SVG files: {counts['svg']}",
        "",
        "Creative routes:",
        "- v1-summit-pulse: strongest app icon and core logo direction.",
        "- v2-glass-grid: most premium admin/dashboard direction.",
        "- v3-edge-motion: light-mode compatible route.",
        "",
        "Key folders:",
        "- `logo-system/`: currentColor SVG masters, gradient SVGs, transparent 4096 PNG marks, app icons, wordmarks.",
        "- `prompts/`: imagegen prompts normalized from the project DA.",
        "- root exports: 4K brand boards, banners, OG images, member web mockups, studio admin mockups, contact sheet.",
    ]
    readme.write_text("\n".join(lines), encoding="utf-8")
    return {"path": str(readme), "mode": "markdown"}


def main() -> None:
    ensure_dirs()
    manifest: list[dict[str, object]] = []
    manifest.extend(make_logo_assets())

    sheet_sources: list[Path] = []
    for idx, concept in enumerate(CONCEPTS):
        slug = concept["slug"]
        outputs = [
            (brand_board(concept, idx), OUT / f"athlya-brand-identity-{slug}-3840x2160.png"),
            (banner(concept, idx), OUT / f"athlya-banner-{slug}-3840x2160.png"),
            (og_image(concept, idx), OUT / f"athlya-og-{slug}-3840x2016.png"),
            (web_member_mockup(concept, idx), OUT / f"athlya-web-member-ui-{slug}-3840x2160.png"),
            (studio_admin_mockup(concept, idx), OUT / f"athlya-studio-admin-ui-{slug}-3840x2160.png"),
        ]
        for im, path in outputs:
            manifest.append(save_png(im, path))
            sheet_sources.append(path)

    sheet = contact_sheet(sheet_sources)
    manifest.append(save_png(sheet, OUT / "athlya-contact-sheet-iterations-3840x2160.png"))
    manifest.append(save_png(logo_contact_sheet(), OUT / "athlya-logo-system-contact-sheet-3840x2160.png"))
    manifest.extend(make_og_standard_derivatives())
    manifest.append(write_prompts())
    manifest.append(write_readme(manifest))

    manifest_path = OUT / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(OUT), "count": len(manifest), "manifest": str(manifest_path)}, indent=2))


if __name__ == "__main__":
    main()
