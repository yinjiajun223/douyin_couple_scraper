import { randomUUID } from 'node:crypto';

import type { Pool, RowDataPacket } from 'mysql2/promise';

import type { CampaignRuleSet } from '@douyin/contracts';

import type { WorkspaceRole } from '../auth/permissions.js';
import { assertCandidateAccess } from '../candidates/candidate-access.js';
import type { ObjectStorageClient } from '../media/object-storage.js';

import { buildMinimalAiInput } from './minimal-input.js';
import { loadAiProviderConfig } from './connection-service.js';
import type { CredentialCipher } from './credential-cipher.js';
import type { AiProvider, OpenAiCompatibleProviderConfig } from './provider.js';
import { OpenAiCompatibleProvider } from './provider.js';
import {
  AI_SCREENING_PROMPT_VERSION,
  AI_SCREENING_RESULT_SCHEMA_VERSION,
  buildAiScreeningPrompt,
  parseAiScreeningResult,
} from './screening-prompt.js';

interface AnalysisRow extends RowDataPacket {
  candidate_id: string;
  connection_id: string | null;
  created_at: Date;
  error_code: string | null;
  error_message: string | null;
  id: string;
  input_evidence_json: Record<string, unknown>;
  model: string | null;
  normalized_result_json: Record<string, unknown> | null;
  prompt_version: string;
  provider_label: string | null;
  raw_response_metadata_json: Record<string, unknown> | null;
  result_schema_version: number;
  status: 'queued' | 'running' | 'succeeded' | 'unavailable' | 'failed';
  workspace_id: string;
}

interface ConnectionRow extends RowDataPacket {
  id: string;
  label: string;
  model: string;
}

interface EvidenceRow extends RowDataPacket {
  biography: string | null;
  nickname: string;
  rules_json: CampaignRuleSet;
}

interface PostEvidenceRow extends RowDataPacket {
  caption: string | null;
  id: string;
}

interface MediaEvidenceRow extends RowDataPacket {
  id: string;
  object_key: string;
}

export interface AiEvidenceBundle {
  biography: string | null;
  nickname: string;
  posts: Array<{ caption: string | null; sourceId: string }>;
  rules: CampaignRuleSet;
  selectedScreenshots: Array<{ sourceId: string; url: string }>;
}

export interface AiAnalysisHistoryItem {
  createdAt: Date;
  error: { code: string | null; message: string | null } | null;
  id: string;
  inputEvidence: Record<string, unknown>;
  model: string | null;
  promptVersion: string;
  providerLabel: string | null;
  result: Record<string, unknown> | null;
  resultSchemaVersion: number;
  status: AnalysisRow['status'];
}

export class AiAnalysisNotFoundError extends Error {
  public constructor() {
    super('找不到 AI 分析记录');
    this.name = 'AiAnalysisNotFoundError';
  }
}

export async function runAiAnalysis(
  pool: Pool,
  cipher: CredentialCipher,
  workspaceId: string,
  analysisId: string,
  evidenceLoader: (candidateId: string) => Promise<AiEvidenceBundle>,
  providerFactory: (config: OpenAiCompatibleProviderConfig) => AiProvider = (config) =>
    new OpenAiCompatibleProvider(config),
): Promise<Record<string, unknown>> {
  const analysis = await requireAnalysis(pool, workspaceId, analysisId);
  if (!analysis.connection_id) throw new AiAnalysisNotFoundError();
  await pool.execute(
    `UPDATE ai_analysis_runs
     SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)),
         error_code = NULL, error_message = NULL
     WHERE workspace_id = ? AND id = ?`,
    [workspaceId, analysisId],
  );
  try {
    const evidence = await evidenceLoader(analysis.candidate_id);
    const minimalInput = buildMinimalAiInput({
      biography: evidence.biography,
      nickname: evidence.nickname,
      posts: evidence.posts,
      rules: evidence.rules,
      selectedScreenshotUrls: evidence.selectedScreenshots.map((screenshot) => screenshot.url),
    });
    const prompt = buildAiScreeningPrompt(evidence.rules, {
      biography: minimalInput.publicProfile.biography,
      nickname: minimalInput.publicProfile.nickname,
      postCaptions: minimalInput.publicProfile.posts.map((post) => ({
        caption: post.caption,
        id: post.sourceId,
      })),
    });
    const config = await loadAiProviderConfig(pool, cipher, workspaceId, analysis.connection_id);
    const response = await providerFactory(config).complete({
      imageUrls: minimalInput.selectedScreenshotUrls,
      jsonSchema: prompt.jsonSchema,
      systemPrompt: prompt.systemPrompt,
      userText: prompt.userText,
    });
    const result = parseAiScreeningResult(response.content);
    const persistedEvidence = {
      publicProfile: minimalInput.publicProfile,
      rules: minimalInput.rules,
      selectedScreenshotSourceIds: evidence.selectedScreenshots.map(
        (screenshot) => screenshot.sourceId,
      ),
    };
    await pool.execute(
      `UPDATE ai_analysis_runs
       SET model = ?, prompt_version = ?, result_schema_version = ?,
           input_evidence_json = ?, normalized_result_json = ?,
           raw_response_metadata_json = ?, status = 'succeeded',
           completed_at = CURRENT_TIMESTAMP(3), error_code = NULL, error_message = NULL
       WHERE workspace_id = ? AND id = ?`,
      [
        response.model,
        AI_SCREENING_PROMPT_VERSION,
        AI_SCREENING_RESULT_SCHEMA_VERSION,
        JSON.stringify(persistedEvidence),
        JSON.stringify(result),
        JSON.stringify({
          finishReason: response.finishReason,
          requestId: response.requestId,
          usage: response.usage,
        }),
        workspaceId,
        analysisId,
      ],
    );
    return result;
  } catch (error) {
    await pool.execute(
      `UPDATE ai_analysis_runs
       SET status = 'failed', error_code = ?, error_message = ?, completed_at = CURRENT_TIMESTAMP(3)
       WHERE workspace_id = ? AND id = ?`,
      [
        error instanceof Error ? error.name.slice(0, 100) : 'UnknownError',
        safeAnalysisErrorMessage(error),
        workspaceId,
        analysisId,
      ],
    );
    throw error;
  }
}

export async function queueAiReanalysis(
  pool: Pool,
  input: {
    actorRole: WorkspaceRole;
    actorUserId: string;
    candidateId: string;
    workspaceId: string;
  },
) {
  await assertCandidateAccess(pool, input, input.candidateId);
  const [connections] = await pool.query<ConnectionRow[]>(
    `SELECT id, label, model FROM ai_connections
     WHERE workspace_id = ? AND status = 'enabled'
     ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [input.workspaceId],
  );
  if (!connections[0]) throw new AiAnalysisNotFoundError();
  const analysisId = randomUUID();
  const jobId = randomUUID();
  await pool.execute(
    `INSERT INTO ai_analysis_runs
     (id, workspace_id, candidate_id, connection_id, provider_label, model,
      prompt_version, result_schema_version, input_evidence_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 'queued')`,
    [
      analysisId,
      input.workspaceId,
      input.candidateId,
      connections[0].id,
      connections[0].label,
      connections[0].model,
      AI_SCREENING_PROMPT_VERSION,
      AI_SCREENING_RESULT_SCHEMA_VERSION,
    ],
  );
  await pool.execute(
    `INSERT INTO background_jobs
     (id, workspace_id, job_type, deduplication_key, payload_json)
     VALUES (?, ?, 'ai-screening', ?, ?)`,
    [
      jobId,
      input.workspaceId,
      `analysis:${analysisId}`,
      JSON.stringify({
        analysisId,
        candidateId: input.candidateId,
        connectionId: connections[0].id,
        manuallyRequestedByUserId: input.actorUserId,
        promptVersion: AI_SCREENING_PROMPT_VERSION,
      }),
    ],
  );
  return { analysisId, jobId };
}

export async function listAiAnalysisHistory(
  pool: Pool,
  workspaceId: string,
  candidateId: string,
): Promise<AiAnalysisHistoryItem[]> {
  const [rows] = await pool.query<AnalysisRow[]>(
    `${analysisSelect} WHERE workspace_id = ? AND candidate_id = ?
     ORDER BY created_at DESC, id DESC`,
    [workspaceId, candidateId],
  );
  return rows.map((row) => ({
    createdAt: row.created_at,
    error:
      row.error_code || row.error_message
        ? { code: row.error_code, message: row.error_message }
        : null,
    id: row.id,
    inputEvidence: row.input_evidence_json,
    model: row.model,
    promptVersion: row.prompt_version,
    providerLabel: row.provider_label,
    result: row.normalized_result_json,
    resultSchemaVersion: row.result_schema_version,
    status: row.status,
  }));
}

export async function loadCandidateAiEvidence(
  pool: Pool,
  storage: ObjectStorageClient,
  workspaceId: string,
  candidateId: string,
): Promise<AiEvidenceBundle> {
  const [rows] = await pool.query<EvidenceRow[]>(
    `SELECT observations.nickname, observations.biography, versions.rules_json
     FROM campaign_candidates candidates
     JOIN creator_observations observations ON observations.id = candidates.latest_creator_observation_id
     JOIN collection_runs runs ON runs.id = candidates.latest_run_id
     JOIN campaign_rule_versions versions ON versions.id = runs.rule_version_id
     WHERE candidates.workspace_id = ? AND candidates.id = ? LIMIT 1`,
    [workspaceId, candidateId],
  );
  if (!rows[0]) throw new AiAnalysisNotFoundError();
  const [posts] = await pool.query<PostEvidenceRow[]>(
    `SELECT id, caption FROM post_observations
     WHERE workspace_id = ? AND creator_observation_id = (
       SELECT latest_creator_observation_id FROM campaign_candidates
       WHERE workspace_id = ? AND id = ?
     ) ORDER BY observed_at DESC, id DESC LIMIT 20`,
    [workspaceId, workspaceId, candidateId],
  );
  const [media] = await pool.query<MediaEvidenceRow[]>(
    `SELECT media.id, media.object_key FROM media_objects media
     WHERE media.workspace_id = ? AND media.status = 'confirmed'
       AND media.purpose IN ('profile_screenshot', 'post_screenshot')
       AND (media.creator_observation_id = (
         SELECT latest_creator_observation_id FROM campaign_candidates
         WHERE workspace_id = ? AND id = ?
       ) OR media.post_observation_id IN (${posts.length ? posts.map(() => '?').join(', ') : 'NULL'}))
     ORDER BY media.created_at DESC, media.id DESC LIMIT 4`,
    [workspaceId, workspaceId, candidateId, ...posts.map((post) => post.id)],
  );
  const selectedScreenshots = await Promise.all(
    media.map(async (item) => ({
      sourceId: `media:${item.id}`,
      url: await storage.createSignedGetUrl({ expiresInSeconds: 120, objectKey: item.object_key }),
    })),
  );
  return {
    biography: rows[0].biography,
    nickname: rows[0].nickname,
    posts: posts.map((post) => ({
      caption: post.caption,
      sourceId: `post-observation:${post.id}`,
    })),
    rules: rows[0].rules_json,
    selectedScreenshots,
  };
}

async function requireAnalysis(pool: Pool, workspaceId: string, analysisId: string) {
  const [rows] = await pool.query<AnalysisRow[]>(
    `${analysisSelect} WHERE workspace_id = ? AND id = ? LIMIT 1`,
    [workspaceId, analysisId],
  );
  if (!rows[0]) throw new AiAnalysisNotFoundError();
  return rows[0];
}

function safeAnalysisErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'AI analysis failed.';
  if (error.name === 'AiProviderTimeoutError') return 'AI provider request timed out.';
  if (error.name === 'AiProviderRequestError') return 'AI provider request failed.';
  if (error.name === 'InvalidAiScreeningOutputError') return error.message;
  return 'AI analysis failed.';
}

const analysisSelect = `SELECT id, workspace_id, candidate_id, connection_id,
  provider_label, model, prompt_version, result_schema_version, input_evidence_json,
  normalized_result_json, raw_response_metadata_json, status, error_code, error_message,
  created_at FROM ai_analysis_runs`;
