import { describe, expect, it } from 'vitest';

import {
  COLLECTOR_PROTOCOL_VERSION,
  assertCollectorProtocolCompatible,
  collectorBatchSchema,
} from './collector.js';
import {
  campaignRuleSetSchema,
  createDefaultCampaignRuleSet,
  parseCampaignRuleSet,
  UnsupportedCampaignRuleSchemaVersionError,
} from './rules.js';

describe('筛选规则契约', () => {
  it('默认规则可以 JSON 往返且保持首版业务阈值', () => {
    const serialized = JSON.stringify(createDefaultCampaignRuleSet());
    const parsed = campaignRuleSetSchema.parse(JSON.parse(serialized));

    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.hardRules).toContainEqual(
      expect.objectContaining({ type: 'follower-range', min: 0, max: 5_000 }),
    );
    expect(parsed.hardRules).toContainEqual(
      expect.objectContaining({ type: 'recent-post-likes', windowDays: 15, minimumLikes: 10_000 }),
    );
  });

  it('拒绝未知规则类型和没有停止条件的规则', () => {
    const value = createDefaultCampaignRuleSet();

    expect(() =>
      campaignRuleSetSchema.parse({
        ...value,
        hardRules: [{ id: 'unknown', kind: 'hard', type: 'guess-value' }],
      }),
    ).toThrow();
    expect(() => campaignRuleSetSchema.parse({ ...value, stopConditions: {} })).toThrow(
      '至少配置一个停止条件',
    );
  });

  it('接受合法的硬筛与人工规则组合', () => {
    const value = createDefaultCampaignRuleSet();
    expect(
      parseCampaignRuleSet({
        ...value,
        manualChecks: [
          {
            id: 'brand-safety',
            kind: 'manual',
            type: 'review-check',
            label: '品牌安全复核',
          },
        ],
      }),
    ).toEqual(expect.objectContaining({ schemaVersion: 2 }));
  });

  it('兼容旧 schema version 1 并剥离历史 AI 字段', () => {
    const legacy = {
      schemaVersion: 1,
      hardRules: [{ id: 'followers', kind: 'hard', type: 'follower-range', min: 0, max: 5_000 }],
      aiRules: [{ id: 'amateur-status', kind: 'ai', type: 'amateur-status' }],
      manualChecks: [],
      stopConditions: { maxFeedItems: 100 },
      pacing: { minimumDelayMs: 1_500, maximumDelayMs: 3_000 },
      aiLimits: { maximumCandidates: 30, concurrency: 1 },
    };

    const parsed = parseCampaignRuleSet(legacy);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed).not.toHaveProperty('aiRules');
    expect(parsed).not.toHaveProperty('aiLimits');
  });

  it('拒绝越界阈值、重复规则 ID 和未知人工类型', () => {
    const value = createDefaultCampaignRuleSet();
    expect(() =>
      parseCampaignRuleSet({
        ...value,
        hardRules: [
          {
            id: 'viral',
            kind: 'hard',
            type: 'recent-post-likes',
            windowDays: 366,
            minimumLikes: 1,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseCampaignRuleSet({
        ...value,
        manualChecks: [{ id: 'followers', kind: 'manual', type: 'review-check', label: '重复 ID' }],
      }),
    ).toThrow('规则 ID');
    expect(() =>
      parseCampaignRuleSet({
        ...value,
        manualChecks: [{ id: 'manual-x', kind: 'manual', type: 'unknown-check', label: '未知' }],
      }),
    ).toThrow();
  });

  it('对旧 schema version 给出明确的不兼容错误', () => {
    expect(() =>
      parseCampaignRuleSet({ ...createDefaultCampaignRuleSet(), schemaVersion: 0 }),
    ).toThrow(UnsupportedCampaignRuleSchemaVersionError);
  });
});

describe('Collector 协议契约', () => {
  const batch = {
    protocolVersion: COLLECTOR_PROTOCOL_VERSION,
    collectorVersion: '0.1.0',
    parserVersion: '0.1.0',
    deviceId: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    idempotencyKey: 'batch-20260915-0001',
    observations: [
      {
        observationId: '33333333-3333-4333-8333-333333333333',
        platform: 'douyin',
        platformCreatorId: 'creator-1',
        profileUrl: 'https://www.douyin.com/user/creator-1',
        nickname: '示例博主',
        biography: null,
        followerCount: 3_200,
        followerCountRaw: '3200',
        observedAt: '2026-09-15T05:00:00.000Z',
        posts: [],
        parserConfidence: 0.95,
      },
    ],
  };

  it('采集批次可以序列化并拒绝敏感额外字段', () => {
    expect(collectorBatchSchema.parse(JSON.parse(JSON.stringify(batch)))).toEqual(batch);
    expect(() => collectorBatchSchema.parse({ ...batch, cookie: 'must-not-upload' })).toThrow();
  });

  it('接受同一主版本并拒绝不兼容主版本', () => {
    expect(() => assertCollectorProtocolCompatible('1.8.0')).not.toThrow();
    expect(() => assertCollectorProtocolCompatible('2.0.0')).toThrow('不兼容');
    expect(() => assertCollectorProtocolCompatible('not-a-version')).toThrow('不兼容');
  });
});
