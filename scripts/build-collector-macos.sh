#!/usr/bin/env bash

set -euo pipefail

version='0.1.5'
output_directory='artifacts'
api_base_url=''
ca_certificate_path=''
node_version='24.18.1'
architecture='universal'

usage() {
  cat <<'EOF'
Usage: ./scripts/build-collector-macos.sh [options]

Options:
  --version VERSION              Collector version (default: 0.1.5)
  --output-directory DIRECTORY  Repository-relative output directory (default: artifacts)
  --api-base-url URL             Preconfigure the HTTPS team API URL
  --ca-certificate PATH          Bundle a public CA/server certificate for a self-signed endpoint
  --node-version VERSION         Official bundled Node.js version (default: 24.18.1)
  --architecture universal|arm64|x64
                                 Runtime set (default: universal)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      version="$2"
      shift 2
      ;;
    --output-directory)
      output_directory="$2"
      shift 2
      ;;
    --api-base-url)
      api_base_url="$2"
      shift 2
      ;;
    --ca-certificate)
      ca_certificate_path="$2"
      shift 2
      ;;
    --node-version)
      node_version="$2"
      shift 2
      ;;
    --architecture)
      architecture="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != 'Darwin' ]]; then
  echo 'This release builder must run on macOS so executable permissions are preserved.' >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
output_root="$(cd "$repo_root" && mkdir -p "$output_directory" && cd "$output_directory" && pwd -P)"
case "$output_root/" in
  "$repo_root"/*) ;;
  *)
    echo 'Output directory must stay inside the repository.' >&2
    exit 1
    ;;
esac

for required_command in node npm curl shasum tar openssl awk; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Required build command is missing: $required_command" >&2
    exit 1
  fi
done

if [[ "$architecture" != 'universal' && "$architecture" != 'arm64' && "$architecture" != 'x64' ]]; then
  echo 'Architecture must be universal, arm64, or x64.' >&2
  exit 1
fi
if [[ "$architecture" == 'universal' ]]; then
  target_architectures=('arm64' 'x64')
else
  target_architectures=("$architecture")
fi
if [[ ! "$version" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]]; then
  echo 'Version contains unsupported characters.' >&2
  exit 1
fi
if [[ ! "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Node version must use the form 24.18.1.' >&2
  exit 1
fi

source_version="$(
  node -e "process.stdout.write(require(process.argv[1]).version)" \
    "$repo_root/apps/collector/package.json" 2>/dev/null || true
)"
if [[ "$source_version" != "$version" ]]; then
  echo "Requested version $version does not match collector source version ${source_version:-unknown}." >&2
  exit 1
fi

normalized_api_base_url=''
if [[ -z "$api_base_url" ]]; then
  echo 'A production --api-base-url is required; user packages must contain ready-to-use configuration.' >&2
  exit 1
fi
normalized_api_base_url="$(
  node -e '
    const value = process.argv[1];
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) process.exit(1);
    process.stdout.write(value.replace(/\/+$/u, ""));
  ' "$api_base_url"
)" || {
  echo 'API base URL must be an absolute HTTPS URL without embedded credentials.' >&2
  exit 1
}

resolved_ca_certificate=''
if [[ -n "$ca_certificate_path" ]]; then
  if [[ ! -f "$ca_certificate_path" ]]; then
    echo "CA certificate does not exist: $ca_certificate_path" >&2
    exit 1
  fi
  resolved_ca_certificate="$(cd "$(dirname "$ca_certificate_path")" && pwd -P)/$(basename "$ca_certificate_path")"
  openssl x509 -in "$resolved_ca_certificate" -noout >/dev/null
fi

package_name="collector-macos-${architecture}-v${version}"
archive_path="$output_root/${package_name}.tar.gz"
checksum_path="${archive_path}.sha256"
if [[ -e "$archive_path" || -e "$checksum_path" ]]; then
  echo "Package already exists: $archive_path" >&2
  exit 1
fi

temp_root="$(mktemp -d "${TMPDIR:-/tmp}/douyin-collector-package.XXXXXX")"
stage_root="$temp_root/$package_name"
cleanup() {
  case "$temp_root" in
    "${TMPDIR:-/tmp}"/douyin-collector-package.*) rm -rf "$temp_root" ;;
  esac
}
trap cleanup EXIT

mkdir -p "$stage_root/app" "$stage_root/runtime"

cd "$repo_root"
npm run build -w '@douyin/contracts'
npm run build -w '@douyin/platform-douyin'
npm run build -w '@douyin/domain'
npm run build -w '@douyin/collector'

node_base_url="https://nodejs.org/dist/v${node_version}"
curl --fail --location --silent --show-error \
  "$node_base_url/SHASUMS256.txt" \
  --output "$temp_root/SHASUMS256.txt"
for target_architecture in "${target_architectures[@]}"; do
  node_archive="node-v${node_version}-darwin-${target_architecture}.tar.gz"
  curl --fail --location --silent --show-error \
    "$node_base_url/$node_archive" \
    --output "$temp_root/$node_archive"
  expected_node_hash="$(awk -v file="$node_archive" '$2 == file { print $1 }' "$temp_root/SHASUMS256.txt")"
  actual_node_hash="$(shasum -a 256 "$temp_root/$node_archive" | awk '{ print $1 }')"
  if [[ -z "$expected_node_hash" || "$expected_node_hash" != "$actual_node_hash" ]]; then
    echo "Official Node.js $target_architecture runtime checksum verification failed." >&2
    exit 1
  fi
  tar -xzf "$temp_root/$node_archive" -C "$temp_root"
  mkdir -p "$stage_root/runtime/$target_architecture"
  cp \
    "$temp_root/node-v${node_version}-darwin-${target_architecture}/bin/node" \
    "$stage_root/runtime/$target_architecture/node"
  chmod 0755 "$stage_root/runtime/$target_architecture/node"
done

cp -R "$repo_root/apps/collector/dist/." "$stage_root/app/"
cat >"$stage_root/app/package.json" <<EOF
{
  "name": "douyin-collector-runtime",
  "private": true,
  "type": "module",
  "version": "$version",
  "dependencies": {
    "ali-oss": "6.23.0",
    "cheerio": "1.1.2",
    "mysql2": "3.14.4",
    "playwright": "1.55.0",
    "zod": "4.1.5"
  }
}
EOF

cd "$stage_root/app"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
npm_config_platform=darwin \
npm install \
  --omit=dev \
  --ignore-scripts \
  --no-package-lock \
  --no-audit \
  --no-fund

mkdir -p "$stage_root/app/node_modules/@douyin"
for workspace_package in contracts domain platform-douyin; do
  target_package="$stage_root/app/node_modules/@douyin/$workspace_package"
  mkdir -p "$target_package"
  cp -R "$repo_root/packages/$workspace_package/dist" "$target_package/dist"
  cp "$repo_root/packages/$workspace_package/package.json" "$target_package/package.json"
done

cat >"$stage_root/collector.env.example" <<'EOF'
NODE_ENV=production
COLLECTOR_API_BASE_URL=https://ops.example.com
COLLECTOR_DATA_DIR=../data
COLLECTOR_CONTROL_PORT=43127
EOF
cat >"$stage_root/collector.env" <<EOF
NODE_ENV=production
COLLECTOR_API_BASE_URL=$normalized_api_base_url
COLLECTOR_DATA_DIR=../data
COLLECTOR_CONTROL_PORT=43127
EOF
if [[ -n "$resolved_ca_certificate" ]]; then
  mkdir -p "$stage_root/certs"
  cp "$resolved_ca_certificate" "$stage_root/certs/server-ca.pem"
fi
cp "$repo_root/docs/collector-macos.md" "$stage_root/README.md"

cat >"$stage_root/start-collector.command" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd -P)"
if [[ ! -f "$root/collector.env" ]]; then
  echo '发布包不完整：缺少 collector.env。请重新领取管理员提供的完整发布包。' >&2
  read -r -p '按回车键关闭…' _
  exit 1
fi
if [[ -f "$root/certs/server-ca.pem" ]]; then
  export NODE_EXTRA_CA_CERTS="$root/certs/server-ca.pem"
fi
export COLLECTOR_OPEN_CONTROL_PAGE='1'
cd "$root"
case "$(uname -m)" in
  arm64) node_path="$root/runtime/arm64/node" ;;
  x86_64) node_path="$root/runtime/x64/node" ;;
  *)
    echo "不支持的 Mac 架构：$(uname -m)" >&2
    read -r -p '按回车键关闭…' _
    exit 1
    ;;
esac
if [[ ! -x "$node_path" ]]; then
  echo "发布包不包含当前 Mac 架构所需的运行时：$node_path" >&2
  read -r -p '按回车键关闭…' _
  exit 1
fi
exec "$node_path" --enable-source-maps --env-file="$root/collector.env" "$root/app/index.js"
EOF
chmod 0755 "$stage_root/start-collector.command"

mkdir -p "$stage_root/smoke"
cat >"$stage_root/smoke/smoke.mjs" <<'EOF'
process.env.NODE_ENV = 'test';
const dataRoot = process.argv[2];
const skipVisibleChrome = process.argv.includes('--skip-visible-chrome');
const collector = await import('../app/index.js');
const cleanupProtector = new collector.MacOsKeychainProtector(dataRoot);
try {
  const tokenStore = new collector.DeviceTokenStore(dataRoot);
  await collector.pairAndStoreCollectorDevice({
    apiBaseUrl: 'https://ops.example.test',
    collectorVersion: collector.COLLECTOR_VERSION,
    deviceName: 'isolated-macos-smoke-device',
    pairingCode: 'SMOKE-PAIR',
    parserVersion: '0.2.0',
  }, tokenStore, async () => ({
    ok: true,
    status: 201,
    json: async () => ({ deviceId: 'smoke-device', token: 'smoke-device-token-value-00000001' }),
  }));
  if ((await tokenStore.load()) !== 'smoke-device-token-value-00000001') {
    throw new Error('macOS Keychain token round trip failed');
  }
  const profiles = new collector.CollectorBrowserProfileStore(dataRoot);
  await profiles.createProfile('clean-macos-smoke');
  if (!skipVisibleChrome) {
    const context = await collector.launchSelectedCollectorProfile(profiles);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await context.close();
  }
  console.log(JSON.stringify({ keychain: true, profile: true, visibleChrome: !skipVisibleChrome }));
} finally {
  await cleanupProtector.delete().catch(() => undefined);
}
EOF

cd "$temp_root"
tar -czf "$archive_path" "$package_name"
archive_hash="$(shasum -a 256 "$archive_path" | awk '{ print $1 }')"
printf '%s  %s\n' "$archive_hash" "$(basename "$archive_path")" >"$checksum_path"
echo "$archive_path"
