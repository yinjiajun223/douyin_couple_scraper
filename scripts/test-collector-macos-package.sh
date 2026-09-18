#!/usr/bin/env bash

set -euo pipefail

package_path=''
skip_visible_chrome='false'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package)
      package_path="$2"
      shift 2
      ;;
    --skip-visible-chrome)
      skip_visible_chrome='true'
      shift
      ;;
    --help|-h)
      echo 'Usage: ./scripts/test-collector-macos-package.sh --package PATH [--skip-visible-chrome]'
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != 'Darwin' ]]; then
  echo 'This smoke test must run on macOS.' >&2
  exit 1
fi
if [[ -z "$package_path" || ! -f "$package_path" ]]; then
  echo 'A valid --package path is required.' >&2
  exit 1
fi

resolved_package="$(cd "$(dirname "$package_path")" && pwd -P)/$(basename "$package_path")"
temp_root="$(mktemp -d "${TMPDIR:-/tmp}/douyin-collector-smoke.XXXXXX")"
collector_pid=''
cleanup() {
  if [[ -n "$collector_pid" ]] && kill -0 "$collector_pid" >/dev/null 2>&1; then
    kill "$collector_pid" >/dev/null 2>&1 || true
    wait "$collector_pid" >/dev/null 2>&1 || true
  fi
  case "$temp_root" in
    "${TMPDIR:-/tmp}"/douyin-collector-smoke.*) rm -rf "$temp_root" ;;
  esac
}
trap cleanup EXIT

tar -xzf "$resolved_package" -C "$temp_root"
package_root=''
for candidate in "$temp_root"/*; do
  if [[ -d "$candidate" ]]; then
    package_root="$candidate"
    break
  fi
done
if [[ -z "$package_root" ]]; then
  echo 'The package did not contain a top-level directory.' >&2
  exit 1
fi
case "$(uname -m)" in
  arm64) runtime_architecture='arm64' ;;
  x86_64) runtime_architecture='x64' ;;
  *)
    echo "Unsupported Mac architecture: $(uname -m)" >&2
    exit 1
    ;;
esac
node_path="$package_root/runtime/$runtime_architecture/node"
if [[ ! -x "$node_path" || ! -x "$package_root/start-collector.command" ]]; then
  echo 'Bundled Node or start-collector.command is not executable.' >&2
  exit 1
fi

isolated_data="$temp_root/fresh-user-data"
smoke_arguments=("$package_root/smoke/smoke.mjs" "$isolated_data")
if [[ "$skip_visible_chrome" == 'true' ]]; then
  smoke_arguments+=('--skip-visible-chrome')
fi
"$node_path" "${smoke_arguments[@]}"

port=$((44000 + RANDOM % 4000))
NODE_ENV=production \
COLLECTOR_API_BASE_URL='https://ops.example.test' \
COLLECTOR_DATA_DIR="$isolated_data" \
COLLECTOR_CONTROL_PORT="$port" \
  "$node_path" "$package_root/app/index.js" \
  >"$temp_root/collector.stdout.log" \
  2>"$temp_root/collector.stderr.log" &
collector_pid=$!

ready='false'
for _ in $(seq 1 40); do
  response="$(curl --fail --silent "http://127.0.0.1:$port/" 2>/dev/null || true)"
  if [[ "$response" == *'<form id="pair-form">'* ]]; then
    ready='true'
    break
  fi
  sleep 0.25
done
if [[ "$ready" != 'true' ]]; then
  echo 'Packaged local control page did not become ready.' >&2
  sed -n '1,80p' "$temp_root/collector.stderr.log" >&2
  sed -n '1,80p' "$temp_root/collector.stdout.log" >&2
  exit 1
fi

echo "macOS collector package smoke test passed with bundled Node at $node_path"
