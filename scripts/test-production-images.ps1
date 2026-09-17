$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$dockerfile = Join-Path $repositoryRoot 'infra/docker/Dockerfile'
$composeFile = Join-Path $repositoryRoot 'infra/production/compose.smoke.yml'

foreach ($target in @('api', 'worker', 'web')) {
  docker build --target $target --tag "douyin-ops-${target}:smoke" --file $dockerfile $repositoryRoot
  if ($LASTEXITCODE -ne 0) { throw "Failed to build $target image" }
  $configuredUser = docker image inspect "douyin-ops-${target}:smoke" --format '{{.Config.User}}'
  if (-not $configuredUser) { throw "$target image does not configure a non-root user" }
  if ($configuredUser -eq 'root' -or $configuredUser -eq '0') { throw "$target image runs as root" }
}

try {
  docker compose --file $composeFile up --detach --wait
  if ($LASTEXITCODE -ne 0) { throw 'Production smoke compose did not become healthy' }
  $live = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18080/health/live'
  if ($live.StatusCode -ne 200) { throw 'Gateway liveness check failed' }
  $ready = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18080/health/ready'
  if ($ready.StatusCode -ne 200) { throw 'Gateway readiness check failed' }
  $webResponse = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18080/'
  if ($webResponse.StatusCode -ne 200 -or $webResponse.Content -notmatch '<div id="root"></div>') {
    throw 'Static web smoke check failed'
  }
  if ($live.Headers['X-Content-Type-Options'] -ne 'nosniff') {
    throw 'Security headers are missing at the gateway'
  }
} finally {
  docker compose --file $composeFile down --volumes --remove-orphans
}

foreach ($target in @('api', 'worker', 'web')) {
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v douyin-ops-grype-cache:/home/grype/.cache/grype ghcr.io/anchore/grype:v0.116.1 "douyin-ops-${target}:smoke" --fail-on high --only-fixed
  if ($LASTEXITCODE -ne 0) { throw "Image scan failed for $target" }
}
