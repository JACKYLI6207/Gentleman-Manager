# -*- coding: utf-8 -*-
"""Composite icon onto an opaque background; artwork pixels stay unchanged."""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

# White background keeps black line art visible in Windows Explorer.
BACKGROUND = (255, 255, 255, 255)


def add_opaque_background(source: Path, destination: Path) -> None:
    src = Image.open(source).convert("RGBA")
    bg = Image.new("RGBA", src.size, BACKGROUND)
    out = Image.alpha_composite(bg, src)
    out.save(destination, format="PNG")
    print(f"OK: {destination} ({out.size[0]}x{out.size[1]})")


def main() -> int:
    project_root = Path(__file__).resolve().parents[2]
    source = project_root / "icon01.png"
    destination = project_root / "icon01-shell.png"
    if not source.is_file():
        print(f"ERROR: missing {source}", file=sys.stderr)
        return 1
    add_opaque_background(source, destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
