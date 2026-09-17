import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { collectVisibleRecommendationFeed } from './recommendation-feed.js';

const feedFixture = readFileSync(
  new URL(
    '../../../packages/platform-douyin/src/fixtures/recommendation-feed.html',
    import.meta.url,
  ),
  'utf8',
);

describe('可见推荐流低速读取', () => {
  it('低速滚动、跨批次去重，且不调用任何互动动作', async () => {
    const forbiddenActions = {
      comment: vi.fn(),
      dislike: vi.fn(),
      follow: vi.fn(),
      like: vi.fn(),
      message: vi.fn(),
      share: vi.fn(),
    };
    const wheel = vi.fn();
    const waitForTimeout = vi.fn();
    const page = {
      ...forbiddenActions,
      content: vi.fn().mockResolvedValue(feedFixture),
      mouse: { wheel },
      waitForTimeout,
    };

    const result = await collectVisibleRecommendationFeed(page, {
      maxFeedItems: 10,
      maxScrolls: 2,
      minWaitMs: 1_200,
      maxWaitMs: 1_200,
      random: () => 0,
    });

    expect(result.items).toHaveLength(2);
    expect(result.scrollCount).toBe(2);
    expect(wheel).toHaveBeenCalledTimes(2);
    expect(waitForTimeout).toHaveBeenNthCalledWith(1, 1_200);
    for (const action of Object.values(forbiddenActions)) expect(action).not.toHaveBeenCalled();
  });

  it('拒绝配置成高频滚动', async () => {
    const page = {
      content: vi.fn(),
      mouse: { wheel: vi.fn() },
      waitForTimeout: vi.fn(),
    };
    await expect(
      collectVisibleRecommendationFeed(page, {
        maxFeedItems: 10,
        maxScrolls: 2,
        minWaitMs: 200,
      }),
    ).rejects.toThrow('at least one second');
  });
});
