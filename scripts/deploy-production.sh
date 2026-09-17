#!/usr/bin/env sh
set -eu

REPOSITORY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE=${1:-"$REPOSITORY_DIR/.env.production"}
COMPOSE_FILE="$REPOSITORY_DIR/infra/production/compose.yml"
STATE_FILE="$REPOSITORY_DIR/infra/production/.previous-images.env"

set -a
. "$ENV_FILE"
set +a

NODE_EXTRA_CA_CERTS="$RDS_CA_CERT_PATH" \
  node "$REPOSITORY_DIR/scripts/preflight-production.mjs" --env "$ENV_FILE" --live

umask 077
if [ -f "$REPOSITORY_DIR/infra/production/.current-images.env" ]; then
  cp "$REPOSITORY_DIR/infra/production/.current-images.env" "$STATE_FILE"
fi
printf 'API_IMAGE=%s\nWORKER_IMAGE=%s\nWEB_IMAGE=%s\n' "$API_IMAGE" "$WORKER_IMAGE" "$WEB_IMAGE" \
  > "$REPOSITORY_DIR/infra/production/.current-images.env"

docker compose --env-file "$ENV_FILE" --file "$COMPOSE_FILE" pull api worker web gateway
docker compose --env-file "$ENV_FILE" --file "$COMPOSE_FILE" --profile tools run --rm migrate
docker compose --env-file "$ENV_FILE" --file "$COMPOSE_FILE" up --detach --no-deps web api worker
docker compose --env-file "$ENV_FILE" --file "$COMPOSE_FILE" up --detach --no-deps --force-recreate gateway

attempt=0
until curl --fail --silent --show-error "https://$APP_DOMAIN/health/ready" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo '发布后的 readiness 检查失败；请运行 rollback-production.sh。' >&2
    exit 1
  fi
  sleep 2
done

echo "发布完成：https://$APP_DOMAIN"
