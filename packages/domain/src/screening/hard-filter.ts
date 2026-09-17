import { parseCampaignRuleSet } from '@douyin/contracts';
import type { CampaignRuleSet } from '@douyin/contracts';

export type HardFilterOutcome = 'pass' | 'fail' | 'unknown';

export interface HardFilterPostEvidence {
  postId: string;
  postObservationId: string;
  postUrl: string;
  likeCount: number | null;
  likeCountRaw: string | null;
  publishedAt: Date | string | null;
  observedAt: Date | string;
}

export interface HardFilterInput {
  creatorObservationId: string;
  followerCount: number | null;
  followerCountRaw: string | null;
  posts: HardFilterPostEvidence[];
  postsWindowComplete?: boolean;
  evaluatedAt: Date | string;
}

export interface HardFilterEvidenceReference {
  kind: 'creator-observation' | 'post-observation';
  id: string;
}

export interface HardRuleEvaluation {
  ruleId: string;
  ruleType: 'follower-range' | 'recent-post-likes';
  outcome: HardFilterOutcome;
  evidenceReferences: HardFilterEvidenceReference[];
  evidence: Record<string, unknown>;
}

export interface HardFilterResult {
  outcome: HardFilterOutcome;
  evaluations: HardRuleEvaluation[];
}

export function evaluateHardFilters(
  rawRules: CampaignRuleSet,
  input: HardFilterInput,
): HardFilterResult {
  const rules = parseCampaignRuleSet(rawRules);
  const evaluatedAt = toValidDate(input.evaluatedAt, '筛选时间');
  const evaluations = rules.hardRules.map((rule): HardRuleEvaluation => {
    if (rule.type === 'follower-range') {
      if (input.followerCount === null) {
        return {
          ruleId: rule.id,
          ruleType: rule.type,
          outcome: 'unknown',
          evidenceReferences: [{ kind: 'creator-observation', id: input.creatorObservationId }],
          evidence: {
            reason: 'missing_follower_count',
            observedRawValue: input.followerCountRaw,
            minimum: rule.min,
            maximum: rule.max,
          },
        };
      }
      const passed = input.followerCount >= rule.min && input.followerCount <= rule.max;
      return {
        ruleId: rule.id,
        ruleType: rule.type,
        outcome: passed ? 'pass' : 'fail',
        evidenceReferences: [{ kind: 'creator-observation', id: input.creatorObservationId }],
        evidence: {
          observedValue: input.followerCount,
          observedRawValue: input.followerCountRaw,
          minimum: rule.min,
          maximum: rule.max,
        },
      };
    }

    const windowStart = new Date(evaluatedAt.getTime() - rule.windowDays * 86_400_000);
    const matchingPosts: HardFilterPostEvidence[] = [];
    const uncertainPosts: HardFilterPostEvidence[] = [];
    for (const post of input.posts) {
      if (post.publishedAt === null) {
        uncertainPosts.push(post);
        continue;
      }
      const publishedAt = toValidDate(post.publishedAt, '作品发布时间');
      const inWindow = publishedAt >= windowStart && publishedAt <= evaluatedAt;
      if (!inWindow) continue;
      if (post.likeCount === null) {
        uncertainPosts.push(post);
        continue;
      }
      if (inWindow && post.likeCount >= rule.minimumLikes) matchingPosts.push(post);
    }
    const passed = matchingPosts.length >= rule.minimumMatchingPosts;
    const outcome: HardFilterOutcome = passed
      ? 'pass'
      : uncertainPosts.length > 0 || input.postsWindowComplete === false
        ? 'unknown'
        : 'fail';
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      outcome,
      evidenceReferences: [
        ...matchingPosts.map((post) => ({
          kind: 'post-observation' as const,
          id: post.postObservationId,
        })),
        ...(!passed
          ? uncertainPosts.map((post) => ({
              kind: 'post-observation' as const,
              id: post.postObservationId,
            }))
          : []),
      ],
      evidence: {
        postsWindowComplete: input.postsWindowComplete !== false,
        windowStart: windowStart.toISOString(),
        windowEnd: evaluatedAt.toISOString(),
        minimumLikes: rule.minimumLikes,
        minimumMatchingPosts: rule.minimumMatchingPosts,
        matchedPosts: matchingPosts.map(toPostEvidence),
        unknownPosts: passed ? [] : uncertainPosts.map(toPostEvidence),
      },
    };
  });

  return {
    outcome: combineOutcomes(evaluations.map((evaluation) => evaluation.outcome)),
    evaluations,
  };
}

function combineOutcomes(outcomes: HardFilterOutcome[]): HardFilterOutcome {
  if (outcomes.includes('fail')) return 'fail';
  if (outcomes.includes('unknown')) return 'unknown';
  return 'pass';
}

function toPostEvidence(post: HardFilterPostEvidence) {
  return {
    postId: post.postId,
    postObservationId: post.postObservationId,
    postUrl: post.postUrl,
    likeCount: post.likeCount,
    likeCountRaw: post.likeCountRaw,
    publishedAt:
      post.publishedAt === null
        ? null
        : toValidDate(post.publishedAt, '作品发布时间').toISOString(),
    observedAt: toValidDate(post.observedAt, '作品观察时间').toISOString(),
  };
}

function toValidDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`${label}格式不正确`);
  return date;
}
