# 修改完成後快速建置 EXE/ZIP（等同 pnpm tauri:build:fast，並處理 Windows Node 路徑）
$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $projectRoot

# 確保 cargo 輸出到專案內 src-tauri\target（不受外部 CARGO_TARGET_DIR 影響）
Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue

$nodejs = 'C:\Program Files\nodejs'
if (Test-Path -LiteralPath $nodejs) {
    $env:PATH = "$nodejs;" + ($env:PATH -replace '[^;]*cursor[^;]*;?', '')
}

$logoIco = Join-Path $projectRoot 'logo.ico'
$iconPng = Join-Path $projectRoot 'icon-extracted.png'
if (Test-Path -LiteralPath $logoIco) {
    Write-Host '>> convert logo.ico to icon source (transparent)'
    $iconScript = @'
from pathlib import Path
from PIL import Image

src = Path("logo.ico")
dst = Path("icon-extracted.png")
# Preserve transparency — do not composite onto any background.
Image.open(src).convert("RGBA").save(dst, format="PNG")
print(f"OK: {dst.resolve()}")
'@
    $iconScript | python -
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} else {
    Write-Host '>> extract icon from legacy exe'
    python (Join-Path $PSScriptRoot 'extract-icon.py')
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

Write-Host '>> pnpm tauri icon'
pnpm tauri icon $iconPng -o src-tauri/icons
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

# Clear app Cargo fingerprints so icon is always freshly embedded in EXE.
Write-Host '>> clear app fingerprints'
$fpDir = Join-Path $projectRoot 'src-tauri\target\release-fast\.fingerprint'
if (Test-Path -LiteralPath $fpDir) {
    Get-ChildItem $fpDir -Directory -Filter 'wnacg*' | Remove-Item -Recurse -Force
    Get-ChildItem $fpDir -Directory -Filter 'Gentleman*' | Remove-Item -Recurse -Force
    Get-ChildItem $fpDir -Directory -Filter 'gentleman*' | Remove-Item -Recurse -Force
}
$buildDir = Join-Path $projectRoot 'src-tauri\target\release-fast\build'
if (Test-Path -LiteralPath $buildDir) {
    Get-ChildItem $buildDir -Directory -Filter 'wnacg*' | Remove-Item -Recurse -Force
    Get-ChildItem $buildDir -Directory -Filter 'Gentleman*' | Remove-Item -Recurse -Force
    Get-ChildItem $buildDir -Directory -Filter 'gentleman*' | Remove-Item -Recurse -Force
}

Write-Host '>> pnpm tauri:build:fast'
pnpm tauri:build:fast
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host '>> copy exe and create zip in project root'
python (Join-Path $PSScriptRoot 'copy-exe.py')
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
