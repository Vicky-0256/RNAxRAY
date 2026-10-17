#!/usr/bin/env python3
"""Render the RNAxRay app icons from the official SVGs in docs/brand/RNAxRay-SVG
(the brand kit, kept locally and not in the repository; the PNGs it writes are).

Writes

  desktop/app/resources/icon.png   the 1024x1024 app icon (MyGo's default):
                                   the light rounded icon on the macOS grid,
                                   an 824 px tile 100 px from each edge
  web/assets/apple-touch-icon.png  180x180, the light full-bleed icon (iOS
                                   rounds the corners itself)

Needs Playwright with Chromium, which draws the SVG gradients exactly:

  pip install playwright && python -m playwright install chromium
  python3 desktop/scripts/make-icon.py
"""
from __future__ import annotations

import base64
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
ICONS = ROOT / "docs/brand/RNAxRay-SVG/05-App图标"

# (source SVG, output, canvas size, tile size; the tile is centred)
RENDERS = [
    (ICONS / "RNAxRay-App图标-浅色-圆角.svg", ROOT / "desktop/app/resources/icon.png", 1024, 824),
    (ICONS / "RNAxRay-App图标-浅色-方形全出血.svg", ROOT / "web/assets/apple-touch-icon.png", 180, 180),
]


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for source, out, size, tile in RENDERS:
            page = browser.new_page(viewport={"width": size, "height": size})
            inset = (size - tile) // 2
            # a data URI: the blank page cannot load file:// images
            src = "data:image/svg+xml;base64," + base64.b64encode(source.read_bytes()).decode()
            page.set_content(
                '<html><body style="margin:0;background:transparent">'
                f'<img src="{src}" style="position:absolute;left:{inset}px;top:{inset}px;'
                f'width:{tile}px;height:{tile}px"></body></html>')
            page.wait_for_load_state("load")
            page.screenshot(path=str(out), omit_background=True)
            page.close()
            print(out)
        browser.close()


if __name__ == "__main__":
    main()
