import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLACEHOLDER = /(change[-_ ]?me|replace[-_ ]?me|placeholder|example|todo|<[^>]+>)/i;
const FORBIDDEN_DATABASE_USERS = new Set(['admin', 'administrator', 'root']);

export function parseEnvFile(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator < 1) return [line, ''];
        return [line.slice(0, separator), line.slice(separator + 1).replace(/^['"]|['"]$/gu, '')];
      }),
  );
}

export function validateProductionEnvironment(environment) {
  const errors = [];
  const requireValue = (key) => {
    const value = environment[key]?.trim();
    if (!value) errors.push(`${key} 未配置`);
    return value ?? '';
  };
  const checkSecret = (key) => {
    const value = requireValue(key);
    if (value.length < 32) errors.push(`${key} 必须至少 32 个字符`);
    if (PLACEHOLDER.test(value)) errors.push(`${key} 不能使用占位值`);
    return value;
  };
  const checkDatabaseUrl = (key, expectedRole) => {
    const raw = requireValue(key);
    try {
      const url = new URL(raw);
      if (url.protocol !== 'mysql:') errors.push(`${key} 必须使用 mysql://`);
      if (url.searchParams.get('ssl-mode')?.toUpperCase() !== 'REQUIRED') {
        errors.push(`${key} 必须包含 ssl-mode=REQUIRED`);
      }
      if (FORBIDDEN_DATABASE_USERS.has(decodeURIComponent(url.username).toLowerCase())) {
        errors.push(`${key} 不得使用 root/admin 管理账号`);
      }
      if (!url.username) errors.push(`${key} 缺少数据库用户名`);
      if (expectedRole && !decodeURIComponent(url.username).toLowerCase().includes(expectedRole)) {
        errors.push(`${key} 用户名应明确包含 ${expectedRole} 角色标识`);
      }
      return url;
    } catch {
      errors.push(`${key} 不是有效的 MySQL URL`);
      return null;
    }
  };

  if (environment.NODE_ENV !== 'production') errors.push('NODE_ENV 必须为 production');
  const runtimeDatabase = checkDatabaseUrl('DATABASE_URL', 'app');
  const migrationDatabase = checkDatabaseUrl('MIGRATION_DATABASE_URL', 'migrator');
  if (runtimeDatabase?.username === migrationDatabase?.username) {
    errors.push('运行账号与迁移账号必须分离');
  }

  checkSecret('SESSION_SECRET');

  const ossEndpoint = requireValue('OSS_ENDPOINT');
  try {
    if (new URL(ossEndpoint).protocol !== 'https:') errors.push('OSS_ENDPOINT 必须使用 HTTPS');
  } catch {
    errors.push('OSS_ENDPOINT 不是有效 URL');
  }
  requireValue('OSS_REGION');
  requireValue('OSS_BUCKET');
  requireValue('OSS_ACCESS_KEY_ID');
  requireValue('OSS_ACCESS_KEY_SECRET');
  if (environment.OSS_BUCKET_PRIVATE !== 'true') errors.push('OSS_BUCKET_PRIVATE 必须明确为 true');
  if (environment.OSS_READINESS_PROBE !== 'true') errors.push('OSS_READINESS_PROBE 必须为 true');

  const cidrs = requireValue('RDS_ALLOWED_CIDRS')
    .split(',')
    .map((value) => value.trim());
  if (cidrs.includes('0.0.0.0/0') || cidrs.includes('::/0')) {
    errors.push('RDS 白名单不得包含 0.0.0.0/0 或 ::/0');
  }
  if (!cidrs.some(Boolean)) errors.push('RDS_ALLOWED_CIDRS 必须记录实际服务器出口 IP/CIDR');
  requireValue('RDS_CA_CERT_PATH');

  const domain = requireValue('APP_DOMAIN');
  if (domain.includes('://') || domain.includes('/')) errors.push('APP_DOMAIN 只能填写主机名');
  requireValue('TRUSTED_PROXY_CIDR');
  requireValue('TLS_CERT_DIRECTORY');
  for (const imageKey of ['API_IMAGE', 'WORKER_IMAGE', 'WEB_IMAGE']) {
    const image = requireValue(imageKey);
    if (image.endsWith(':latest') || (!image.includes(':') && !image.includes('@sha256:'))) {
      errors.push(`${imageKey} 必须固定版本标签或 digest，不能使用 latest`);
    }
  }

  // 孤儿证据回收会永久删除 OSS 对象，因此允许缺省（应用侧默认关闭），
  // 但一旦写了就必须能被明确解析：'yes'/'on' 之类会在应用侧被拒，宁可预检就拦下来。
  const orphanEnabled = environment.ORPHAN_MEDIA_CLEANUP_ENABLED;
  if (orphanEnabled !== undefined && !['true', 'false', '1', '0'].includes(orphanEnabled)) {
    errors.push('ORPHAN_MEDIA_CLEANUP_ENABLED 只能是 true/false/1/0');
  }
  const orphanGraceDays = environment.ORPHAN_MEDIA_GRACE_DAYS;
  if (
    orphanGraceDays !== undefined &&
    (!/^\d+$/u.test(orphanGraceDays) || Number(orphanGraceDays) < 1)
  ) {
    errors.push('ORPHAN_MEDIA_GRACE_DAYS 必须是不小于 1 的整数天数');
  }

  return errors;
}

async function verifyLiveDependencies(environment) {
  const runtimeUrl = new URL(environment.DATABASE_URL);
  runtimeUrl.searchParams.delete('ssl-mode');
  const mysql = await import('mysql2/promise');
  const connection = await mysql.default.createConnection({
    ssl: { rejectUnauthorized: true },
    uri: runtimeUrl.toString(),
  });
  try {
    const [sslRows] = await connection.query("SHOW STATUS LIKE 'Ssl_cipher'");
    if (!Array.isArray(sslRows) || !sslRows[0]?.Value) throw new Error('RDS 连接未协商 TLS');
    const [grantRows] = await connection.query('SHOW GRANTS');
    const grants = JSON.stringify(grantRows).toUpperCase();
    if (
      grants.includes('ALL PRIVILEGES') ||
      grants.includes('CREATE USER') ||
      grants.includes('GRANT OPTION')
    ) {
      throw new Error('RDS 运行账号权限过高');
    }
  } finally {
    await connection.end();
  }

  const { default: OSS } = await import('ali-oss');
  const client = new OSS({
    accessKeyId: environment.OSS_ACCESS_KEY_ID,
    accessKeySecret: environment.OSS_ACCESS_KEY_SECRET,
    authorizationV4: true,
    bucket: environment.OSS_BUCKET,
    endpoint: environment.OSS_ENDPOINT,
    region: environment.OSS_REGION,
    secure: true,
  });
  const aclResult = await client.getBucketACL();
  if (aclResult.acl !== 'private')
    throw new Error(`OSS bucket ACL 必须为 private，当前为 ${aclResult.acl}`);
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const envIndex = arguments_.indexOf('--env');
  const envPath = resolve(envIndex >= 0 ? arguments_[envIndex + 1] : '.env.production');
  const environment = parseEnvFile(await readFile(envPath, 'utf8'));
  const errors = validateProductionEnvironment(environment);
  if (errors.length > 0) {
    for (const error of errors) console.error(`ERROR ${error}`);
    process.exitCode = 1;
    return;
  }
  await access(resolve(environment.TLS_CERT_DIRECTORY));
  await access(resolve(environment.RDS_CA_CERT_PATH));
  if (arguments_.includes('--live')) await verifyLiveDependencies(environment);
  console.log(
    `生产预检通过${arguments_.includes('--live') ? '（含 RDS TLS/权限与 OSS ACL 在线检查）' : ''}`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
