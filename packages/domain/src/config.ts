import { z } from 'zod';

const placeholderPattern = /(change[-_ ]?me|replace[-_ ]?me|placeholder|example|todo)/i;
const sensitiveKeyPattern =
  /(authorization|cookie|credential|password|secret|token|api[-_]?key|access[-_]?key)/i;

const nodeEnvironmentSchema = z.enum(['development', 'test', 'production']).default('development');

const mysqlUrlSchema = z
  .url('必须是有效 URL')
  .refine((value) => new URL(value).protocol === 'mysql:', '必须使用 mysql:// 协议');

const requiredSecret = (minimumLength: number) =>
  z
    .string()
    .min(minimumLength, `长度至少为 ${minimumLength} 个字符`)
    .refine((value) => !placeholderPattern.test(value), '不能使用示例或占位密钥');

const optionalSecret = (minimumLength: number) => requiredSecret(minimumLength).optional();

const apiConfigSchema = z.object({
  NODE_ENV: nodeEnvironmentSchema,
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: mysqlUrlSchema,
  SESSION_SECRET: requiredSecret(32),
  CREDENTIAL_ENCRYPTION_KEY: requiredSecret(32),
  OSS_ENDPOINT: z.url(),
  OSS_REGION: z.string().min(1),
  OSS_BUCKET: z.string().min(3),
  OSS_ACCESS_KEY_ID: requiredSecret(8),
  OSS_ACCESS_KEY_SECRET: requiredSecret(16),
  COLLECTOR_MIN_VERSION: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .default('0.1.0'),
});

const workerConfigSchema = z.object({
  NODE_ENV: nodeEnvironmentSchema,
  DATABASE_URL: mysqlUrlSchema,
  CREDENTIAL_ENCRYPTION_KEY: requiredSecret(32),
  OSS_ENDPOINT: z.url(),
  OSS_REGION: z.string().min(1),
  OSS_BUCKET: z.string().min(3),
  OSS_ACCESS_KEY_ID: requiredSecret(8),
  OSS_ACCESS_KEY_SECRET: requiredSecret(16),
  WORKER_ID: z.string().min(1).default('worker-1'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  MEDIA_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(180),
  MEDIA_CLEANUP_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  MEDIA_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),
});

const collectorConfigSchema = z
  .object({
    NODE_ENV: nodeEnvironmentSchema,
    COLLECTOR_API_BASE_URL: z.url(),
    COLLECTOR_DATA_DIR: z.string().min(1).default('./collector-data'),
    COLLECTOR_DEVICE_TOKEN: optionalSecret(24),
    COLLECTOR_CONTROL_PORT: z.coerce.number().int().min(1).max(65_535).default(43_127),
  })
  .superRefine((value, context) => {
    if (
      value.NODE_ENV === 'production' &&
      new URL(value.COLLECTOR_API_BASE_URL).protocol !== 'https:'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['COLLECTOR_API_BASE_URL'],
        message: '生产环境必须使用 HTTPS',
      });
    }
  });

export type ApiConfig = z.infer<typeof apiConfigSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export type CollectorConfig = z.infer<typeof collectorConfigSchema>;

export class ConfigValidationError extends Error {
  readonly scope: string;
  readonly fields: readonly string[];

  constructor(scope: string, issues: readonly z.core.$ZodIssue[]) {
    const details = issues.map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : 'configuration';
      return `${field}: ${issue.message}`;
    });
    super(`${scope} 配置无效：${details.join('；')}`);
    this.name = 'ConfigValidationError';
    this.scope = scope;
    this.fields = issues.map((issue) => issue.path.join('.')).filter(Boolean);
  }
}

function parseConfig<T>(scope: string, schema: z.ZodType<T>, environment: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(environment);
  if (!result.success) {
    throw new ConfigValidationError(scope, result.error.issues);
  }
  return result.data;
}

export function parseApiConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  return parseConfig('API', apiConfigSchema, environment);
}

export function parseWorkerConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  return parseConfig('Worker', workerConfigSchema, environment);
}

export function parseCollectorConfig(environment: NodeJS.ProcessEnv): CollectorConfig {
  return parseConfig('Collector', collectorConfigSchema, environment);
}

export function redactSensitiveValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveValues);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sensitiveKeyPattern.test(key) ? '[REDACTED]' : redactSensitiveValues(entry),
      ]),
    );
  }

  return value;
}
