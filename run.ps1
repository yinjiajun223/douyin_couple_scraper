$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$environmentFile = Join-Path $repoRoot '.env'
if (-not (Test-Path -LiteralPath $environmentFile)) {
    throw 'Missing .env. Copy .env.example to .env and configure COLLECTOR_API_BASE_URL first.'
}

$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source

Push-Location $repoRoot
try {
    foreach ($workspace in @('@douyin/contracts', '@douyin/platform-douyin', '@douyin/domain', '@douyin/collector')) {
        & $npmCommand run build -w $workspace
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to build $workspace."
        }
    }
    Write-Host 'Collector control page: http://127.0.0.1:43127'
    & $nodeCommand --enable-source-maps "--env-file=$environmentFile" (Join-Path $repoRoot 'apps\collector\dist\index.js') @args
    if ($LASTEXITCODE -ne 0) {
        throw "Collector exited with code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
