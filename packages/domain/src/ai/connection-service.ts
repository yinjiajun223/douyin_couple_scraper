import { randomUUID } from 'node:crypto';

import type { Pool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

import { writeAuditEvent } from '../audit/audit-events.js';
import { CredentialCipher } from './credential-cipher.js';
import type { EncryptedCredential } from './credential-cipher.js';
import type { AiProvider, OpenAiCompatibleProviderConfig } from './provider.js';
import { OpenAiCompatibleProvider } from './provider.js';
import { diagnoseAiProvider } from './connection-diagnostics.js';
import type { AiConnectionTestResult } from './connection-diagnostics.js';

const connectionInputSchema = z
  .object({
    apiKey: z.string().min(1).max(4_096),
    baseUrl: z.url().max(2_048),
    label: z.string().trim().min(2).max(200),
    limits: z
      .object({
        concurrency: z.number().int().min(1).max(16).default(1),
        monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable().default(null),
      })
      .default({ concurrency: 1, monthlyBudgetUsd: null }),
    model: z.string().trim().min(1).max(200),
    supportsImages: z.boolean().default(false),
    supportsJsonSchema: z.boolean().default(false),
    workspaceId: z.uuid(),
    actorUserId: z.uuid(),
  })
  .strict();

interface ConnectionRow extends RowDataPacket {
  adapter_type: 'openai-compatible';
  base_url: string;
  capabilities_json: { images?: boolean; jsonSchema?: boolean };
  credential_auth_tag: Buffer;
  credential_ciphertext: Buffer;
  credential_iv: Buffer;
  credential_key_version: number;
  id: string;
  label: string;
  last_test_result_json: Record<string, unknown> | null;
  last_tested_at: Date | null;
  limits_json: { concurrency?: number; monthlyBudgetUsd?: number | null };
  model: string;
  status: 'disabled' | 'testing' | 'enabled' | 'failed';
  updated_at: Date;
  workspace_id: string;
}

export interface AiConnectionSummary {
  baseUrl: string;
  capabilities: { images: boolean; jsonSchema: boolean };
  credential: 'configured';
  id: string;
  label: string;
  lastTestResult: Record<string, unknown> | null;
  lastTestedAt: Date | null;
  limits: { concurrency: number; monthlyBudgetUsd: number | null };
  model: string;
  status: 'disabled' | 'testing' | 'enabled' | 'failed';
  updatedAt: Date;
}

export class AiConnectionNotFoundError extends Error {
  public constructor() {
    super('找不到 AI 连接');
    this.name = 'AiConnectionNotFoundError';
  }
}

export async function createAiConnection(
  pool: Pool,
  cipher: CredentialCipher,
  rawInput: unknown,
): Promise<AiConnectionSummary> {
  const input = connectionInputSchema.parse(rawInput);
  const id = randomUUID();
  const material = cipher.encrypt(input.apiKey, credentialContext(input.workspaceId, id));
  await pool.execute(
    `INSERT INTO ai_connections
     (id, workspace_id, label, adapter_type, base_url, model, capabilities_json,
      limits_json, credential_ciphertext, credential_iv, credential_auth_tag,
      credential_key_version, created_by_user_id)
     VALUES (?, ?, ?, 'openai-compatible', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.label,
      input.baseUrl,
      input.model,
      JSON.stringify({ images: input.supportsImages, jsonSchema: input.supportsJsonSchema }),
      JSON.stringify(input.limits),
      material.ciphertext,
      material.iv,
      material.authTag,
      material.keyVersion,
      input.actorUserId,
    ],
  );
  await writeAuditEvent(pool, {
    action: 'ai.connection_changed',
    actorUserId: input.actorUserId,
    subjectId: id,
    subjectType: 'ai_connection',
    summary: { operation: 'created', apiKey: input.apiKey },
    workspaceId: input.workspaceId,
  });
  return requireAiConnection(pool, input.workspaceId, id);
}

export async function listAiConnections(
  pool: Pool,
  workspaceId: string,
): Promise<AiConnectionSummary[]> {
  const [rows] = await pool.query<ConnectionRow[]>(
    `${connectionSelect} WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC`,
    [workspaceId],
  );
  return rows.map(toSummary);
}

export async function replaceAiConnectionCredential(
  pool: Pool,
  cipher: CredentialCipher,
  input: { workspaceId: string; actorUserId: string; connectionId: string; apiKey: string },
): Promise<void> {
  z.object({
    workspaceId: z.uuid(),
    actorUserId: z.uuid(),
    connectionId: z.uuid(),
    apiKey: z.string().min(1).max(4_096),
  })
    .strict()
    .parse(input);
  await requireConnectionRow(pool, input.workspaceId, input.connectionId);
  const material = cipher.encrypt(
    input.apiKey,
    credentialContext(input.workspaceId, input.connectionId),
  );
  await updateMaterial(pool, input.workspaceId, input.connectionId, material);
  await writeAuditEvent(pool, {
    action: 'ai.connection_changed',
    actorUserId: input.actorUserId,
    subjectId: input.connectionId,
    subjectType: 'ai_connection',
    summary: { operation: 'credential_replaced', apiKey: input.apiKey },
    workspaceId: input.workspaceId,
  });
}

export async function rotateAiConnectionEncryption(
  pool: Pool,
  cipher: CredentialCipher,
  workspaceId: string,
): Promise<number> {
  const [rows] = await pool.query<ConnectionRow[]>(
    `${connectionSelect} WHERE workspace_id = ? AND credential_key_version <> ?`,
    [workspaceId, cipher.activeVersion],
  );
  for (const row of rows) {
    const context = credentialContext(workspaceId, row.id);
    const apiKey = cipher.decrypt(rowMaterial(row), context);
    await updateMaterial(pool, workspaceId, row.id, cipher.encrypt(apiKey, context));
  }
  return rows.length;
}

export async function loadAiProviderConfig(
  pool: Pool,
  cipher: CredentialCipher,
  workspaceId: string,
  connectionId: string,
): Promise<OpenAiCompatibleProviderConfig> {
  const row = await requireConnectionRow(pool, workspaceId, connectionId);
  return {
    apiKey: cipher.decrypt(rowMaterial(row), credentialContext(workspaceId, connectionId)),
    baseUrl: row.base_url,
    model: row.model,
    supportsImages: row.capabilities_json.images === true,
    supportsJsonSchema: row.capabilities_json.jsonSchema === true,
  };
}

export async function testAiConnection(
  pool: Pool,
  cipher: CredentialCipher,
  workspaceId: string,
  connectionId: string,
  providerFactory: (config: OpenAiCompatibleProviderConfig) => AiProvider = (config) =>
    new OpenAiCompatibleProvider(config),
): Promise<AiConnectionTestResult> {
  await pool.execute(
    `UPDATE ai_connections SET status = 'testing', updated_at = CURRENT_TIMESTAMP(3)
     WHERE workspace_id = ? AND id = ?`,
    [workspaceId, connectionId],
  );
  const config = await loadAiProviderConfig(pool, cipher, workspaceId, connectionId);
  const result = await diagnoseAiProvider(providerFactory(config), {
    images: config.supportsImages,
    jsonSchema: config.supportsJsonSchema,
  });
  await pool.execute(
    `UPDATE ai_connections
     SET status = ?, last_tested_at = CURRENT_TIMESTAMP(3), last_test_result_json = ?,
         updated_at = CURRENT_TIMESTAMP(3)
     WHERE workspace_id = ? AND id = ?`,
    [
      result.overall === 'passed' ? 'enabled' : 'failed',
      JSON.stringify(result),
      workspaceId,
      connectionId,
    ],
  );
  return result;
}

async function requireAiConnection(pool: Pool, workspaceId: string, id: string) {
  return toSummary(await requireConnectionRow(pool, workspaceId, id));
}

async function requireConnectionRow(pool: Pool, workspaceId: string, id: string) {
  const [rows] = await pool.query<ConnectionRow[]>(
    `${connectionSelect} WHERE workspace_id = ? AND id = ? LIMIT 1`,
    [workspaceId, id],
  );
  if (!rows[0]) throw new AiConnectionNotFoundError();
  return rows[0];
}

async function updateMaterial(
  pool: Pool,
  workspaceId: string,
  id: string,
  material: EncryptedCredential,
) {
  await pool.execute(
    `UPDATE ai_connections
     SET credential_ciphertext = ?, credential_iv = ?, credential_auth_tag = ?,
         credential_key_version = ?, updated_at = CURRENT_TIMESTAMP(3)
     WHERE workspace_id = ? AND id = ?`,
    [material.ciphertext, material.iv, material.authTag, material.keyVersion, workspaceId, id],
  );
}

function rowMaterial(row: ConnectionRow): EncryptedCredential {
  return {
    authTag: row.credential_auth_tag,
    ciphertext: row.credential_ciphertext,
    iv: row.credential_iv,
    keyVersion: row.credential_key_version,
  };
}

function credentialContext(workspaceId: string, connectionId: string) {
  return `ai-connection:${workspaceId}:${connectionId}`;
}

function toSummary(row: ConnectionRow): AiConnectionSummary {
  return {
    baseUrl: row.base_url,
    capabilities: {
      images: row.capabilities_json.images === true,
      jsonSchema: row.capabilities_json.jsonSchema === true,
    },
    credential: 'configured',
    id: row.id,
    label: row.label,
    lastTestResult: row.last_test_result_json,
    lastTestedAt: row.last_tested_at,
    limits: {
      concurrency: row.limits_json.concurrency ?? 1,
      monthlyBudgetUsd: row.limits_json.monthlyBudgetUsd ?? null,
    },
    model: row.model,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

const connectionSelect = `SELECT id, workspace_id, label, adapter_type, base_url, model,
  capabilities_json, limits_json, credential_ciphertext, credential_iv,
  credential_auth_tag, credential_key_version, status, last_tested_at,
  last_test_result_json, updated_at FROM ai_connections`;
