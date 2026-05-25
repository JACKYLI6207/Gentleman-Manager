param(
    [Parameter(Mandatory = $true)]
    [string[]] $Path
)

$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$backupRoot = Join-Path $projectRoot 'skill\backups'

foreach ($rel in $Path) {
    $rel = $rel -replace '/', '\'
    $source = Join-Path $projectRoot $rel
    if (-not (Test-Path -LiteralPath $source)) {
        Write-Host "SKIP (not found): $rel"
        continue
    }

    $dest = Join-Path $backupRoot $rel
    $destDir = Split-Path -Parent $dest
    if ($destDir -and -not (Test-Path -LiteralPath $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }

    Copy-Item -LiteralPath $source -Destination $dest -Force
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Write-Host "OK [$stamp] $rel -> skill\backups\$rel"
}
