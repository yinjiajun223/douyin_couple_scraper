import { parseCampaignRuleSet } from '@douyin/contracts';
import type { CampaignRuleSet } from '@douyin/contracts';

type HardRule = CampaignRuleSet['hardRules'][number];
type ManualCheck = CampaignRuleSet['manualChecks'][number];
type StopConditions = CampaignRuleSet['stopConditions'];

export interface RuleFormValues {
  followerMax: number;
  followerMin: number;
  manualLabel: string;
  maxDurationMinutes: number | null;
  maxFeedItems: number | null;
  minimumLikes: number | null;
  targetCandidates: number | null;
  windowDays: number | null;
}

export interface RuleFieldDefaults {
  followerMax: string;
  followerMin: string;
  manualLabel: string;
  maxDurationMinutes: string;
  maxFeedItems: string;
  minimumLikes: string;
  targetCandidates: string;
  windowDays: string;
}

export function findViralRule(base: CampaignRuleSet | null) {
  return base?.hardRules.find((rule) => rule.type === 'recent-post-likes') ?? null;
}

export function findFollowerRule(base: CampaignRuleSet | null) {
  return base?.hardRules.find((rule) => rule.type === 'follower-range') ?? null;
}

// 编辑既有规则时，缺失的停止条件必须保持缺失：填一个默认值等于悄悄改变了这条任务的采集边界。
export function ruleFieldDefaults(base: CampaignRuleSet | null): RuleFieldDefaults {
  const follower = findFollowerRule(base);
  const viral = findViralRule(base);
  const stop = base?.stopConditions;
  const preserved = (value: number | undefined, fallback: number) =>
    base ? (value === undefined ? '' : String(value)) : String(fallback);
  return {
    followerMin: String(follower?.min ?? 0),
    followerMax: String(follower?.max ?? 5_000),
    windowDays: base ? String(viral?.windowDays ?? '') : '15',
    minimumLikes: base ? String(viral?.minimumLikes ?? '') : '10000',
    maxFeedItems: preserved(stop?.maxFeedItems, 100),
    maxDurationMinutes: preserved(stop?.maxDurationMinutes, 60),
    targetCandidates: preserved(stop?.targetCandidates, 30),
    manualLabel: base?.manualChecks[0]?.label ?? '',
  };
}

export function readRuleForm(form: FormData): RuleFormValues {
  const number = (name: string) => {
    const raw = String(form.get(name) ?? '').trim();
    return raw === '' ? null : Number(raw);
  };
  return {
    followerMin: number('followerMin') ?? Number.NaN,
    followerMax: number('followerMax') ?? Number.NaN,
    windowDays: number('windowDays'),
    minimumLikes: number('minimumLikes'),
    maxFeedItems: number('maxFeedItems'),
    maxDurationMinutes: number('maxDurationMinutes'),
    targetCandidates: number('targetCandidates'),
    manualLabel: String(form.get('manualLabel') ?? '').trim(),
  };
}

export function buildRuleSet(base: CampaignRuleSet | null, values: RuleFormValues) {
  if (!Number.isInteger(values.followerMin) || !Number.isInteger(values.followerMax)) return null;
  if (values.followerMax < values.followerMin) return null;

  const hardRules: HardRule[] = [];
  const follower = findFollowerRule(base);
  hardRules.push({
    id: follower?.id ?? 'followers',
    kind: 'hard',
    type: 'follower-range',
    min: values.followerMin,
    max: values.followerMax,
  });
  const viral = findViralRule(base);
  if (viral || !base) {
    if (values.windowDays === null || values.minimumLikes === null) return null;
    hardRules.push({
      id: viral?.id ?? 'recent-viral-post',
      kind: 'hard',
      type: 'recent-post-likes',
      windowDays: values.windowDays,
      minimumLikes: values.minimumLikes,
      minimumMatchingPosts: viral?.minimumMatchingPosts ?? 1,
    });
  }

  const extraManualChecks = base?.manualChecks.slice(1) ?? [];
  const manualChecks: ManualCheck[] =
    values.manualLabel === ''
      ? extraManualChecks
      : [
          {
            ...(base?.manualChecks[0] ?? {
              id: 'manual-review',
              kind: 'manual' as const,
              type: 'review-check' as const,
            }),
            label: values.manualLabel,
          },
          ...extraManualChecks,
        ];

  const stopConditions: StopConditions = { ...base?.stopConditions };
  applyStopCondition(stopConditions, 'maxFeedItems', values.maxFeedItems);
  applyStopCondition(stopConditions, 'maxDurationMinutes', values.maxDurationMinutes);
  applyStopCondition(stopConditions, 'targetCandidates', values.targetCandidates);
  if (Object.keys(stopConditions).length === 0) return null;

  try {
    return parseCampaignRuleSet({
      schemaVersion: 2 as const,
      hardRules,
      manualChecks,
      stopConditions,
      pacing: base?.pacing ?? { minimumDelayMs: 1_500, maximumDelayMs: 3_000 },
    } satisfies CampaignRuleSet);
  } catch {
    return null;
  }
}

function applyStopCondition(
  stopConditions: StopConditions,
  key: 'maxFeedItems' | 'maxDurationMinutes' | 'targetCandidates',
  value: number | null,
) {
  if (value === null) delete stopConditions[key];
  else stopConditions[key] = value;
}

export function describeRuleSet(rules: CampaignRuleSet | null | undefined) {
  if (!rules) return '规则不可用';
  const follower = findFollowerRule(rules);
  const viral = findViralRule(rules);
  const parts = [
    follower ? `粉丝 ${follower.min}–${follower.max}` : null,
    viral ? `爆款 ${viral.windowDays} 天 / ${viral.minimumLikes} 赞` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(' · ') : '未配置硬筛规则';
}
