param(
  [Parameter(Mandatory = $true)][string]$PackagePath
)

$ErrorActionPreference = 'Stop'
$resolvedPackage = (Resolve-Path -LiteralPath $PackagePath).Path
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase "douyin-collector-launcher-$([Guid]::NewGuid().ToString('N'))"
$packageRoot = ''
$launcher = $null

try {
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  Expand-Archive -LiteralPath $resolvedPackage -DestinationPath $tempRoot
  $packageRoot = (Get-ChildItem -LiteralPath $tempRoot -Directory | Select-Object -First 1).FullName
  $launcherPath = Join-Path $packageRoot 'start-collector.cmd'

  $launcher = Start-Process `
    -FilePath 'cmd.exe' `
    -ArgumentList "/d /c call `"$launcherPath`"" `
    -WorkingDirectory $packageRoot `
    -PassThru
  if ($launcher.WaitForExit(5000)) {
    throw "start-collector.cmd exited before the collector was stopped (code $($launcher.ExitCode))."
  }

  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:43127/' -TimeoutSec 1
      if ($response.StatusCode -eq 200 -and $response.Content -match '<form id="pair-form">') {
        $ready = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }

  if (-not $ready) {
    throw 'start-collector.cmd returned, but the local control page did not become ready.'
  }
  Write-Output 'Collector launcher smoke test passed through start-collector.cmd.'
} finally {
  if ($packageRoot) {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($packageRoot, [StringComparison]::OrdinalIgnoreCase)
      } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  if ($launcher -and -not $launcher.HasExited) {
    Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
  }
  $resolvedTempRoot = [IO.Path]::GetFullPath($tempRoot)
  if (
    $resolvedTempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
    (Test-Path -LiteralPath $resolvedTempRoot)
  ) {
    Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
  }
}
