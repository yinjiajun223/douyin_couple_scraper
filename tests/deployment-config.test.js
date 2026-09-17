import { describe, expect, it } from 'vitest';

import { validateProductionEnvironment } from '../scripts/preflight-production.mjs';
import { readFileSync } from 'node:fs';

const validEnvironment = {
  API_IMAGE: 'registry.local/douyin-api:2026.09.15-1',
  APP_DOMAIN: 'ops.example.cn',
  CREDENTIAL_ENCRYPTION_KEY: 'e'.repeat(40),
  DATABASE_URL: 'mysql://douyin_app:password@rds.local:3306/douyin_ops?ssl-mode=REQUIRED',
  MIGRATION_DATABASE_URL:
    'mysql://douyin_migrator:password@rds.local:3306/douyin_ops?ssl-mode=REQUIRED',
  NODE_ENV: 'production',
  OSS_ACCESS_KEY_ID: 'access-key-id',
  OSS_ACCESS_KEY_SECRET: 'secret-value',
  OSS_BUCKET: 'private-evidence',
  OSS_BUCKET_PRIVATE: 'true',
  OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com',
  OSS_READINESS_PROBE: 'true',
  OSS_REGION: 'cn-hangzhou',
  RDS_ALLOWED_CIDRS: '106.12.56.109/32',
  RDS_CA_CERT_PATH: '/srv/douyin-ops/certs/rds-ca.pem',
  SESSION_SECRET: 's'.repeat(40),
  TLS_CERT_DIRECTORY: '/srv/douyin-ops/tls',
  TRUSTED_PROXY_CIDR: '127.0.0.1/32',
  WEB_IMAGE: 'registry.local/douyin-web:2026.09.15-1',
  WORKER_IMAGE: 'registry.local/douyin-worker:2026.09.15-1',
};

describe('production preflight', () => {
  it('accepts separated least-privilege TLS database roles and private OSS', () => {
    expect(validateProductionEnvironment(validEnvironment)).toEqual([]);
  });

  it('rejects public RDS access, plaintext transport, shared admin roles, weak secrets and public OSS', () => {
    const errors = validateProductionEnvironment({
      ...validEnvironment,
      CREDENTIAL_ENCRYPTION_KEY: 'short',
      DATABASE_URL: 'mysql://root:password@rds.local:3306/douyin_ops',
      MIGRATION_DATABASE_URL: 'mysql://root:password@rds.local:3306/douyin_ops',
      OSS_BUCKET_PRIVATE: 'false',
      OSS_ENDPOINT: 'http://oss.local',
      RDS_ALLOWED_CIDRS: '0.0.0.0/0',
      RDS_CA_CERT_PATH: '',
      SESSION_SECRET: '<replace-me>',
    });

    expect(errors.join('\n')).toMatch(/ssl-mode=REQUIRED/u);
    expect(errors.join('\n')).toMatch(/root\/admin/u);
    expect(errors.join('\n')).toMatch(/0\.0\.0\.0\/0/u);
    expect(errors.join('\n')).toMatch(/RDS_CA_CERT_PATH/u);
    expect(errors.join('\n')).toMatch(/OSS_BUCKET_PRIVATE/u);
    expect(errors.join('\n')).toMatch(/至少 32/u);
  });
});

describe('production reverse proxy policy', () => {
  const nginx = readFileSync(
    new URL('../infra/production/nginx.conf.template', import.meta.url),
    'utf8',
  );
  const compose = readFileSync(new URL('../infra/production/compose.yml', import.meta.url), 'utf8');

  it('publishes only HTTP/HTTPS and redirects HTTP to HTTPS', () => {
    expect(compose).toMatch(/- ['"]80:80['"]/u);
    expect(compose).toMatch(/- ['"]443:443['"]/u);
    expect(compose).not.toMatch(/- ['"]3000:3000['"]/u);
    expect(nginx).toMatch(/return 308 https:\/\//u);
  });

  it('sets real IP, body/rate limits and baseline security headers', () => {
    expect(nginx).toMatch(/set_real_ip_from/u);
    expect(nginx).toMatch(/real_ip_header X-Forwarded-For/u);
    expect(nginx).toMatch(/client_max_body_size 10m/u);
    expect(nginx).toMatch(/limit_req zone=/u);
    expect(nginx).toMatch(/Strict-Transport-Security/u);
    expect(nginx).toMatch(/Content-Security-Policy/u);
    expect(nginx).toMatch(/X-Content-Type-Options/u);
  });

  it('mounts the trusted RDS CA into every database client container', () => {
    expect(compose).toMatch(/NODE_EXTRA_CA_CERTS: \/run\/certs\/rds-ca\.pem/u);
    expect(compose).toMatch(/\$\{RDS_CA_CERT_PATH\}:\/run\/certs\/rds-ca\.pem:ro/u);
    expect(compose.match(/volumes: \*rds-ca-volumes/gu)).toHaveLength(3);
  });
});
