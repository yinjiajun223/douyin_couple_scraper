import { describe, expect, it } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';

import {
  assertRunStatusTransition,
  canTransitionRunStatus,
  determineRunStopReason,
  InvalidRunStatusTransitionError,
} from './run-service.js';

describe('采集运行状态机', () => {
  it('允许领取、显式开始、暂停、继续和结束路径', () => {
    expect(canTransitionRunStatus('ready', 'claimed')).toBe(true);
    expect(canTransitionRunStatus('claimed', 'running')).toBe(true);
    expect(canTransitionRunStatus('running', 'paused')).toBe(true);
    expect(canTransitionRunStatus('paused', 'running')).toBe(true);
    expect(canTransitionRunStatus('running', 'completed')).toBe(true);
    expect(canTransitionRunStatus('running', 'terminated')).toBe(true);
  });

  it('拒绝跳过本地人工开始或离开终态', () => {
    expect(() => assertRunStatusTransition('ready', 'running')).toThrow(
      InvalidRunStatusTransitionError,
    );
    expect(() => assertRunStatusTransition('claimed', 'completed')).toThrow(
      InvalidRunStatusTransitionError,
    );
    expect(() => assertRunStatusTransition('completed', 'running')).toThrow(
      InvalidRunStatusTransitionError,
    );
  });

  it('达到任一冻结停止条件时返回明确原因', () => {
    const rules = createDefaultCampaignRuleSet();
    expect(
      determineRunStopReason(rules, {
        feedItemsSeen: 50,
        creatorProfilesSeen: 10,
        candidatesFound: 2,
        elapsedSeconds: 600,
      }),
    ).toBeNull();
    expect(
      determineRunStopReason(rules, {
        feedItemsSeen: 100,
        creatorProfilesSeen: 10,
        candidatesFound: 2,
        elapsedSeconds: 600,
      }),
    ).toBe('max_feed_items');
    expect(
      determineRunStopReason(rules, {
        feedItemsSeen: 50,
        creatorProfilesSeen: 50,
        candidatesFound: 2,
        elapsedSeconds: 600,
      }),
    ).toBe('max_creator_profiles');
    expect(
      determineRunStopReason(rules, {
        feedItemsSeen: 50,
        creatorProfilesSeen: 10,
        candidatesFound: 2,
        elapsedSeconds: 3_600,
      }),
    ).toBe('max_duration_minutes');
  });
});
