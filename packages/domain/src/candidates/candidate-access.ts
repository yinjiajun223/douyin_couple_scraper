import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

import type { WorkspaceRole } from '../auth/permissions.js';

export interface CandidateAccessContext {
  actorRole: WorkspaceRole;
  actorUserId: string;
  memberUserId?: string;
  workspaceId: string;
}

export interface CandidateScope {
  targetUserId: string | null;
}

export class CandidateAccessDeniedError extends Error {
  public constructor() {
    super('找不到候选达人');
    this.name = 'CandidateAccessDeniedError';
  }
}

export function resolveCandidateScope(access: CandidateAccessContext): CandidateScope {
  return {
    targetUserId: access.actorRole === 'admin' ? (access.memberUserId ?? null) : access.actorUserId,
  };
}

export function candidateVisibilityPredicate(
  candidateAlias: string,
  targetUserId: string | null,
): { parameters: string[]; sql: string } {
  if (!targetUserId) return { parameters: [], sql: '1 = 1' };
  return {
    parameters: [targetUserId, targetUserId, targetUserId],
    sql: `(
      ${candidateAlias}.assignee_user_id = ?
      OR EXISTS (
        SELECT 1 FROM outreach_records access_outreach
        WHERE access_outreach.workspace_id = ${candidateAlias}.workspace_id
          AND access_outreach.candidate_id = ${candidateAlias}.id
          AND access_outreach.owner_user_id = ?
      )
      OR EXISTS (
        SELECT 1 FROM run_creator_sources access_sources
        JOIN devices access_devices ON access_devices.id = access_sources.device_id
        WHERE access_sources.workspace_id = ${candidateAlias}.workspace_id
          AND access_sources.creator_id = ${candidateAlias}.creator_id
          AND access_devices.owner_user_id = ?
      )
    )`,
  };
}

export function firstVisibleAtExpression(
  candidateAlias: string,
  targetUserId: string | null,
): { parameters: string[]; sql: string } {
  if (!targetUserId) {
    return {
      parameters: [],
      sql: `COALESCE((
        SELECT MIN(all_sources.first_observed_at)
        FROM run_creator_sources all_sources
        WHERE all_sources.workspace_id = ${candidateAlias}.workspace_id
          AND all_sources.creator_id = ${candidateAlias}.creator_id
      ), ${candidateAlias}.created_at)`,
    };
  }

  const sourceExpression = `(
    SELECT MIN(member_sources.first_observed_at)
    FROM run_creator_sources member_sources
    JOIN devices member_devices ON member_devices.id = member_sources.device_id
    WHERE member_sources.workspace_id = ${candidateAlias}.workspace_id
      AND member_sources.creator_id = ${candidateAlias}.creator_id
      AND member_devices.owner_user_id = ?
  )`;
  const assignmentExpression = `(
    SELECT MIN(member_outreach.owner_assigned_at)
    FROM outreach_records member_outreach
    WHERE member_outreach.workspace_id = ${candidateAlias}.workspace_id
      AND member_outreach.candidate_id = ${candidateAlias}.id
      AND member_outreach.owner_user_id = ?
  )`;
  const legacyAssignmentExpression = `CASE
    WHEN ${candidateAlias}.assignee_user_id = ? THEN ${candidateAlias}.created_at
    ELSE NULL
  END`;
  return {
    parameters: [targetUserId, targetUserId, targetUserId],
    sql: `LEAST(
      COALESCE(${sourceExpression}, '9999-12-31 23:59:59.999'),
      COALESCE(${assignmentExpression}, '9999-12-31 23:59:59.999'),
      COALESCE(${legacyAssignmentExpression}, '9999-12-31 23:59:59.999')
    )`,
  };
}

export function visibleObservationIdExpression(
  candidateAlias: string,
  targetUserId: string | null,
): { parameters: string[]; sql: string } {
  if (!targetUserId) {
    return { parameters: [], sql: `${candidateAlias}.latest_creator_observation_id` };
  }
  return {
    parameters: [targetUserId, targetUserId, targetUserId],
    sql: `COALESCE((
      SELECT member_observations.id
      FROM creator_observations member_observations
      JOIN devices member_observation_devices
        ON member_observation_devices.id = member_observations.device_id
      WHERE member_observations.workspace_id = ${candidateAlias}.workspace_id
        AND member_observations.creator_id = ${candidateAlias}.creator_id
        AND member_observation_devices.owner_user_id = ?
      ORDER BY member_observations.observed_at DESC, member_observations.id DESC
      LIMIT 1
    ), CASE WHEN ${candidateAlias}.assignee_user_id = ? OR EXISTS (
      SELECT 1 FROM outreach_records assigned_outreach
      WHERE assigned_outreach.workspace_id = ${candidateAlias}.workspace_id
        AND assigned_outreach.candidate_id = ${candidateAlias}.id
        AND assigned_outreach.owner_user_id = ?
    ) THEN ${candidateAlias}.latest_creator_observation_id END)`,
  };
}

export async function assertCandidateAccess(
  executor: Pool | PoolConnection,
  access: CandidateAccessContext,
  candidateId: string,
  options: { forUpdate?: boolean } = {},
): Promise<void> {
  const scope = resolveCandidateScope(access);
  const visibility = candidateVisibilityPredicate('candidates', scope.targetUserId);
  const [rows] = await executor.query<RowDataPacket[]>(
    `SELECT candidates.id FROM campaign_candidates candidates
     WHERE candidates.workspace_id = ? AND candidates.id = ? AND ${visibility.sql}
     LIMIT 1${options.forUpdate ? ' FOR UPDATE' : ''}`,
    [access.workspaceId, candidateId, ...visibility.parameters],
  );
  if (!rows[0]) throw new CandidateAccessDeniedError();
}
