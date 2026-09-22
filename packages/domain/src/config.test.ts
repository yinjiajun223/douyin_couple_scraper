import { describe, expect, it } from 'vitest';

import {
  ConfigValidationError,
  parseApiConfig,
  parseCollectorConfig,
  parseWorkerConfig,
  redactSensitiveValues,
} from './config.js';

const validInfrastructure = {
  NODE_ENV: 'test',
  DATABASE_URL: 'mysql://app_user:local-password@127.0.0.1:3306/douyin_ops',
  OSS_ENDPOINT: 'https://oss-cn-example.aliyuncs.com',
  OSS_REGION: 'oss-cn-example',
  OSS_BUCKET: 'douyin-private-evidence',
  OSS_ACCESS_KEY_ID: 'local-key-id',
  OSS_ACCESS_KEY_SECRET: 's'.repeat(24),
};

describe('分层环境配置', () => {
  it('解析 API 配置并应用安全默认值', () => {
    const config = parseApiConfig({
      ...validInfrastructure,
      SESSION_SECRET: 'a'.repeat(32),
    });

    expect(config.API_PORT).toBe(3000);
    expect(config.COLLECTOR_MIN_VERSION).toBe('0.1.0');
  });

  it('API 缺少数据库地址时安全失败且不输出其他密钥', () => {
    const secret = 'never-print-this-secret-value';

    expect(() =>
      parseApiConfig({
        ...validInfrastructure,
        DATABASE_URL: undefined,
        SESSION_SECRET: secret.padEnd(32, 'x'),
      }),
    ).toThrow(ConfigValidationError);

    try {
      parseApiConfig({
        ...validInfrastructure,
        DATABASE_URL: undefined,
        SESSION_SECRET: secret.padEnd(32, 'x'),
      });
    } catch (error) {
      expect(String(error)).toContain('DATABASE_URL');
      expect(String(error)).not.toContain(secret);
    }
  });

  it('拒绝 API 和 Worker 的占位密钥', () => {
    expect(() =>
      parseApiConfig({
        ...validInfrastructure,
        SESSION_SECRET: 'change-me'.padEnd(32, '-'),
      }),
    ).toThrow('不能使用示例或占位密钥');

    expect(() =>
      parseWorkerConfig({
        ...validInfrastructure,
        OSS_ACCESS_KEY_SECRET: 'replace-me'.padEnd(16, '-'),
      }),
    ).toThrow('不能使用示例或占位密钥');
  });

  it('Worker 应用可配置的素材保留与清理默认值', () => {
    const config = parseWorkerConfig(validInfrastructure);

    expect(config.MEDIA_RETENTION_DAYS).toBe(180);
    expect(config.MEDIA_CLEANUP_BATCH_SIZE).toBe(100);
    expect(config.MEDIA_CLEANUP_INTERVAL_MS).toBe(3_600_000);
    // 孤儿回收删除的是不可恢复的 OSS 对象，缺省必须关闭。
    expect(config.ORPHAN_MEDIA_CLEANUP_ENABLED).toBe(false);
    expect(config.ORPHAN_MEDIA_GRACE_DAYS).toBe(7);
    expect(
      parseWorkerConfig({
        ...validInfrastructure,
        MEDIA_RETENTION_DAYS: '30',
        MEDIA_CLEANUP_BATCH_SIZE: '25',
        ORPHAN_MEDIA_CLEANUP_ENABLED: 'true',
        ORPHAN_MEDIA_GRACE_DAYS: '3',
      }),
    ).toMatchObject({
      MEDIA_RETENTION_DAYS: 30,
      MEDIA_CLEANUP_BATCH_SIZE: 25,
      ORPHAN_MEDIA_CLEANUP_ENABLED: true,
      ORPHAN_MEDIA_GRACE_DAYS: 3,
    });
  });

  it('孤儿回收开关只接受明确字面量，宽限期必须是 1 到 3650 天的整数', () => {
    for (const enabled of ['yes', 'on', 'TRUE', '']) {
      expect(() =>
        parseWorkerConfig({ ...validInfrastructure, ORPHAN_MEDIA_CLEANUP_ENABLED: enabled }),
      ).toThrow('ORPHAN_MEDIA_CLEANUP_ENABLED');
    }
    expect(
      parseWorkerConfig({ ...validInfrastructure, ORPHAN_MEDIA_CLEANUP_ENABLED: '0' }),
    ).toMatchObject({ ORPHAN_MEDIA_CLEANUP_ENABLED: false });

    for (const graceDays of ['0', '-1', '7.5', 'abc', '3651']) {
      expect(() =>
        parseWorkerConfig({ ...validInfrastructure, ORPHAN_MEDIA_GRACE_DAYS: graceDays }),
      ).toThrow('ORPHAN_MEDIA_GRACE_DAYS');
    }
  });

  it('Collector 生产地址必须使用 HTTPS', () => {
    expect(() =>
      parseCollectorConfig({
        NODE_ENV: 'production',
        COLLECTOR_API_BASE_URL: 'http://example.test',
      }),
    ).toThrow('生产环境必须使用 HTTPS');
  });

  it('Collector 未配对时可启动，但提供的占位令牌会失败', () => {
    expect(
      parseCollectorConfig({
        NODE_ENV: 'test',
        COLLECTOR_API_BASE_URL: 'http://127.0.0.1:3000',
      }).COLLECTOR_DEVICE_TOKEN,
    ).toBeUndefined();

    expect(() =>
      parseCollectorConfig({
        NODE_ENV: 'test',
        COLLECTOR_API_BASE_URL: 'http://127.0.0.1:3000',
        COLLECTOR_DEVICE_TOKEN: 'placeholder-device-token-value',
      }),
    ).toThrow('不能使用示例或占位密钥');
  });
});

describe('日志脱敏', () => {
  it('递归遮蔽秘密字段并保留可诊断字段', () => {
    expect(
      redactSensitiveValues({
        endpoint: 'https://example.test',
        authorization: 'Bearer secret',
        nested: { deviceToken: 'device-secret', reason: 'timeout' },
      }),
    ).toEqual({
      endpoint: 'https://example.test',
      authorization: '[REDACTED]',
      nested: { deviceToken: '[REDACTED]', reason: 'timeout' },
    });
  });
});
