import { describe, expect, it } from 'vitest';

import { runReadinessChecks } from './health.js';

describe('service readiness', () => {
  it('distinguishes a required MySQL failure from optional AI degradation', async () => {
    const report = await runReadinessChecks({
      ai: {
        check: async () => Promise.reject(new TypeError('provider unavailable')),
        required: false,
      },
      mysql: {
        check: async () =>
          Promise.reject(
            Object.assign(new Error('connection refused'), { name: 'MysqlUnavailable' }),
          ),
        required: true,
      },
      oss: { check: async () => undefined, required: true },
    });

    expect(report.status).toBe('unavailable');
    expect(report.components).toEqual({
      ai: { errorType: 'TypeError', required: false, status: 'down' },
      mysql: { errorType: 'MysqlUnavailable', required: true, status: 'down' },
      oss: { required: true, status: 'up' },
    });
  });

  it('reports an OSS outage separately and keeps an optional AI outage degraded', async () => {
    const ossFailure = await runReadinessChecks({
      ai: { check: async () => undefined, required: false },
      mysql: { check: async () => undefined, required: true },
      oss: { check: async () => Promise.reject(new Error('timeout')), required: true },
    });
    const aiFailure = await runReadinessChecks({
      ai: { check: async () => Promise.reject(new Error('rate limited')), required: false },
      mysql: { check: async () => undefined, required: true },
      oss: { check: async () => undefined, required: true },
    });

    expect(ossFailure.status).toBe('unavailable');
    expect(ossFailure.components.oss?.status).toBe('down');
    expect(aiFailure.status).toBe('degraded');
    expect(aiFailure.components.ai?.status).toBe('down');
  });
});
