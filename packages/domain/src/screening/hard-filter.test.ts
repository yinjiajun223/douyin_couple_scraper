import { describe, expect, it } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';

import { evaluateHardFilters } from './hard-filter.js';

const evaluatedAt = new Date('2026-09-15T08:00:00.000Z');

function post(
  id: string,
  overrides: Partial<{
    likeCount: number | null;
    likeCountRaw: string | null;
    publishedAt: Date | string | null;
  }> = {},
) {
  return {
    postId: `post-${id}`,
    postObservationId: `post-observation-${id}`,
    postUrl: `https://www.douyin.com/video/${id}`,
    likeCount: 12_000,
    likeCountRaw: '1.2万',
    publishedAt: '2026-09-10T08:00:00.000Z',
    observedAt: evaluatedAt,
    ...overrides,
  };
}

describe('三态硬筛引擎', () => {
  it('只观察到部分作品时，未发现爆款不能判定不符合', () => {
    const result = evaluateHardFilters(createDefaultCampaignRuleSet(), {
      creatorObservationId: 'partial-profile',
      followerCount: 1000,
      followerCountRaw: '1000',
      posts: [post('partial', { likeCount: 30 })],
      postsWindowComplete: false,
      evaluatedAt,
    });
    expect(result.outcome).toBe('unknown');
    expect(result.evaluations[1]?.evidence.postsWindowComplete).toBe(false);
  });
  it('缺少粉丝数时返回 unknown，不把空值当作 0', () => {
    const result = evaluateHardFilters(createDefaultCampaignRuleSet(), {
      creatorObservationId: 'creator-observation-1',
      followerCount: null,
      followerCountRaw: '暂未展示',
      posts: [post('1')],
      evaluatedAt,
    });

    expect(result.outcome).toBe('unknown');
    expect(result.evaluations).toContainEqual(
      expect.objectContaining({
        ruleType: 'follower-range',
        outcome: 'unknown',
        evidence: expect.objectContaining({ reason: 'missing_follower_count' }),
      }),
    );
  });

  it('滚动窗口包含精确边界，但不包含早一毫秒的作品', () => {
    const rules = createDefaultCampaignRuleSet();
    const atBoundary = evaluateHardFilters(rules, {
      creatorObservationId: 'creator-observation-2',
      followerCount: 1_000,
      followerCountRaw: '1000',
      posts: [post('boundary', { publishedAt: '2026-08-31T08:00:00.000Z' })],
      evaluatedAt,
    });
    const outsideBoundary = evaluateHardFilters(rules, {
      creatorObservationId: 'creator-observation-3',
      followerCount: 1_000,
      followerCountRaw: '1000',
      posts: [post('outside', { publishedAt: '2026-08-31T07:59:59.999Z' })],
      evaluatedAt,
    });

    expect(atBoundary.outcome).toBe('pass');
    expect(outsideBoundary.outcome).toBe('fail');
  });

  it('保留所有命中作品作为可追溯证据', () => {
    const result = evaluateHardFilters(createDefaultCampaignRuleSet(), {
      creatorObservationId: 'creator-observation-4',
      followerCount: 4_999,
      followerCountRaw: '4999',
      posts: [post('viral-a'), post('viral-b', { likeCount: 20_000, likeCountRaw: '2万' })],
      evaluatedAt,
    });
    const viralRule = result.evaluations.find(
      (evaluation) => evaluation.ruleType === 'recent-post-likes',
    );

    expect(result.outcome).toBe('pass');
    expect(viralRule?.evidenceReferences).toEqual([
      { kind: 'post-observation', id: 'post-observation-viral-a' },
      { kind: 'post-observation', id: 'post-observation-viral-b' },
    ]);
    expect(viralRule?.evidence).toMatchObject({
      matchedPosts: [
        expect.objectContaining({ likeCount: 12_000, likeCountRaw: '1.2万' }),
        expect.objectContaining({ likeCount: 20_000, likeCountRaw: '2万' }),
      ],
    });
  });

  it('窗口内作品缺少点赞数时返回 unknown 并引用该作品', () => {
    const result = evaluateHardFilters(createDefaultCampaignRuleSet(), {
      creatorObservationId: 'creator-observation-5',
      followerCount: 2_000,
      followerCountRaw: '2000',
      posts: [post('unknown-likes', { likeCount: null, likeCountRaw: '--' })],
      evaluatedAt,
    });
    const viralRule = result.evaluations.find(
      (evaluation) => evaluation.ruleType === 'recent-post-likes',
    );

    expect(result.outcome).toBe('unknown');
    expect(viralRule).toMatchObject({
      outcome: 'unknown',
      evidenceReferences: [{ kind: 'post-observation', id: 'post-observation-unknown-likes' }],
    });
  });
});
