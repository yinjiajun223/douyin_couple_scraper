import type { Pool, RowDataPacket } from 'mysql2/promise';

import {
  candidateVisibilityPredicate,
  resolveCandidateScope,
} from '../candidates/candidate-access.js';
import type { CandidateAccessContext } from '../candidates/candidate-access.js';

interface DashboardRow extends RowDataPacket {
  failed_runs: number;
  my_assignments: number;
  pending_review: number;
  running_runs: number;
  to_contact: number;
}

export interface OperationsDashboard {
  failedRuns: number;
  myAssignments: number;
  pendingReview: number;
  runningRuns: number;
  toContact: number;
}

export async function getOperationsDashboard(
  pool: Pool,
  access: CandidateAccessContext,
): Promise<OperationsDashboard> {
  const scope = resolveCandidateScope(access);
  const pendingVisibility = candidateVisibilityPredicate('pending_candidates', scope.targetUserId);
  const contactVisibility = candidateVisibilityPredicate('contact_candidates', scope.targetUserId);
  const [rows] = await pool.query<DashboardRow[]>(
    `SELECT
       (SELECT COUNT(*) FROM collection_runs
        WHERE workspace_id = ? AND status IN ('claimed', 'running', 'paused')) AS running_runs,
       (SELECT COUNT(*) FROM campaign_candidates pending_candidates
        WHERE pending_candidates.workspace_id = ? AND pending_candidates.archived_at IS NULL
          AND pending_candidates.hard_filter_status = 'pass'
          AND pending_candidates.pipeline_status = 'pending_review'
          AND ${pendingVisibility.sql}) AS pending_review,
       (SELECT COUNT(*) FROM campaign_candidates contact_candidates
        WHERE contact_candidates.workspace_id = ? AND contact_candidates.archived_at IS NULL
          AND contact_candidates.hard_filter_status = 'pass'
          AND contact_candidates.pipeline_status = 'to_contact'
          AND ${contactVisibility.sql}) AS to_contact,
       (SELECT COUNT(*) FROM campaign_candidates candidates
        LEFT JOIN outreach_records outreach ON outreach.candidate_id = candidates.id
        WHERE candidates.workspace_id = ? AND candidates.archived_at IS NULL
          AND candidates.hard_filter_status = 'pass'
          AND COALESCE(outreach.owner_user_id, candidates.assignee_user_id) = ?) AS my_assignments,
       (SELECT COUNT(*) FROM collection_runs
        WHERE workspace_id = ? AND status = 'failed') AS failed_runs`,
    [
      access.workspaceId,
      access.workspaceId,
      ...pendingVisibility.parameters,
      access.workspaceId,
      ...contactVisibility.parameters,
      access.workspaceId,
      access.actorUserId,
      access.workspaceId,
    ],
  );
  const row = rows[0];
  return {
    failedRuns: Number(row?.failed_runs ?? 0),
    myAssignments: Number(row?.my_assignments ?? 0),
    pendingReview: Number(row?.pending_review ?? 0),
    runningRuns: Number(row?.running_runs ?? 0),
    toContact: Number(row?.to_contact ?? 0),
  };
}
