#!/usr/bin/env sh
set -eu

REPOSITORY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE=${1:-"$REPOSITORY_DIR/.env.production"}
COMPOSE_FILE="$REPOSITORY_DIR/infra/production/compose.yml"

set -a
. "$ENV_FILE"
set +a

echo '容器 CPU/内存快照（负载期间每 5 秒执行一次或配合主机监控）：'
docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'

echo '后台队列深度：'
docker compose --env-file "$ENV_FILE" --file "$COMPOSE_FILE" exec -T api node --input-type=module -e \
  "import mysql from 'mysql2/promise'; const u=new URL(process.env.DATABASE_URL); u.searchParams.delete('ssl-mode'); const c=await mysql.createConnection({uri:u.toString(),ssl:{rejectUnauthorized:true}}); const [r]=await c.query(\"SELECT status, COUNT(*) count FROM background_jobs GROUP BY status\"); console.log(JSON.stringify(r)); await c.end();"

echo '确认服务器容器中没有浏览器进程：'
if docker compose --env-file "$ENV_FILE" --file "$COMPOSE_FILE" top | grep -E -i 'chrome|chromium|playwright'; then
  echo '检测到浏览器相关进程，不符合部署边界。' >&2
  exit 1
fi
echo '未检测到浏览器进程。'
