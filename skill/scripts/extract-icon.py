# -*- coding: utf-8 -*-
"""Extract embedded icon from 紳士管理器.exe (or another PE file)."""
from __future__ import annotations

import io
import struct
import sys
from pathlib import Path

import pefile
from PIL import Image

DEFAULT_EXE = "紳士管理器.exe"


def extract_icon(exe_path: Path, out_dir: Path) -> tuple[Path, Path]:
    pe = pefile.PE(str(exe_path))

    icons: list[bytes] = []
    for entry in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        if entry.struct.Id != 3:
            continue
        for e in entry.directory.entries:
            for e2 in e.directory.entries:
                data = pe.get_data(e2.data.struct.OffsetToData, e2.data.struct.Size)
                icons.append(data)

    group_data = None
    for entry in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        if entry.struct.Id != 14:
            continue
        for e in entry.directory.entries:
            for e2 in e.directory.entries:
                group_data = pe.get_data(e2.data.struct.OffsetToData, e2.data.struct.Size)
                break

    if not group_data or not icons:
        raise RuntimeError(f"no icon resources in {exe_path}")

    count = struct.unpack("<H", group_data[4:6])[0]
    entries: list[tuple] = []
    offset = 6
    for _ in range(count):
        entries.append(struct.unpack("<BBBBHHHL", group_data[offset : offset + 14]))
        offset += 14

    ico_header = struct.pack("<HHH", 0, 1, count)
    ico_dir = b""
    ico_data = b""
    data_offset = 6 + 16 * count
    for idx, (width, height, colors, _reserved, planes, bitcount, _bytes_in_res, _icon_id) in enumerate(entries):
        blob = icons[idx]
        ico_dir += struct.pack("<BBBBHHII", width, height, colors, 0, planes, bitcount, len(blob), data_offset)
        ico_data += blob
        data_offset += len(blob)

    ico_path = out_dir / "icon-extracted.ico"
    ico_path.write_bytes(ico_header + ico_dir + ico_data)

    best_idx = max(range(len(entries)), key=lambda i: 256 if entries[i][0] == 0 else entries[i][0])
    png_path = out_dir / "icon-extracted.png"
    Image.open(io.BytesIO(icons[best_idx])).convert("RGBA").save(png_path, format="PNG")

    return ico_path, png_path


def main() -> int:
    project_root = Path(__file__).resolve().parents[2]
    exe_path = project_root / (sys.argv[1] if len(sys.argv) > 1 else DEFAULT_EXE)
    if not exe_path.is_file():
        print(f"ERROR: missing {exe_path}", file=sys.stderr)
        return 1
    ico_path, png_path = extract_icon(exe_path, project_root)
    print(f"OK: {ico_path}")
    print(f"OK: {png_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
