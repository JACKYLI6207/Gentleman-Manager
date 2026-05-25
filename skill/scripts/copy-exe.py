# -*- coding: utf-8 -*-
import os
import shutil
import sys
import zipfile

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
built_exe = os.path.join(project_root, "src-tauri", "target", "release-fast", "Gentleman-Manager.exe")
output_exe = os.path.join(project_root, "Gentleman-Manager.exe")
output_alt = os.path.join(project_root, "Gentleman-Manager-new.exe")
output_zip = os.path.join(project_root, "Gentleman-Manager.zip")

if not os.path.isfile(built_exe):
    print(f"ERROR: built exe not found: {built_exe}", file=sys.stderr)
    sys.exit(1)

for path in (output_exe, output_alt, output_zip):
    if os.path.isfile(path):
        try:
            os.remove(path)
        except OSError:
            pass

try:
    shutil.copy2(built_exe, output_exe)
    packaged_exe = output_exe
except OSError:
    shutil.copy2(built_exe, output_alt)
    packaged_exe = output_alt

with zipfile.ZipFile(output_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    archive.write(packaged_exe, arcname=os.path.basename(packaged_exe))

print(f"OK EXE: {packaged_exe}")
print(f"OK ZIP: {output_zip}")
