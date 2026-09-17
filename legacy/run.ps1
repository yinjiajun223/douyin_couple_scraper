$ErrorActionPreference = 'Stop'

$legacyRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $legacyRoot
$localPlaywright = Join-Path $repoRoot 'node_modules\playwright'
$bundleRoot = 'C:\Users\ic\.cache\codex-runtimes\codex-primary-runtime\dependencies\node'
$bundleNode = Join-Path $bundleRoot 'bin\node.exe'
$bundleModules = Join-Path $bundleRoot 'node_modules'

if (Test-Path -LiteralPath $localPlaywright) {
    $nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
}
elseif ((Test-Path -LiteralPath $bundleNode) -and (Test-Path -LiteralPath (Join-Path $bundleModules 'playwright'))) {
    $nodeCommand = $bundleNode
    $env:NODE_PATH = $bundleModules
}
else {
    throw 'Playwright was not found. Run npm install in the repository, then try again.'
}

Push-Location $repoRoot
try {
    & $nodeCommand (Join-Path $legacyRoot 'scraper.cjs') @args
}
finally {
    Pop-Location
}
