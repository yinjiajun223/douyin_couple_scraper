$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$dockerfile = Join-Path $repositoryRoot 'infra/docker/Dockerfile'
$composeFile = Join-Path $repositoryRoot 'infra/production/compose.smoke.yml'
$overrideFile = Join-Path $repositoryRoot 'infra/production/compose.release-drill.yml'

foreach ($target in @('api', 'worker', 'web')) {
  docker image tag "douyin-ops-${target}:smoke" "douyin-ops-${target}:staging-previous"
  if ($LASTEXITCODE -ne 0) { throw "Missing smoke image for $target" }
  docker build --build-arg RELEASE_ID=staging-current --target $target --tag "douyin-ops-${target}:staging-current" --file $dockerfile $repositoryRoot
  if ($LASTEXITCODE -ne 0) { throw "Could not build current staging image for $target" }
}

function Set-DrillImages([string]$tag) {
  $env:DRILL_API_IMAGE = "douyin-ops-api:$tag"
  $env:DRILL_WORKER_IMAGE = "douyin-ops-worker:$tag"
  $env:DRILL_WEB_IMAGE = "douyin-ops-web:$tag"
}

function Wait-Ready {
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18080/health/ready'
      if ($response.StatusCode -eq 200) { return }
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  throw 'Staging readiness did not recover'
}

try {
  Set-DrillImages 'staging-current'
  docker compose --file $composeFile --file $overrideFile up --detach --wait
  if ($LASTEXITCODE -ne 0) { throw 'Forward migration/current release failed' }
  Wait-Ready

  Set-DrillImages 'staging-previous'
  docker compose --file $composeFile --file $overrideFile up --detach --no-deps --force-recreate web api worker
  if ($LASTEXITCODE -ne 0) { throw 'Previous image rollback failed' }
  docker compose --file $composeFile --file $overrideFile up --detach --no-deps --force-recreate gateway
  if ($LASTEXITCODE -ne 0) { throw 'Gateway refresh after rollback failed' }
  Wait-Ready

  $migrationCount = 'SELECT COUNT(*) FROM schema_migrations;' | docker compose --file $composeFile --file $overrideFile exec -T mysql mysql -N -udouyin_smoke -psmoke-password douyin_ops
  if ($LASTEXITCODE -ne 0 -or [int]$migrationCount -ne 12) {
    throw 'Schema migrations were not preserved after rollback'
  }
  Write-Output "RELEASE_ROLLBACK_DRILL_OK migrations=$migrationCount"
} finally {
  docker compose --file $composeFile --file $overrideFile down --volumes --remove-orphans
  Remove-Item Env:DRILL_API_IMAGE -ErrorAction SilentlyContinue
  Remove-Item Env:DRILL_WORKER_IMAGE -ErrorAction SilentlyContinue
  Remove-Item Env:DRILL_WEB_IMAGE -ErrorAction SilentlyContinue
}
