#!/usr/bin/env sh
set -eu

REPOSITORY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE=${1:-"$REPOSITORY_DIR/.env.production"}
COMPOSE_FILE="$REPOSITORY_DIR/infra/production/compose.yml"
STATE_FILE="$REPOSITORY_DIR/infra/production/.previous-images.env"

if [ ! -f "$STATE_FILE" ]; then
  echo '没有可用的前一镜像记录，无法自动回滚。' >&2
  exit 1
fi

set -a
. "$ENV_FILE"
. "$STATE_FILE"
set +a

docker compose --env-file "$ENV_FILE" --file "$COMPOSE_FILE" up --detach --no-deps web api worker
docker compose --env-file "$ENV_FILE" --file "$COMPOSE_FILE" up --detach --no-deps --force-recreate gateway

attempt=0
until curl --fail --silent --show-error "https://$APP_DOMAIN/health/ready" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo '前一镜像启动后 readiness 仍失败，需要人工处理。' >&2
    exit 1
  fi
  sleep 2
done

echo "已回滚到前一组镜像；数据库迁移保持向后兼容，不执行破坏性降级。"
