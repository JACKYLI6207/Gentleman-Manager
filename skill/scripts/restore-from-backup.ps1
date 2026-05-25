param(
    [Parameter(Mandatory = $true)]
    [string[]] $Path
)

$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$backupRoot = Join-Path $projectRoot 'skill\backups'

foreach ($rel in $Path) {
    $rel = $rel -replace '/', '\'
    $backup = Join-Path $backupRoot $rel
    $target = Join-Path $projectRoot $rel

    if (-not (Test-Path -LiteralPath $backup)) {
        Write-Error "No backup for: $rel (expected skill\backups\$rel)"
    }

    $targetDir = Split-Path -Parent $target
    if ($targetDir -and -not (Test-Path -LiteralPath $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }

    Copy-Item -LiteralPath $backup -Destination $target -Force
    Write-Host "RESTORED: skill\backups\$rel -> $rel"
}
