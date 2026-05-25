# -*- coding: utf-8 -*-
"""Prepare ICON.png for Windows: white artwork on opaque black background."""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageFilter

ALPHA_THRESHOLD = 48
NEAR_BLACK_THRESHOLD = 2
LINE_THRESHOLD = 1


def _ensure_square(src: Image.Image) -> Image.Image:
    width, height = src.size
    if width == height:
        return src
    size = max(width, height)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    canvas.paste(src, ((size - width) // 2, (size - height) // 2), src)
    return canvas


def _is_near_black_on_black(src: Image.Image) -> bool:
    pixels = list(src.getdata())
    if not pixels:
        return False
    near_black = sum(1 for r, g, b, a in pixels if a >= ALPHA_THRESHOLD and max(r, g, b) <= NEAR_BLACK_THRESHOLD)
    return near_black / len(pixels) >= 0.9


def _from_near_black_source(src: Image.Image) -> Image.Image:
    out = Image.new("RGBA", src.size, (0, 0, 0, 255))
    pixels = out.load()
    for y in range(src.height):
        for x in range(src.width):
            r, g, b, a = src.getpixel((x, y))
            if a >= ALPHA_THRESHOLD and max(r, g, b) >= LINE_THRESHOLD:
                pixels[x, y] = (255, 255, 255, 255)
    return out.filter(ImageFilter.MaxFilter(3))


def _from_standard_source(src: Image.Image) -> Image.Image:
    out = Image.new("RGBA", src.size, (0, 0, 0, 255))
    pixels = out.load()
    for y in range(src.height):
        for x in range(src.width):
            r, g, b, a = src.getpixel((x, y))
            if a < ALPHA_THRESHOLD:
                pixels[x, y] = (0, 0, 0, 255)
            elif max(r, g, b) >= 200:
                pixels[x, y] = (255, 255, 255, 255)
            elif max(r, g, b) <= 80:
                pixels[x, y] = (255, 255, 255, 255)
            else:
                pixels[x, y] = (0, 0, 0, 255)
    return out


def prepare_icon(source: Path, destination: Path) -> None:
    src = _ensure_square(Image.open(source).convert("RGBA"))
    out = _from_near_black_source(src) if _is_near_black_on_black(src) else _from_standard_source(src)
    out.save(destination, format="PNG")
    print(f"OK: {destination} ({out.size[0]}x{out.size[1]})")


def main() -> int:
    project_root = Path(__file__).resolve().parents[2]
    source = project_root / "ICON-source.png"
    if not source.is_file():
        source = project_root / "ICON.png"
    destination = project_root / "ICON.png"
    if not source.is_file():
        print(f"ERROR: missing {source}", file=sys.stderr)
        return 1
    prepare_icon(source, destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
