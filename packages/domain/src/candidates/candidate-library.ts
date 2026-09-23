import type { Pool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

import { parseCampaignRuleSet } from '@douyin/contracts';
import type { CampaignRuleSet } from '@douyin/contracts';

import {
  candidateVisibilityPredicate,
  firstVisibleAtExpression,
  resolveCandidateScope,
  visibleObservationIdExpression,
} from './candidate-access.js';
import type { CandidateAccessContext } from './candidate-access.js';

const pipelineStatusSchema = z.enum([
  'pending_review',
  'unsuitable',
  'to_contact',
  'contacted',
  'communicating',
  'partnered',
  'declined',
]);

const candidateFilterSchema = z
  .object({
    actorRole: z.enum(['admin', 'operator', 'readonly']),
    actorUserId: z.uuid(),
    workspaceId: z.uuid(),
    memberUserId: z.uuid().optional(),
    campaignId: z.uuid().optional(),
    archiveView: z.enum(['active', 'archived']).default('active'),
    cursor: z.string().trim().min(1).optional(),
    discoveredFrom: z.coerce.date().optional(),
    discoveredTo: z.coerce.date().optional(),
    observedFrom: z.coerce.date().optional(),
    observedTo: z.coerce.date().optional(),
    followerMin: z.number().int().nonnegative().optional(),
    followerMax: z.number().int().nonnegative().optional(),
    hardFilterStatus: z.enum(['pass', 'fail', 'unknown']).optional(),
    manualDecision: z.enum(['pending', 'approved', 'rejected']).optional(),
    pipelineStatus: pipelineStatusSchema.optional(),
    pipelineStatuses: z.array(pipelineStatusSchema).min(1).max(7).optional(),
    ownerUserId: z.uuid().optional(),
    tagNames: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict()
  .refine(
    (value) =>
      value.followerMin === undefined ||
      value.followerMax === undefined ||
      value.followerMax >= value.followerMin,
    { path: ['followerMax'], message: '粉丝上限必须大于或等于下限' },
  );

interface CandidateRow extends RowDataPacket {
  archived_at: Date | null;
  assignee_user_id: string | null;
  biography: string | null;
  campaign_id: string;
  campaign_name: string;
  creator_id: string;
  follower_count: number | string | null;
  first_visible_at: Date | string;
  hard_filter_status: 'pass' | 'fail' | 'unknown';
  id: string;
  latest_run_id: string;
  manual_decision: 'pending' | 'approved' | 'rejected';
  nickname: string;
  observed_at: Date;
  owner_user_id: string | null;
  pipeline_status:
    | 'pending_review'
    | 'unsuitable'
    | 'to_contact'
    | 'contacted'
    | 'communicating'
    | 'partnered'
    | 'declined';
  platform_creator_id: string;
  profile_url: string;
  version: number;
}

interface CandidateTagRow extends RowDataPacket {
  candidate_id: string;
  name: string;
}

interface CandidateDetailRow extends RowDataPacket {
  archived_at: Date | null;
  assignee_user_id: string | null;
  campaign_id: string;
  campaign_name: string;
  creator_id: string;
  hard_filter_status: 'pass' | 'fail' | 'unknown';
  id: string;
  latest_creator_observation_id: string;
  pipeline_status: CandidateRow['pipeline_status'];
  platform_creator_id: string;
  owner_user_id: string | null;
  version: number;
}

interface ObservationRow extends RowDataPacket {
  biography: string | null;
  collector_version: string;
  device_id: string;
  device_name: string;
  follower_count: number | string | null;
  follower_count_raw: string | null;
  id: string;
  nickname: string;
  observed_at: Date;
  parser_confidence: number | string;
  parser_version: string;
  profile_url: string;
  run_id: string;
}

interface SourceRow extends RowDataPacket {
  campaign_id: string;
  campaign_name: string;
  device_id: string;
  device_name: string;
  first_observed_at: Date;
  last_observed_at: Date;
  observation_count: number;
  run_id: string;
}

interface EvaluationRow extends RowDataPacket {
  creator_observation_id: string;
  evaluated_at: Date;
  evidence_json: Record<string, unknown>;
  id: string;
  matched_like_count: number | string | null;
  matched_like_count_raw: string | null;
  matched_post_observation_id: string | null;
  matched_post_url: string | null;
  matched_published_at: Date | null;
  outcome: 'pass' | 'fail' | 'unknown';
  rule_category: 'hard' | 'ai' | 'manual';
  rule_key: string;
  rule_version: number;
  rule_version_id: string;
  rules_json: CampaignRuleSet;
  run_id: string;
}

interface CandidateMediaRow extends RowDataPacket {
  created_at: Date;
  id: string;
  mime_type: string;
  purpose: 'profile_screenshot' | 'post_screenshot';
}

export interface CandidateListItem {
  id: string;
  campaignId: string;
  campaignName: string;
  creatorId: string;
  platformCreatorId: string;
  nickname: string;
  biography: string | null;
  profileUrl: string;
  followerCount: number | null;
  firstVisibleAt: Date;
  observedAt: Date;
  archivedAt: Date | null;
  latestRunId: string;
  hardFilterStatus: 'pass' | 'fail' | 'unknown';
  manualDecision: 'pending' | 'approved' | 'rejected';
  pipelineStatus: CandidateRow['pipeline_status'];
  ownerUserId: string | null;
  assigneeUserId: string | null;
  tags: string[];
  version: number;
}

export interface CandidatePage {
  candidates: CandidateListItem[];
  nextCursor: string | null;
}

export interface CandidateDetail {
  candidate: {
    id: string;
    campaignId: string;
    campaignName: string;
    creatorId: string;
    platformCreatorId: string;
    hardFilterStatus: 'pass' | 'fail' | 'unknown';
    pipelineStatus: CandidateRow['pipeline_status'];
    assigneeUserId: string | null;
    archivedAt: Date | null;
    // 标签编辑面板需要当前真实标签：列表里的副本可能是别人改标签之前的。
    tags: string[];
    version: number;
  };
  observations: Array<{
    id: string;
    runId: string;
    device: { id: string; name: string };
    nickname: string;
    biography: string | null;
    profileUrl: string;
    followerCount: number | null;
    followerCountRaw: string | null;
    parserConfidence: number;
    collectorVersion: string;
    parserVersion: string;
    observedAt: Date;
  }>;
  sources: Array<{
    runId: string;
    campaignId: string;
    campaignName: string;
    device: { id: string; name: string };
    firstObservedAt: Date;
    lastObservedAt: Date;
    observationCount: number;
  }>;
  evaluations: Array<{
    id: string;
    runId: string;
    ruleVersionId: string;
    ruleVersion: number;
    ruleSnapshot: CampaignRuleSet;
    creatorObservationId: string;
    ruleKey: string;
    ruleCategory: 'hard' | 'ai' | 'manual';
    outcome: 'pass' | 'fail' | 'unknown';
    evidence: Record<string, unknown>;
    matchedPost: {
      observationId: string;
      url: string;
      likeCount: number | null;
      likeCountRaw: string | null;
      publishedAt: Date | null;
    } | null;
    evaluatedAt: Date;
  }>;
  media: Array<{
    createdAt: Date;
    id: string;
    mimeType: string;
    purpose: 'profile_screenshot' | 'post_screenshot';
  }>;
}

export class CandidateNotFoundError extends Error {
  constructor() {
    super('找不到候选达人');
    this.name = 'CandidateNotFoundError';
  }
}

export async function listCandidatePage(pool: Pool, rawFilters: unknown): Promise<CandidatePage> {
  const filters = candidateFilterSchema.parse(rawFilters);
  const scope = resolveCandidateScope(filters as CandidateAccessContext);
  const visibility = candidateVisibilityPredicate('candidates', scope.targetUserId);
  const firstVisibleAt = firstVisibleAtExpression('candidates', scope.targetUserId);
  const visibleObservationId = visibleObservationIdExpression('candidates', scope.targetUserId);
  const predicates = ['candidates.workspace_id = ?', visibility.sql];
  // 与 operations-dashboard.ts:37,42,48 的既有过滤同口径：默认列表不含已归档候选；
  // 「已归档」视图复用同一查询，只把这一条谓词反过来。
  predicates.push(
    filters.archiveView === 'archived'
      ? 'candidates.archived_at IS NOT NULL'
      : 'candidates.archived_at IS NULL',
  );
  const parameters: Array<string | number | Date> = [
    ...firstVisibleAt.parameters,
    ...visibleObservationId.parameters,
    filters.workspaceId,
    ...visibility.parameters,
  ];
  if (filters.campaignId) {
    predicates.push('candidates.campaign_id = ?');
    parameters.push(filters.campaignId);
  }
  if (filters.observedFrom) {
    predicates.push('observations.observed_at >= ?');
    parameters.push(filters.observedFrom);
  }
  if (filters.observedTo) {
    predicates.push('observations.observed_at <= ?');
    parameters.push(filters.observedTo);
  }
  if (filters.discoveredFrom) {
    predicates.push(`${firstVisibleAt.sql} >= ?`);
    parameters.push(...firstVisibleAt.parameters, filters.discoveredFrom);
  }
  if (filters.discoveredTo) {
    predicates.push(`${firstVisibleAt.sql} < ?`);
    parameters.push(...firstVisibleAt.parameters, filters.discoveredTo);
  }
  if (filters.followerMin !== undefined) {
    predicates.push('observations.follower_count >= ?');
    parameters.push(filters.followerMin);
  }
  if (filters.followerMax !== undefined) {
    predicates.push('observations.follower_count <= ?');
    parameters.push(filters.followerMax);
  }
  if (filters.hardFilterStatus) {
    predicates.push('candidates.hard_filter_status = ?');
    parameters.push(filters.hardFilterStatus);
  } else {
    // hard_filter_status 记录的是「创建时的入库资格」，晋级后不再随后续运行改写。
    // 默认只放行取得资格的行，与 operations-dashboard 的三个计数器保持同一口径；
    // 闸门上线前留下的存量 fail / unknown 行只能靠显式 hardFilterStatus 检索。
    predicates.push("candidates.hard_filter_status = 'pass'");
  }
  if (filters.manualDecision) {
    predicates.push("COALESCE(manual.decision, 'pending') = ?");
    parameters.push(filters.manualDecision);
  }
  if (filters.pipelineStatus) {
    predicates.push('candidates.pipeline_status = ?');
    parameters.push(filters.pipelineStatus);
  }
  const pipelineStatuses = [...new Set(filters.pipelineStatuses ?? [])];
  if (pipelineStatuses.length > 0) {
    // 达人库分区把 7 个阶段收成 5 组（跟进中 = contacted + communicating，
    // 不合适 = unsuitable + declined），分组必须在服务端过滤，
    // 否则「加载更多」会在整页里筛出寥寥几条，分页既不连续也对不上分区计数。
    predicates.push(
      `candidates.pipeline_status IN (${pipelineStatuses.map(() => '?').join(', ')})`,
    );
    parameters.push(...pipelineStatuses);
  }
  if (filters.ownerUserId) {
    predicates.push('COALESCE(outreach.owner_user_id, candidates.assignee_user_id) = ?');
    parameters.push(filters.ownerUserId);
  }
  const tagNames = [...new Set(filters.tagNames ?? [])];
  if (tagNames.length > 0) {
    predicates.push(
      `candidates.id IN (
         SELECT candidate_tags.candidate_id
         FROM candidate_tags
         JOIN tags ON tags.id = candidate_tags.tag_id
         WHERE candidate_tags.workspace_id = ? AND tags.name IN (${tagNames.map(() => '?').join(', ')})
         GROUP BY candidate_tags.candidate_id
         HAVING COUNT(DISTINCT tags.name) = ?
       )`,
    );
    parameters.push(filters.workspaceId, ...tagNames, tagNames.length);
  }
  if (filters.cursor) {
    const cursor = decodeCandidateCursor(filters.cursor);
    predicates.push(
      `(${firstVisibleAt.sql} < ? OR (${firstVisibleAt.sql} = ? AND candidates.id < ?))`,
    );
    parameters.push(
      ...firstVisibleAt.parameters,
      cursor.firstVisibleAt,
      ...firstVisibleAt.parameters,
      cursor.firstVisibleAt,
      cursor.id,
    );
  }
  parameters.push(filters.limit + 1);

  const [rows] = await pool.query<CandidateRow[]>(
    `SELECT candidates.id, candidates.campaign_id, campaigns.name AS campaign_name,
            candidates.creator_id, creators.platform_creator_id, observations.nickname,
            observations.biography, observations.profile_url, observations.follower_count,
            observations.observed_at, ${firstVisibleAt.sql} AS first_visible_at,
            candidates.archived_at, candidates.latest_run_id,
            candidates.hard_filter_status, COALESCE(manual.decision, 'pending') AS manual_decision,
            candidates.pipeline_status, outreach.owner_user_id, candidates.assignee_user_id,
            candidates.version
     FROM campaign_candidates candidates
     JOIN campaigns ON campaigns.id = candidates.campaign_id
     JOIN creators ON creators.id = candidates.creator_id
     JOIN creator_observations observations ON observations.id = ${visibleObservationId.sql}
     LEFT JOIN outreach_records outreach ON outreach.candidate_id = candidates.id
     LEFT JOIN manual_reviews manual ON manual.id = (
       SELECT latest_manual.id FROM manual_reviews latest_manual
       WHERE latest_manual.candidate_id = candidates.id
       ORDER BY latest_manual.created_at DESC, latest_manual.id DESC LIMIT 1
     )
     WHERE ${predicates.join(' AND ')}
     ORDER BY first_visible_at DESC, candidates.id DESC
     LIMIT ?`,
    parameters,
  );
  const hasNextPage = rows.length > filters.limit;
  const pageRows = rows.slice(0, filters.limit);
  if (pageRows.length === 0) return { candidates: [], nextCursor: null };

  const candidateIds = pageRows.map((row) => row.id);
  const [tagRows] = await pool.query<CandidateTagRow[]>(
    `SELECT candidate_tags.candidate_id, tags.name
     FROM candidate_tags
     JOIN tags ON tags.id = candidate_tags.tag_id
     WHERE candidate_tags.candidate_id IN (${candidateIds.map(() => '?').join(', ')})
     ORDER BY tags.name`,
    candidateIds,
  );
  const tagsByCandidate = new Map<string, string[]>();
  for (const tag of tagRows) {
    const names = tagsByCandidate.get(tag.candidate_id) ?? [];
    names.push(tag.name);
    tagsByCandidate.set(tag.candidate_id, names);
  }

  const candidates = pageRows.map((row) => ({
    id: row.id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    creatorId: row.creator_id,
    platformCreatorId: row.platform_creator_id,
    nickname: row.nickname,
    biography: row.biography,
    profileUrl: row.profile_url,
    followerCount: row.follower_count === null ? null : Number(row.follower_count),
    firstVisibleAt: new Date(row.first_visible_at),
    observedAt: row.observed_at,
    archivedAt: row.archived_at,
    latestRunId: row.latest_run_id,
    hardFilterStatus: row.hard_filter_status,
    manualDecision: row.manual_decision,
    pipelineStatus: row.pipeline_status,
    ownerUserId: row.owner_user_id,
    assigneeUserId: row.assignee_user_id,
    tags: tagsByCandidate.get(row.id) ?? [],
    version: row.version,
  }));
  const last = pageRows.at(-1)!;
  return {
    candidates,
    nextCursor: hasNextPage
      ? encodeCandidateCursor({ firstVisibleAt: new Date(last.first_visible_at), id: last.id })
      : null,
  };
}

export async function listCandidates(
  pool: Pool,
  rawFilters: unknown,
): Promise<CandidateListItem[]> {
  return (await listCandidatePage(pool, rawFilters)).candidates;
}

export async function getCandidateDetail(
  pool: Pool,
  access: CandidateAccessContext,
  candidateId: string,
): Promise<CandidateDetail> {
  const scope = resolveCandidateScope(access);
  const visibility = candidateVisibilityPredicate('candidates', scope.targetUserId);
  const [candidateRows] = await pool.query<CandidateDetailRow[]>(
    `SELECT candidates.id, candidates.campaign_id, campaigns.name AS campaign_name,
            candidates.creator_id, creators.platform_creator_id,
            candidates.hard_filter_status, candidates.pipeline_status,
            candidates.assignee_user_id, outreach.owner_user_id,
            candidates.archived_at, candidates.latest_creator_observation_id, candidates.version
     FROM campaign_candidates candidates
     JOIN campaigns ON campaigns.id = candidates.campaign_id
     JOIN creators ON creators.id = candidates.creator_id
     LEFT JOIN outreach_records outreach ON outreach.candidate_id = candidates.id
     WHERE candidates.workspace_id = ? AND candidates.id = ? AND ${visibility.sql}
     LIMIT 1`,
    [access.workspaceId, candidateId, ...visibility.parameters],
  );
  const candidate = candidateRows[0];
  if (!candidate) throw new CandidateNotFoundError();

  const [tagRows] = await pool.query<CandidateTagRow[]>(
    `SELECT candidate_tags.candidate_id, tags.name
     FROM candidate_tags
     JOIN tags ON tags.id = candidate_tags.tag_id
     WHERE candidate_tags.candidate_id = ?
     ORDER BY tags.name`,
    [candidateId],
  );

  const assignedToViewer = Boolean(
    scope.targetUserId &&
    (candidate.assignee_user_id === scope.targetUserId ||
      candidate.owner_user_id === scope.targetUserId),
  );
  const observationScope = scope.targetUserId
    ? `AND (devices.owner_user_id = ?${assignedToViewer ? ' OR observations.id = ?' : ''})`
    : '';
  const observationParameters: string[] = scope.targetUserId
    ? [scope.targetUserId, ...(assignedToViewer ? [candidate.latest_creator_observation_id] : [])]
    : [];
  const [observations] = await pool.query<ObservationRow[]>(
    `SELECT observations.id, observations.run_id, observations.device_id,
            devices.name AS device_name, observations.nickname, observations.biography,
            observations.profile_url, observations.follower_count,
            observations.follower_count_raw, observations.parser_confidence,
            observations.collector_version, observations.parser_version,
            observations.observed_at
     FROM creator_observations observations
     JOIN devices ON devices.id = observations.device_id
     WHERE observations.workspace_id = ? AND observations.creator_id = ? ${observationScope}
     ORDER BY observations.observed_at DESC, observations.id DESC`,
    [access.workspaceId, candidate.creator_id, ...observationParameters],
  );
  const sourceScope = scope.targetUserId ? 'AND devices.owner_user_id = ?' : '';
  const [sources] = await pool.query<SourceRow[]>(
    `SELECT sources.run_id, runs.campaign_id, campaigns.name AS campaign_name,
            sources.device_id, devices.name AS device_name, sources.first_observed_at,
            sources.last_observed_at, sources.observation_count
     FROM run_creator_sources sources
     JOIN collection_runs runs ON runs.id = sources.run_id
     JOIN campaigns ON campaigns.id = runs.campaign_id
     JOIN devices ON devices.id = sources.device_id
     WHERE sources.workspace_id = ? AND sources.creator_id = ? ${sourceScope}
     ORDER BY sources.last_observed_at DESC`,
    [access.workspaceId, candidate.creator_id, ...(scope.targetUserId ? [scope.targetUserId] : [])],
  );
  const evaluationScope = scope.targetUserId
    ? `AND (evaluation_devices.owner_user_id = ?${assignedToViewer ? ' OR evaluations.creator_observation_id = ?' : ''})`
    : '';
  const [evaluations] = await pool.query<EvaluationRow[]>(
    `SELECT evaluations.id, evaluations.run_id, evaluations.rule_version_id,
            versions.version AS rule_version, versions.rules_json,
            evaluations.creator_observation_id, evaluations.rule_key,
            evaluations.rule_category, evaluations.outcome, evaluations.evidence_json,
            evaluations.matched_post_observation_id,
            posts.canonical_post_url AS matched_post_url,
            post_observations.like_count AS matched_like_count,
            post_observations.like_count_raw AS matched_like_count_raw,
            post_observations.published_at AS matched_published_at,
            evaluations.evaluated_at
     FROM rule_evaluations evaluations
     JOIN campaign_rule_versions versions ON versions.id = evaluations.rule_version_id
     JOIN creator_observations evaluation_observations
       ON evaluation_observations.id = evaluations.creator_observation_id
     JOIN devices evaluation_devices ON evaluation_devices.id = evaluation_observations.device_id
     LEFT JOIN post_observations ON post_observations.id = evaluations.matched_post_observation_id
     LEFT JOIN posts ON posts.id = post_observations.post_id
     WHERE evaluations.workspace_id = ? AND evaluations.candidate_id = ? ${evaluationScope}
     ORDER BY evaluations.evaluated_at DESC, evaluations.id DESC`,
    [
      access.workspaceId,
      candidateId,
      ...(scope.targetUserId
        ? [
            scope.targetUserId,
            ...(assignedToViewer ? [candidate.latest_creator_observation_id] : []),
          ]
        : []),
    ],
  );
  const mediaScope = scope.targetUserId
    ? `AND (
        creator_media_devices.owner_user_id = ? OR post_media_devices.owner_user_id = ?
        ${
          assignedToViewer ? 'OR creator_media.id = ? OR post_media.creator_observation_id = ?' : ''
        }
      )`
    : '';
  const [media] = await pool.query<CandidateMediaRow[]>(
    `SELECT DISTINCT media.id, media.purpose, media.mime_type, media.created_at
     FROM media_objects media
     LEFT JOIN creator_observations creator_media
       ON creator_media.id = media.creator_observation_id
     LEFT JOIN devices creator_media_devices ON creator_media_devices.id = creator_media.device_id
     LEFT JOIN post_observations post_media ON post_media.id = media.post_observation_id
     LEFT JOIN devices post_media_devices ON post_media_devices.id = post_media.device_id
     LEFT JOIN posts ON posts.id = post_media.post_id
     WHERE media.workspace_id = ? AND media.status = 'confirmed'
       AND media.purpose IN ('profile_screenshot', 'post_screenshot')
       AND (creator_media.creator_id = ? OR posts.creator_id = ?)
       ${mediaScope}
     ORDER BY media.created_at DESC, media.id DESC`,
    [
      access.workspaceId,
      candidate.creator_id,
      candidate.creator_id,
      ...(scope.targetUserId
        ? [
            scope.targetUserId,
            scope.targetUserId,
            ...(assignedToViewer
              ? [candidate.latest_creator_observation_id, candidate.latest_creator_observation_id]
              : []),
          ]
        : []),
    ],
  );

  return {
    candidate: {
      id: candidate.id,
      campaignId: candidate.campaign_id,
      campaignName: candidate.campaign_name,
      creatorId: candidate.creator_id,
      platformCreatorId: candidate.platform_creator_id,
      hardFilterStatus: candidate.hard_filter_status,
      pipelineStatus: candidate.pipeline_status,
      assigneeUserId: candidate.assignee_user_id,
      archivedAt: candidate.archived_at,
      tags: tagRows.map((tag) => tag.name),
      version: candidate.version,
    },
    observations: observations.map((observation) => ({
      id: observation.id,
      runId: observation.run_id,
      device: { id: observation.device_id, name: observation.device_name },
      nickname: observation.nickname,
      biography: observation.biography,
      profileUrl: observation.profile_url,
      followerCount:
        observation.follower_count === null ? null : Number(observation.follower_count),
      followerCountRaw: observation.follower_count_raw,
      parserConfidence: Number(observation.parser_confidence),
      collectorVersion: observation.collector_version,
      parserVersion: observation.parser_version,
      observedAt: observation.observed_at,
    })),
    sources: sources.map((source) => ({
      runId: source.run_id,
      campaignId: source.campaign_id,
      campaignName: source.campaign_name,
      device: { id: source.device_id, name: source.device_name },
      firstObservedAt: source.first_observed_at,
      lastObservedAt: source.last_observed_at,
      observationCount: source.observation_count,
    })),
    evaluations: evaluations.map((evaluation) => ({
      id: evaluation.id,
      runId: evaluation.run_id,
      ruleVersionId: evaluation.rule_version_id,
      ruleVersion: evaluation.rule_version,
      ruleSnapshot: parseCampaignRuleSet(evaluation.rules_json),
      creatorObservationId: evaluation.creator_observation_id,
      ruleKey: evaluation.rule_key,
      ruleCategory: evaluation.rule_category,
      outcome: evaluation.outcome,
      evidence: evaluation.evidence_json,
      matchedPost:
        evaluation.matched_post_observation_id && evaluation.matched_post_url
          ? {
              observationId: evaluation.matched_post_observation_id,
              url: evaluation.matched_post_url,
              likeCount:
                evaluation.matched_like_count === null
                  ? null
                  : Number(evaluation.matched_like_count),
              likeCountRaw: evaluation.matched_like_count_raw,
              publishedAt: evaluation.matched_published_at,
            }
          : null,
      evaluatedAt: evaluation.evaluated_at,
    })),
    media: media.map((item) => ({
      createdAt: item.created_at,
      id: item.id,
      mimeType: item.mime_type,
      purpose: item.purpose,
    })),
  };
}

function encodeCandidateCursor(input: { firstVisibleAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ firstVisibleAt: input.firstVisibleAt.toISOString(), id: input.id }),
    'utf8',
  ).toString('base64url');
}

function decodeCandidateCursor(value: string): { firstVisibleAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      firstVisibleAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.firstVisibleAt !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('invalid cursor');
    }
    const firstVisibleAt = new Date(parsed.firstVisibleAt);
    if (Number.isNaN(firstVisibleAt.getTime())) throw new Error('invalid cursor');
    return { firstVisibleAt, id: z.uuid().parse(parsed.id) };
  } catch {
    throw new z.ZodError([{ code: 'custom', message: '无效的分页游标', path: ['cursor'] }]);
  }
}
