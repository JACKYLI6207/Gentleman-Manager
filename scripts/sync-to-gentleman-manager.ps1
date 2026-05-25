# 從完整開發目錄同步到本機 Gentleman-Manager（開源輕量樹）
param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [string]$Destination = "$env:USERPROFILE\Desktop\Gentleman-Manager"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path (Join-Path $Source "package.json"))) {
    throw "Source 不是專案根目錄: $Source"
}

Write-Host ">> Source: $Source"
Write-Host ">> Dest:   $Destination"

if (-not (Test-Path $Destination)) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
}

robocopy $Source $Destination /MIR /XD node_modules dist target skill\backups .git /XF *.exe *.zip icon-extracted.png icon-extracted.ico /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) { exit $LASTEXITCODE }

$backups = Join-Path $Destination "skill\backups"
if (-not (Test-Path $backups)) { New-Item -ItemType Directory -Path $backups -Force | Out-Null }
Get-ChildItem $backups -Force | Where-Object { $_.Name -ne ".gitkeep" } | Remove-Item -Recurse -Force -EA SilentlyContinue
New-Item -ItemType File -Path (Join-Path $backups ".gitkeep") -Force | Out-Null

$mb = [math]::Round(((Get-ChildItem $Destination -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB), 2)
Write-Host "OK: $Destination ($mb MB)"
