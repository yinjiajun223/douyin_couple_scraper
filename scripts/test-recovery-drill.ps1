$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$composeFile = Join-Path $repositoryRoot 'infra/production/compose.smoke.yml'

docker compose --file $composeFile up --detach --wait mysql
if ($LASTEXITCODE -ne 0) { throw 'Recovery drill MySQL did not become healthy' }

try {
  docker compose --file $composeFile run --rm migrate
  if ($LASTEXITCODE -ne 0) { throw 'Recovery drill migrations failed' }

  $seedSql = @'
INSERT INTO workspaces (id, slug, name) VALUES ('10000000-0000-0000-0000-000000000001', 'recovery-drill', 'Recovery drill');
INSERT INTO users (id, email, password_hash, display_name) VALUES ('20000000-0000-0000-0000-000000000001', 'drill@example.invalid', 'not-a-login-hash', 'Drill operator');
INSERT INTO memberships (workspace_id, user_id, role) VALUES ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'admin');
INSERT INTO devices (id, workspace_id, owner_user_id, name, token_hash) VALUES ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Drill collector', REPEAT('a', 64));
INSERT INTO campaigns (id, workspace_id, name, rule_schema_version, rules_json, created_by_user_id) VALUES ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Drill campaign', 1, '{}', '20000000-0000-0000-0000-000000000001');
INSERT INTO campaign_rule_versions (id, workspace_id, campaign_id, version, rule_schema_version, rules_json, created_by_user_id) VALUES ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 1, 1, '{}', '20000000-0000-0000-0000-000000000001');
INSERT INTO collection_runs (id, workspace_id, campaign_id, rule_version_id, progress_json, created_by_user_id) VALUES ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '{}', '20000000-0000-0000-0000-000000000001');
INSERT INTO creators (id, workspace_id, platform, platform_creator_id, canonical_profile_url, first_observed_at, last_observed_at) VALUES ('70000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'douyin', 'recovery-drill-creator', 'https://www.douyin.com/user/recovery-drill', NOW(3), NOW(3));
INSERT INTO creator_observations (id, workspace_id, creator_id, run_id, device_id, nickname, follower_count, profile_url, parser_confidence, collector_version, parser_version, observed_at) VALUES ('80000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Recovery sample', 1234, 'https://www.douyin.com/user/recovery-drill', 1, '0.1.0', '0.1.0', NOW(3));
INSERT INTO media_objects (id, workspace_id, creator_observation_id, object_key, purpose, mime_type, byte_size, checksum_sha256, status, confirmed_at) VALUES ('90000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', 'workspaces/10000000-0000-0000-0000-000000000001/runs/60000000-0000-0000-0000-000000000001/media/90000000-0000-0000-0000-000000000001-profile_screenshot.jpg', 'profile_screenshot', 'image/jpeg', 128, REPEAT('b', 64), 'confirmed', NOW(3));
'@
  $seedSql | docker compose --file $composeFile exec -T mysql mysql -udouyin_smoke -psmoke-password douyin_ops
  if ($LASTEXITCODE -ne 0) { throw 'Could not create recovery drill records' }

  docker compose --file $composeFile exec -T mysql sh -c "mysqldump -uroot -psmoke-root-password --single-transaction --routines --triggers douyin_ops > /tmp/douyin_ops.sql"
  if ($LASTEXITCODE -ne 0) { throw 'Recovery backup failed' }
  'DROP DATABASE IF EXISTS douyin_ops_restore; CREATE DATABASE douyin_ops_restore CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;' | docker compose --file $composeFile exec -T mysql mysql -uroot -psmoke-root-password
  docker compose --file $composeFile exec -T mysql sh -c "mysql -uroot -psmoke-root-password douyin_ops_restore < /tmp/douyin_ops.sql"
  if ($LASTEXITCODE -ne 0) { throw 'Recovery restore failed' }

  $verification = 'SELECT CONCAT(c.platform_creator_id, CHAR(9), m.object_key) FROM creators c JOIN creator_observations o ON o.workspace_id=c.workspace_id AND o.creator_id=c.id JOIN media_objects m ON m.workspace_id=o.workspace_id AND m.creator_observation_id=o.id WHERE c.id=''70000000-0000-0000-0000-000000000001'';' | docker compose --file $composeFile exec -T mysql mysql -N -uroot -psmoke-root-password douyin_ops_restore
  if ($LASTEXITCODE -ne 0 -or $verification -notmatch 'recovery-drill-creator.+profile_screenshot\.jpg') {
    throw 'Restored business record and OSS object reference did not match'
  }
  Write-Output "RECOVERY_DRILL_OK $verification"
} finally {
  docker compose --file $composeFile down --volumes --remove-orphans
}
