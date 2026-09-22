import type { Pool, RowDataPacket } from 'mysql2/promise';

import { CollectionRunNotFoundError } from '../campaigns/run-service.js';
import type { PipelineStatus } from '../candidates/candidate-workflow.js';
import { evaluateHardFilters } from './hard-filter.js';
import type { HardFilterOutcome, HardFilterPostEvidence } from './hard-filter.js';

export interface ObservedCreatorRuleEvaluation {
  evidence: Record<string, unknown>;
  outcome: HardFilterOutcome;
  ruleId: string;
  ruleType: 'follower-range' | 'recent-post-likes';
}

export interface ObservedCreatorVerdict {
  admitted: boolean;
  candidateId: string | null;
  creatorId: string;
  evaluations: ObservedCreatorRuleEvaluation[];
  followerCount: number | null;
  followerCountRaw: string | null;
  nickname: string;
  observationId: string;
  observedAt: Date;
  outcome: HardFilterOutcome;
  pipelineStatus: PipelineStatus | null;
  platformCreatorId: string;
  profileUrl: string;
}

interface RunRuleRow extends RowDataPacket {
  campaign_id: string;
  rules_json: RunRules;
}

type RunRules = Parameters<typeof evaluateHardFilters>[0];

interface ObservationRow extends RowDataPacket {
  creator_id: string;
  follower_count: number | string | null;
  follower_count_raw: string | null;
  id: string;
  nickname: string;
  observed_at: Date;
  platform_creator_id: string;
  profile_url: string;
}

interface PostObservationRow extends RowDataPacket {
  canonical_post_url: string;
  creator_observation_id: string;
  id: string;
  like_count: number | string | null;
  like_count_raw: string | null;
  observed_at: Date;
  post_id: string;
  published_at: Date | null;
}

interface CandidateRow extends RowDataPacket {
  creator_id: string;
  id: string;
  pipeline_status: PipelineStatus;
}

const IN_CLAUSE_CHUNK = 500;

/**
 * 用一次运行留下的不可变采集事实与该运行的规则快照重算硬筛结论。
 * 未入库的达人没有候选行与规则评估行，这是他们唯一的判定依据来源。
 */
export async function listRunObservedCreators(
  pool: Pool,
  input: { runId: string; workspaceId: string },
): Promise<ObservedCreatorVerdict[]> {
  const [runRows] = await pool.query<RunRuleRow[]>(
    `SELECT runs.campaign_id, versions.rules_json
     FROM collection_runs runs
     JOIN campaign_rule_versions versions ON versions.id = runs.rule_version_id
     WHERE runs.workspace_id = ? AND runs.id = ?
     LIMIT 1`,
    [input.workspaceId, input.runId],
  );
  const run = runRows[0];
  if (!run) throw new CollectionRunNotFoundError();

  const [observationRows] = await pool.query<ObservationRow[]>(
    `SELECT observations.id, observations.creator_id, observations.nickname,
            observations.profile_url, observations.follower_count, observations.follower_count_raw,
            observations.observed_at, creators.platform_creator_id
     FROM creator_observations observations
     JOIN creators
       ON creators.workspace_id = observations.workspace_id
      AND creators.id = observations.creator_id
     WHERE observations.workspace_id = ? AND observations.run_id = ?
     ORDER BY observations.observed_at ASC, observations.received_at ASC`,
    [input.workspaceId, input.runId],
  );
  if (observationRows.length === 0) return [];

  // 同一达人可能在一次运行里被观察多次，结论以最新一条观测为准。
  const latestByCreator = new Map<string, ObservationRow>();
  for (const row of observationRows) latestByCreator.set(row.creator_id, row);
  const observations = [...latestByCreator.values()];

  const postsByObservation = await loadPostsByObservation(
    pool,
    input.workspaceId,
    observations.map((row) => row.id),
  );
  const candidatesByCreator = await loadCandidatesByCreator(
    pool,
    input.workspaceId,
    run.campaign_id,
    observations.map((row) => row.creator_id),
  );

  return observations.map((observation) => {
    // postsWindowComplete 没有持久化，按「窗口不完整」处理：采集器对每条观测都上报 false，
    // 旧数据导入没有作品数据，两者都对应同一个放宽结论。见 change design.md D2。
    const filter = evaluateHardFilters(run.rules_json, {
      creatorObservationId: observation.id,
      followerCount: toCount(observation.follower_count),
      followerCountRaw: observation.follower_count_raw,
      posts: postsByObservation.get(observation.id) ?? [],
      postsWindowComplete: false,
      evaluatedAt: observation.observed_at,
    });
    const candidate = candidatesByCreator.get(observation.creator_id);
    return {
      admitted: candidate !== undefined,
      candidateId: candidate?.id ?? null,
      creatorId: observation.creator_id,
      evaluations: filter.evaluations.map((evaluation) => ({
        evidence: evaluation.evidence,
        outcome: evaluation.outcome,
        ruleId: evaluation.ruleId,
        ruleType: evaluation.ruleType,
      })),
      followerCount: toCount(observation.follower_count),
      followerCountRaw: observation.follower_count_raw,
      nickname: observation.nickname,
      observationId: observation.id,
      observedAt: observation.observed_at,
      outcome: filter.outcome,
      pipelineStatus: candidate?.pipeline_status ?? null,
      platformCreatorId: observation.platform_creator_id,
      profileUrl: observation.profile_url,
    };
  });
}

async function loadPostsByObservation(
  pool: Pool,
  workspaceId: string,
  observationIds: string[],
): Promise<Map<string, HardFilterPostEvidence[]>> {
  const grouped = new Map<string, HardFilterPostEvidence[]>();
  for (const chunk of chunked(observationIds)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const [rows] = await pool.query<PostObservationRow[]>(
      `SELECT post_observations.id, post_observations.creator_observation_id,
              post_observations.post_id, post_observations.caption, post_observations.like_count,
              post_observations.like_count_raw, post_observations.published_at,
              post_observations.observed_at, posts.canonical_post_url
       FROM post_observations
       JOIN posts
         ON posts.workspace_id = post_observations.workspace_id
        AND posts.id = post_observations.post_id
       WHERE post_observations.workspace_id = ?
         AND post_observations.creator_observation_id IN (${placeholders})
       ORDER BY post_observations.observed_at ASC`,
      [workspaceId, ...chunk],
    );
    for (const row of rows) {
      const posts = grouped.get(row.creator_observation_id);
      const post: HardFilterPostEvidence = {
        postId: row.post_id,
        postObservationId: row.id,
        postUrl: row.canonical_post_url,
        likeCount: toCount(row.like_count),
        likeCountRaw: row.like_count_raw,
        publishedAt: row.published_at,
        observedAt: row.observed_at,
      };
      if (posts) posts.push(post);
      else grouped.set(row.creator_observation_id, [post]);
    }
  }
  return grouped;
}

async function loadCandidatesByCreator(
  pool: Pool,
  workspaceId: string,
  campaignId: string,
  creatorIds: string[],
): Promise<Map<string, CandidateRow>> {
  const grouped = new Map<string, CandidateRow>();
  for (const chunk of chunked(creatorIds)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const [rows] = await pool.query<CandidateRow[]>(
      `SELECT id, creator_id, pipeline_status
       FROM campaign_candidates
       WHERE workspace_id = ? AND campaign_id = ? AND creator_id IN (${placeholders})`,
      [workspaceId, campaignId, ...chunk],
    );
    for (const row of rows) grouped.set(row.creator_id, row);
  }
  return grouped;
}

function chunked(values: string[]): string[][] {
  const chunks: string[][] = [];
  for (let offset = 0; offset < values.length; offset += IN_CLAUSE_CHUNK) {
    chunks.push(values.slice(offset, offset + IN_CLAUSE_CHUNK));
  }
  return chunks;
}

function toCount(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}
