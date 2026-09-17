param(
  [string]$Version = '0.1.0',
  [string]$OutputDirectory = 'artifacts',
  [string]$NodeExecutable = '',
  [string]$ApiBaseUrl = '',
  [string]$CaCertificatePath = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outputRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
$requiredOutputPrefix = $repoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $outputRoot.StartsWith($requiredOutputPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputDirectory must stay inside the repository.'
}
if (-not $NodeExecutable) {
  $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
}
$nodePath = (Resolve-Path $NodeExecutable).Path
$normalizedApiBaseUrl = ''
if ($ApiBaseUrl) {
  try {
    $apiUri = [Uri]::new($ApiBaseUrl)
  } catch {
    throw 'ApiBaseUrl must be a valid absolute HTTPS URL.'
  }
  if (-not $apiUri.IsAbsoluteUri -or $apiUri.Scheme -ne 'https' -or $apiUri.UserInfo) {
    throw 'ApiBaseUrl must be an absolute HTTPS URL without embedded credentials.'
  }
  $normalizedApiBaseUrl = $ApiBaseUrl.TrimEnd('/')
}
$resolvedCaCertificatePath = ''
if ($CaCertificatePath) {
  if (-not (Test-Path -LiteralPath $CaCertificatePath -PathType Leaf)) {
    throw "CA certificate does not exist: $CaCertificatePath"
  }
  $resolvedCaCertificatePath = (Resolve-Path -LiteralPath $CaCertificatePath).Path
}
$packageName = "collector-windows-v$Version"
$zipPath = Join-Path $outputRoot "$packageName.zip"
$checksumPath = "$zipPath.sha256"
if ((Test-Path -LiteralPath $zipPath) -or (Test-Path -LiteralPath $checksumPath)) {
  throw "Package already exists: $zipPath"
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase "douyin-collector-package-$([Guid]::NewGuid().ToString('N'))"
$stageRoot = Join-Path $tempRoot $packageName

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

try {
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

  Push-Location $repoRoot
  try {
    & npm.cmd run build -w '@douyin/contracts'
    if ($LASTEXITCODE -ne 0) { throw 'contracts build failed' }
    & npm.cmd run build -w '@douyin/platform-douyin'
    if ($LASTEXITCODE -ne 0) { throw 'platform build failed' }
    & npm.cmd run build -w '@douyin/domain'
    if ($LASTEXITCODE -ne 0) { throw 'domain build failed' }
    & npm.cmd run build -w '@douyin/collector'
    if ($LASTEXITCODE -ne 0) { throw 'collector build failed' }
  } finally {
    Pop-Location
  }

  $runtimeDirectory = Join-Path $stageRoot 'runtime'
  $appDirectory = Join-Path $stageRoot 'app'
  New-Item -ItemType Directory -Path $runtimeDirectory, $appDirectory -Force | Out-Null
  Copy-Item -LiteralPath $nodePath -Destination (Join-Path $runtimeDirectory 'node.exe')
  Copy-Item -Path (Join-Path $repoRoot 'apps/collector/dist/*') -Destination $appDirectory -Recurse

  $runtimePackage = @{
    name = 'douyin-collector-runtime'
    private = $true
    type = 'module'
    version = $Version
    dependencies = @{
      'ali-oss' = '6.23.0'
      'cheerio' = '1.1.2'
      'mysql2' = '3.14.4'
      'playwright' = '1.55.0'
      'zod' = '4.1.5'
    }
  } | ConvertTo-Json -Depth 5
  Write-Utf8NoBom (Join-Path $appDirectory 'package.json') $runtimePackage

  Push-Location $appDirectory
  try {
    & npm.cmd install --omit=dev --no-package-lock --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'runtime dependency installation failed' }
  } finally {
    Pop-Location
  }

  $douyinModules = Join-Path $appDirectory 'node_modules/@douyin'
  New-Item -ItemType Directory -Path $douyinModules -Force | Out-Null
  foreach ($workspacePackage in @('contracts', 'domain', 'platform-douyin')) {
    $sourcePackage = Join-Path $repoRoot "packages/$workspacePackage"
    $targetPackage = Join-Path $douyinModules $workspacePackage
    New-Item -ItemType Directory -Path $targetPackage -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourcePackage 'dist') -Destination $targetPackage -Recurse
    Copy-Item -LiteralPath (Join-Path $sourcePackage 'package.json') -Destination $targetPackage
  }

  $sampleEnvironment = @'
NODE_ENV=production
COLLECTOR_API_BASE_URL=https://ops.example.com
COLLECTOR_DATA_DIR=../data
COLLECTOR_CONTROL_PORT=43127
'@
  Write-Utf8NoBom (Join-Path $stageRoot '.env.example') $sampleEnvironment
  if ($normalizedApiBaseUrl) {
    $configuredEnvironment = @"
NODE_ENV=production
COLLECTOR_API_BASE_URL=$normalizedApiBaseUrl
COLLECTOR_DATA_DIR=../data
COLLECTOR_CONTROL_PORT=43127
"@
    Write-Utf8NoBom (Join-Path $stageRoot '.env') $configuredEnvironment
  }
  if ($resolvedCaCertificatePath) {
    $certificateDirectory = Join-Path $stageRoot 'certs'
    New-Item -ItemType Directory -Path $certificateDirectory -Force | Out-Null
    Copy-Item -LiteralPath $resolvedCaCertificatePath -Destination (Join-Path $certificateDirectory 'server-ca.pem')
  }
  Copy-Item -LiteralPath (Join-Path $repoRoot 'docs/collector-windows.md') -Destination (Join-Path $stageRoot 'README.md')

  $launcher = @'
@echo off
setlocal
set "ROOT=%~dp0"
if not exist "%ROOT%.env" (
  echo Missing .env. Copy .env.example to .env and configure COLLECTOR_API_BASE_URL.
  pause
  exit /b 1
)
if exist "%ROOT%certs\server-ca.pem" set "NODE_EXTRA_CA_CERTS=%ROOT%certs\server-ca.pem"
pushd "%ROOT%"
start "Douyin Collector" "%ROOT%runtime\node.exe" --enable-source-maps --env-file="%ROOT%.env" "%ROOT%app\index.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:43127"
popd
'@
  Write-Utf8NoBom (Join-Path $stageRoot 'start-collector.cmd') $launcher

  $smokeDirectory = Join-Path $stageRoot 'smoke'
  New-Item -ItemType Directory -Path $smokeDirectory -Force | Out-Null
  $smokeModule = @'
process.env.NODE_ENV = 'test';
const dataRoot = process.argv[2];
const skipVisibleChrome = process.argv.includes('--skip-visible-chrome');
const collector = await import('../app/index.js');
const tokenStore = new collector.DeviceTokenStore(dataRoot);
await collector.pairAndStoreCollectorDevice({
  apiBaseUrl: 'https://ops.example.test',
  collectorVersion: collector.COLLECTOR_VERSION,
  deviceName: 'isolated-smoke-device',
  pairingCode: 'SMOKE-PAIR',
  parserVersion: '0.2.0',
}, tokenStore, async () => ({
  ok: true,
  status: 201,
  json: async () => ({ deviceId: 'smoke-device', token: 'smoke-device-token-value-00000001' }),
}));
if ((await tokenStore.load()) !== 'smoke-device-token-value-00000001') throw new Error('DPAPI token round trip failed');
const profiles = new collector.CollectorBrowserProfileStore(dataRoot);
await profiles.createProfile('clean-windows-smoke');
if (!skipVisibleChrome) {
  const context = await collector.launchSelectedCollectorProfile(profiles);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await context.close();
}
console.log(JSON.stringify({ paired: true, profile: true, visibleChrome: !skipVisibleChrome }));
'@
  Write-Utf8NoBom (Join-Path $smokeDirectory 'smoke.mjs') $smokeModule

  Compress-Archive -LiteralPath $stageRoot -DestinationPath $zipPath -CompressionLevel Optimal
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
  Write-Utf8NoBom $checksumPath "$hash  $packageName.zip`n"
  Write-Output $zipPath
} finally {
  $resolvedTempRoot = [IO.Path]::GetFullPath($tempRoot)
  if ($resolvedTempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTempRoot)) {
    Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
  }
}
