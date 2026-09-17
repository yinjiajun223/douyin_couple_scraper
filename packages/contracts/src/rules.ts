import { z } from 'zod';

export const CAMPAIGN_RULE_SCHEMA_VERSION = 1 as const;

const followerRangeRuleSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('hard'),
    type: z.literal('follower-range'),
    min: z.number().int().nonnegative().max(1_000_000_000),
    max: z.number().int().nonnegative().max(1_000_000_000),
  })
  .strict()
  .refine((value) => value.max >= value.min, {
    message: '粉丝上限必须大于或等于下限',
    path: ['max'],
  });

const recentPostLikesRuleSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('hard'),
    type: z.literal('recent-post-likes'),
    windowDays: z.number().int().min(1).max(365),
    minimumLikes: z.number().int().nonnegative().max(100_000_000_000),
    minimumMatchingPosts: z.number().int().min(1).max(100).default(1),
  })
  .strict();

const ageBandRuleSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('ai'),
    type: z.literal('estimated-age-band'),
    minAge: z.number().int().min(13).max(100),
    maxAge: z.number().int().min(13).max(100),
  })
  .strict()
  .refine((value) => value.maxAge >= value.minAge, {
    message: '年龄上限必须大于或等于下限',
    path: ['maxAge'],
  });

const amateurStatusRuleSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('ai'),
    type: z.literal('amateur-status'),
  })
  .strict();

const contentFitRuleSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('ai'),
    type: z.literal('content-fit'),
    prompt: z.string().min(1).max(1_000),
  })
  .strict();

const manualCheckSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('manual'),
    type: z.literal('review-check'),
    label: z.string().min(1).max(100),
    instructions: z.string().max(1_000).optional(),
  })
  .strict();

const stopConditionsSchema = z
  .object({
    maxFeedItems: z.number().int().min(1).max(10_000).optional(),
    maxCreatorProfiles: z.number().int().min(1).max(2_000).optional(),
    maxDurationMinutes: z.number().int().min(1).max(1_440).optional(),
    targetCandidates: z.number().int().min(1).max(2_000).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: '至少配置一个停止条件',
  });

export const campaignRuleSetSchema = z
  .object({
    schemaVersion: z.literal(CAMPAIGN_RULE_SCHEMA_VERSION),
    hardRules: z.array(z.union([followerRangeRuleSchema, recentPostLikesRuleSchema])).min(1),
    aiRules: z.array(z.union([ageBandRuleSchema, amateurStatusRuleSchema, contentFitRuleSchema])),
    manualChecks: z.array(manualCheckSchema),
    stopConditions: stopConditionsSchema,
    pacing: z
      .object({
        minimumDelayMs: z.number().int().min(500).max(60_000),
        maximumDelayMs: z.number().int().min(500).max(120_000),
      })
      .strict()
      .refine((value) => value.maximumDelayMs >= value.minimumDelayMs, {
        message: '最大访问间隔必须大于或等于最小访问间隔',
        path: ['maximumDelayMs'],
      }),
    aiLimits: z
      .object({
        maximumCandidates: z.number().int().nonnegative(),
        concurrency: z.number().int().min(1).max(8),
        budgetCents: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const identifiers = [...value.hardRules, ...value.aiRules, ...value.manualChecks].map(
      (rule) => rule.id,
    );
    if (new Set(identifiers).size !== identifiers.length) {
      context.addIssue({
        code: 'custom',
        path: ['hardRules'],
        message: '规则 ID 在同一规则集中必须唯一',
      });
    }
  });

export type CampaignRuleSet = z.infer<typeof campaignRuleSetSchema>;

export class UnsupportedCampaignRuleSchemaVersionError extends Error {
  constructor(readonly receivedVersion: unknown) {
    super(`不支持的筛选规则 schema version：${String(receivedVersion)}`);
    this.name = 'UnsupportedCampaignRuleSchemaVersionError';
  }
}

export function parseCampaignRuleSet(value: unknown): CampaignRuleSet {
  const receivedVersion =
    value && typeof value === 'object' && 'schemaVersion' in value
      ? (value as { schemaVersion: unknown }).schemaVersion
      : undefined;
  if (receivedVersion !== CAMPAIGN_RULE_SCHEMA_VERSION) {
    throw new UnsupportedCampaignRuleSchemaVersionError(receivedVersion);
  }
  return campaignRuleSetSchema.parse(value);
}

export function createDefaultCampaignRuleSet(): CampaignRuleSet {
  return {
    schemaVersion: CAMPAIGN_RULE_SCHEMA_VERSION,
    hardRules: [
      {
        id: 'followers',
        kind: 'hard',
        type: 'follower-range',
        min: 0,
        max: 5_000,
      },
      {
        id: 'recent-viral-post',
        kind: 'hard',
        type: 'recent-post-likes',
        windowDays: 15,
        minimumLikes: 10_000,
        minimumMatchingPosts: 1,
      },
    ],
    aiRules: [
      {
        id: 'estimated-age',
        kind: 'ai',
        type: 'estimated-age-band',
        minAge: 18,
        maxAge: 24,
      },
      {
        id: 'amateur-status',
        kind: 'ai',
        type: 'amateur-status',
      },
    ],
    manualChecks: [],
    stopConditions: {
      maxFeedItems: 100,
      maxCreatorProfiles: 50,
      maxDurationMinutes: 60,
    },
    pacing: {
      minimumDelayMs: 1_500,
      maximumDelayMs: 3_000,
    },
    aiLimits: {
      maximumCandidates: 30,
      concurrency: 1,
    },
  };
}
