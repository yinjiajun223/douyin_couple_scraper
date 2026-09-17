import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  applyCollectionSafetyGate,
  decideLowConfidenceAction,
  detectCollectionSafetyIssue,
  parseLowConfidencePolicy,
  updateLowConfidenceConsecutiveFailures,
} from './safety-gate.js';

const fixtures = {
  abnormal_page: readFileSync(new URL('./fixtures/abnormal.html', import.meta.url), 'utf8'),
  captcha_required: readFileSync(new URL('./fixtures/captcha.html', import.meta.url), 'utf8'),
  login_required: readFileSync(new URL('./fixtures/login-expired.html', import.meta.url), 'utf8'),
};

const progress = {
  candidatesFound: 2,
  creatorProfilesSeen: 5,
  elapsedSeconds: 120,
  feedItemsSeen: 18,
};

describe('采集 fail-closed 安全闸门', () => {
  it.each([
    ['login_required', 'https://www.douyin.com/login', fixtures.login_required],
    ['captcha_required', 'https://www.douyin.com/verifycenter', fixtures.captcha_required],
    ['abnormal_page', 'https://www.douyin.com/', fixtures.abnormal_page],
  ] as const)('检测到 %s 时先保存进度，再暂停并返回人工提示', async (code, url, bodyText) => {
    const order: string[] = [];
    const saveSafetyPause = vi.fn().mockImplementation(async () => {
      order.push('save');
    });
    const changeRunStatus = vi.fn().mockImplementation(async () => {
      order.push('pause');
    });

    const result = await applyCollectionSafetyGate({
      page: { bodyText, parserConfidence: 0.99, url },
      persistence: { saveSafetyPause },
      progress,
      runControl: { changeRunStatus },
      runId: 'run-1',
    });

    expect(result.status).toBe('paused');
    expect(result.issue).toMatchObject({ code, humanMessage: expect.stringContaining('人工') });
    expect(order).toEqual(['save', 'pause']);
    expect(saveSafetyPause).toHaveBeenCalledWith({
      issue: result.issue,
      progress,
      runId: 'run-1',
    });
    expect(changeRunStatus).toHaveBeenCalledWith('run-1', 'pause');
  });

  it('解析可信度过低时拒绝继续写入', () => {
    expect(
      detectCollectionSafetyIssue({
        bodyText: '正常页面但关键选择器缺失',
        parserConfidence: 0.4,
        url: 'https://www.douyin.com/user/creator',
      }),
    ).toMatchObject({ code: 'low_parser_confidence' });
  });

  it('低可信度策略支持连续次数暂停和永不暂停', () => {
    const pauseAfterThree = parseLowConfidencePolicy({
      consecutiveLimit: 3,
      mode: 'pause_after_consecutive',
    });
    expect(decideLowConfidenceAction(pauseAfterThree, 1)).toBe('skip');
    expect(decideLowConfidenceAction(pauseAfterThree, 2)).toBe('skip');
    expect(decideLowConfidenceAction(pauseAfterThree, 3)).toBe('pause');
    expect(decideLowConfidenceAction({ mode: 'never_pause' }, 10_000)).toBe('skip');
  });

  it('一次可信解析会清零连续低可信度次数', () => {
    let consecutiveFailures = updateLowConfidenceConsecutiveFailures(0, 'low_confidence');
    consecutiveFailures = updateLowConfidenceConsecutiveFailures(
      consecutiveFailures,
      'low_confidence',
    );
    expect(consecutiveFailures).toBe(2);
    expect(updateLowConfidenceConsecutiveFailures(consecutiveFailures, 'trusted')).toBe(0);
  });

  it('拒绝越界的连续低可信度次数', () => {
    expect(() =>
      parseLowConfidencePolicy({ consecutiveLimit: 0, mode: 'pause_after_consecutive' }),
    ).toThrow('1-1000');
    expect(() =>
      parseLowConfidencePolicy({ consecutiveLimit: 1.5, mode: 'pause_after_consecutive' }),
    ).toThrow('1-1000');
  });

  it('登录、验证码和异常页面优先于低可信度判断', () => {
    expect(
      detectCollectionSafetyIssue({
        bodyText: fixtures.login_required,
        parserConfidence: 0.1,
        url: 'https://www.douyin.com/login',
      }),
    ).toMatchObject({ code: 'login_required' });
    expect(
      detectCollectionSafetyIssue({
        bodyText: fixtures.captcha_required,
        parserConfidence: 0.1,
        url: 'https://www.douyin.com/verifycenter',
      }),
    ).toMatchObject({ code: 'captcha_required' });
    expect(
      detectCollectionSafetyIssue({
        bodyText: fixtures.abnormal_page,
        parserConfidence: 0.1,
        statusCode: 503,
        url: 'https://www.douyin.com/',
      }),
    ).toMatchObject({ code: 'abnormal_page' });
  });

  it('正常页面允许继续且不触发持久化或暂停', async () => {
    const persistence = { saveSafetyPause: vi.fn() };
    const runControl = { changeRunStatus: vi.fn() };
    await expect(
      applyCollectionSafetyGate({
        page: {
          bodyText: '边界同学 粉丝 4999 作品',
          parserConfidence: 0.95,
          url: 'https://www.douyin.com/user/boundary-author',
        },
        persistence,
        progress,
        runControl,
        runId: 'run-1',
      }),
    ).resolves.toEqual({ issue: null, status: 'continue' });
    expect(persistence.saveSafetyPause).not.toHaveBeenCalled();
    expect(runControl.changeRunStatus).not.toHaveBeenCalled();
  });
});
