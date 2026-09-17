import { randomUUID } from 'node:crypto';

import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { parseCampaignRuleSet } from '@douyin/contracts';
import type { CampaignRuleSet } from '@douyin/contracts';

import { AI_SCREENING_PROMPT_VERSION } from './screening-prompt.js';

interface CountRow extends RowDataPacket {
  scheduled_count: number;
}

interface ConnectionIdRow extends RowDataPacket {
  id: string;
  label: string;
  model: string;
}

interface IdRow extends RowDataPacket {
  id: string;
}

export type AiSchedulingResult =
  | { scheduled: true; jobId: string }
  | {
      scheduled: false;
      reason: 'hard_filter_not_passed' | 'disabled' | 'limit_reached' | 'no_connection';
    };

export async function scheduleAiScreeningJob(
  connection: PoolConnection,
  rawInput: {
    candidateId: string;
    hardFilterStatus: 'pass' | 'fail' | 'unknown';
    rules: CampaignRuleSet;
    runId: string;
    workspaceId: string;
  },
): Promise<AiSchedulingResult> {
  const rules = parseCampaignRuleSet(rawInput.rules);
  if (rawInput.hardFilterStatus !== 'pass') {
    return { reason: 'hard_filter_not_passed', scheduled: false };
  }
  if (rules.aiRules.length === 0 || rules.aiLimits.maximumCandidates === 0) {
    return { reason: 'disabled', scheduled: false };
  }
  const costLimitedMaximum =
    rules.aiLimits.budgetCents === undefined
      ? rules.aiLimits.maximumCandidates
      : Math.min(rules.aiLimits.maximumCandidates, rules.aiLimits.budgetCents);
  if (costLimitedMaximum === 0) return { reason: 'limit_reached', scheduled: false };

  const [connections] = await connection.query<ConnectionIdRow[]>(
    `SELECT id, label, model FROM ai_connections
     WHERE workspace_id = ? AND status = 'enabled'
     ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [rawInput.workspaceId],
  );
  if (!connections[0]) return { reason: 'no_connection', scheduled: false };

  const [counts] = await connection.query<CountRow[]>(
    `SELECT COUNT(*) AS scheduled_count FROM background_jobs
     WHERE workspace_id = ? AND job_type = 'ai-screening'
       AND JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.runId')) = ?`,
    [rawInput.workspaceId, rawInput.runId],
  );
  if (Number(counts[0]?.scheduled_count ?? 0) >= costLimitedMaximum) {
    return { reason: 'limit_reached', scheduled: false };
  }
  const deduplicationKey = `candidate:${rawInput.candidateId}:run:${rawInput.runId}:${AI_SCREENING_PROMPT_VERSION}`;
  const [existingJobs] = await connection.query<IdRow[]>(
    `SELECT id FROM background_jobs
     WHERE workspace_id = ? AND job_type = 'ai-screening' AND deduplication_key = ? LIMIT 1`,
    [rawInput.workspaceId, deduplicationKey],
  );
  if (existingJobs[0]) return { jobId: existingJobs[0].id, scheduled: true };
  const jobId = randomUUID();
  const analysisId = randomUUID();
  await connection.execute(
    `INSERT INTO ai_analysis_runs
     (id, workspace_id, candidate_id, connection_id, provider_label, model,
      prompt_version, result_schema_version, input_evidence_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, '{}', 'queued')`,
    [
      analysisId,
      rawInput.workspaceId,
      rawInput.candidateId,
      connections[0].id,
      connections[0].label,
      connections[0].model,
      AI_SCREENING_PROMPT_VERSION,
    ],
  );
  await connection.execute(
    `INSERT INTO background_jobs
     (id, workspace_id, job_type, deduplication_key, payload_json)
     VALUES (?, ?, 'ai-screening', ?, ?) ON DUPLICATE KEY UPDATE id = id`,
    [
      jobId,
      rawInput.workspaceId,
      deduplicationKey,
      JSON.stringify({
        analysisId,
        budgetCents: rules.aiLimits.budgetCents ?? null,
        candidateId: rawInput.candidateId,
        concurrency: rules.aiLimits.concurrency,
        connectionId: connections[0].id,
        estimatedCostCents: 1,
        promptVersion: AI_SCREENING_PROMPT_VERSION,
        runId: rawInput.runId,
      }),
    ],
  );
  return { jobId, scheduled: true };
}
