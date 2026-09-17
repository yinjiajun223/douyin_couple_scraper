param(
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [switch]$SkipVisibleChrome
)

$ErrorActionPreference = 'Stop'
$resolvedPackage = (Resolve-Path $PackagePath).Path
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase "douyin-collector-smoke-$([Guid]::NewGuid().ToString('N'))"
$process = $null
$previousEnvironment = @{
  NODE_ENV = $env:NODE_ENV
  COLLECTOR_API_BASE_URL = $env:COLLECTOR_API_BASE_URL
  COLLECTOR_DATA_DIR = $env:COLLECTOR_DATA_DIR
  COLLECTOR_CONTROL_PORT = $env:COLLECTOR_CONTROL_PORT
}

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  Expand-Archive -LiteralPath $resolvedPackage -DestinationPath $tempRoot
  $packageRoot = (Get-ChildItem -LiteralPath $tempRoot -Directory | Select-Object -First 1).FullName
  $nodePath = Join-Path $packageRoot 'runtime/node.exe'
  $isolatedData = Join-Path $tempRoot 'fresh-user-data'
  $smokeArguments = @((Join-Path $packageRoot 'smoke/smoke.mjs'), $isolatedData)
  if ($SkipVisibleChrome) { $smokeArguments += '--skip-visible-chrome' }
  & $nodePath @smokeArguments
  if ($LASTEXITCODE -ne 0) { throw 'Pairing, DPAPI, or visible Chrome smoke test failed.' }

  $port = Get-Random -Minimum 44000 -Maximum 48000
  $env:NODE_ENV = 'production'
  $env:COLLECTOR_API_BASE_URL = 'https://ops.example.test'
  $env:COLLECTOR_DATA_DIR = $isolatedData
  $env:COLLECTOR_CONTROL_PORT = [string]$port
  $stdoutPath = Join-Path $tempRoot 'collector.stdout.log'
  $stderrPath = Join-Path $tempRoot 'collector.stderr.log'
  $process = Start-Process -FilePath $nodePath -ArgumentList @((Join-Path $packageRoot 'app/index.js')) -WorkingDirectory $packageRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/" -TimeoutSec 1
      if ($response.StatusCode -eq 200 -and $response.Content -match '<form id="pair-form">') {
        $ready = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if (-not $ready) {
    $rawDiagnostic = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { '' }
    $rawStandardOutput = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { '' }
    $diagnostic = if ($rawDiagnostic) { $rawDiagnostic.Trim() } elseif ($rawStandardOutput) { $rawStandardOutput.Trim() } else { 'no process output' }
    throw "Packaged local control page did not become ready: $diagnostic"
  }
  Write-Output "Collector package smoke test passed with bundled Node at $nodePath"
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  foreach ($entry in $previousEnvironment.GetEnumerator()) {
    Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value
  }
  $resolvedTempRoot = [IO.Path]::GetFullPath($tempRoot)
  if ($resolvedTempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTempRoot)) {
    Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
  }
}
