import { describe, expect, it } from 'vitest';

import {
  createIdleRecoveryCheckpoint,
  normalizeRecoveryCheckpoint,
  recordContextRestart,
  RECOVERY_CIRCUIT_WINDOW_MS,
  RECOVERY_RECURRENCE_WINDOW_MS,
  recoveryDelayMs,
  recoveryStartIndex,
} from './recovery-controller.js';

describe('长运行恢复控制器', () => {
  it('三级退避带有界抖动', () => {
    expect(recoveryDelayMs({ baseDelayMs: 15_000, stage: 'reload_page' }, 0)).toBe(15_000);
    expect(recoveryDelayMs({ baseDelayMs: 60_000, stage: 'recreate_profile_page' }, 0.5)).toBe(
      66_000,
    );
    expect(recoveryDelayMs({ baseDelayMs: 300_000, stage: 'restart_browser' }, 1)).toBe(360_000);
  });

  it('两分钟内复发从下一阶段开始，边界及过窗后从刷新重新开始', () => {
    const now = Date.parse('2026-09-23T00:10:00.000Z');
    const state = {
      ...createIdleRecoveryCheckpoint(),
      lastRecoveredAt: new Date(now - RECOVERY_RECURRENCE_WINDOW_MS + 1).toISOString(),
      lastResult: 'recovered' as const,
      stage: 'reload_page' as const,
    };
    expect(recoveryStartIndex(state, now)).toBe(1);
    expect(
      recoveryStartIndex(
        {
          ...state,
          lastRecoveredAt: new Date(now - RECOVERY_RECURRENCE_WINDOW_MS).toISOString(),
        },
        now,
      ),
    ).toBe(0);
  });

  it('一小时滚动窗口内第三次上下文恢复恰好打开熔断，过窗记录被清除', () => {
    const now = Date.parse('2026-09-23T01:00:00.000Z');
    const state = {
      ...createIdleRecoveryCheckpoint(),
      contextRestartTimestamps: [
        new Date(now - RECOVERY_CIRCUIT_WINDOW_MS).toISOString(),
        new Date(now - 30_000).toISOString(),
      ],
    };
    const secondInWindow = recordContextRestart(state, now);
    expect(secondInWindow).toMatchObject({ circuitOpen: false });
    expect(secondInWindow.timestamps).toHaveLength(2);
    const thirdInWindow = recordContextRestart(
      { ...state, contextRestartTimestamps: secondInWindow.timestamps },
      now + 1,
    );
    expect(thirdInWindow).toMatchObject({ circuitOpen: true });
    expect(thirdInWindow.timestamps).toHaveLength(3);
  });

  it('损坏或缺失的旧恢复字段安全归一化', () => {
    expect(normalizeRecoveryCheckpoint(undefined)).toEqual(createIdleRecoveryCheckpoint());
    expect(
      normalizeRecoveryCheckpoint({
        attemptCount: -5,
        contextRestartTimestamps: ['2026-09-23T00:00:00.000Z', 123],
        issueCode: 'unknown',
        lastResult: 'unknown',
        pageType: 'unknown',
        stage: 'unknown',
      }),
    ).toMatchObject({
      attemptCount: 0,
      contextRestartTimestamps: ['2026-09-23T00:00:00.000Z'],
      issueCode: null,
      lastResult: 'idle',
      pageType: null,
      stage: 'idle',
    });
  });
});
