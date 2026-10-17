#!/usr/bin/env python3
"""Draw the RNAxRay mark of web/assets/rnaxray-logo.png as vector shapes.

The web logo is a 158x67 PNG: an RNAxRay wordmark beside two strands (teal,
purple) joined by three base-pair rungs (navy). This redraws the mark from its
measured geometry (units of the 67 px tall original) so it stays sharp at
any size, and writes

  desktop/app/resources/icon.png   the 1024x1024 app icon (MyGo's default)
  desktop/app/views/assets/rnaxray-mark.svg   the mark alone (in-app use)

Needs Pillow:  python3 desktop/scripts/make-icon.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
TEAL, PURPLE, NAVY = (0, 160, 157), (106, 79, 242), (19, 44, 71)

# Mark geometry in the original's pixels (it is 51 wide, 67 high). A strand
# is a straight bar whose ends swell outwards into round bulbs: the convex
# hull of each bulb and a circle of the bar's width just inside the bar.
MARK_W, MARK_H = 51.0, 67.0
BAR_X, BAR_W = 11.2, 9.4                 # centre and width of the left bar
BAR_TOP, BAR_BOTTOM = 15.0, 52.0         # where the bulbs join it
BULBS = [(7.7, 7.2, 7.4), (7.7, 59.8, 7.4)]  # (x, y, r), left strand
RUNGS = [(18.0, 21.0, 33.0, 27.0), (18.0, 31.0, 33.0, 37.0), (18.0, 41.0, 33.0, 47.0)]


def mirror(x: float) -> float:
    return MARK_W - x


def _hull(points):
    points = sorted(set(points))
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in points:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(points):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _circle(x, y, r, n=72):
    import math
    return [(round(x + r * math.cos(2 * math.pi * i / n), 3), round(y + r * math.sin(2 * math.pi * i / n), 3)) for i in range(n)]


def strand_shapes(flip: bool):
    """Polygons (in mark units) of one strand: two end hulls and the bar."""
    f = mirror if flip else (lambda x: x)
    shapes = []
    for (x, y, r), join in zip(BULBS, (BAR_TOP, BAR_BOTTOM)):
        hull = _hull(_circle(f(x), y, r) + _circle(f(BAR_X), join, BAR_W / 2))
        shapes.append(hull)
    left, right = sorted((f(BAR_X - BAR_W / 2), f(BAR_X + BAR_W / 2)))
    shapes.append([(left, BAR_TOP), (right, BAR_TOP), (right, BAR_BOTTOM), (left, BAR_BOTTOM)])
    return shapes


def svg() -> str:
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{MARK_W:g}" height="{MARK_H:g}" viewBox="0 0 {MARK_W:g} {MARK_H:g}">']
    for flip, color in ((False, TEAL), (True, PURPLE)):
        hex_ = "#%02X%02X%02X" % color
        for shape in strand_shapes(flip):
            d = "M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in shape) + " Z"
            parts.append(f'<path d="{d}" fill="{hex_}"/>')
    for x0, y0, x1, y1 in RUNGS:
        parts.append(f'<rect class="rung" x="{x0:g}" y="{y0:g}" width="{x1 - x0:g}" height="{y1 - y0:g}" rx="3" fill="#%02X%02X%02X"/>' % NAVY)
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


def draw_mark(scale: float, ox: float, oy: float, image: Image.Image) -> None:
    d = ImageDraw.Draw(image)
    for flip, color in ((False, TEAL), (True, PURPLE)):
        for shape in strand_shapes(flip):
            d.polygon([(ox + x * scale, oy + y * scale) for x, y in shape], fill=color)
    for x0, y0, x1, y1 in RUNGS:
        d.rounded_rectangle([ox + x0 * scale, oy + y0 * scale, ox + x1 * scale, oy + y1 * scale], radius=3 * scale, fill=NAVY)


def icon(size: int = 1024) -> Image.Image:
    """A white rounded square (macOS icon grid: 824 of 1024) with the mark."""
    ss = 4
    big = size * ss
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(image)
    inset, side = 100 * ss * size // 1024, 824 * ss * size // 1024
    d.rounded_rectangle([inset, inset, inset + side, inset + side], radius=185 * ss * size // 1024, fill=(255, 255, 255, 255))
    scale = side * 0.62 / MARK_H
    ox = inset + (side - MARK_W * scale) / 2
    oy = inset + (side - MARK_H * scale) / 2
    draw_mark(scale, ox, oy, image)
    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    out_svg = ROOT / "desktop/app/views/assets/rnaxray-mark.svg"
    out_svg.parent.mkdir(parents=True, exist_ok=True)
    out_svg.write_text(svg(), encoding="utf-8")
    out_icon = ROOT / "desktop/app/resources/icon.png"
    icon().save(out_icon)
    print(out_svg)
    print(out_icon)


if __name__ == "__main__":
    main()
