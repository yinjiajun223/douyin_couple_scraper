import { randomUUID } from 'node:crypto';

import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

import { redactSensitiveValues } from '../config.js';

export type AuditAction =
  | 'account.bootstrap_admin'
  | 'account.invitation_created'
  | 'account.invitation_accepted'
  | 'account.invitation_revoked'
  | 'account.disabled'
  | 'account.enabled'
  | 'account.role_changed'
  | 'campaign.rules_updated'
  | 'campaign.run_created'
  | 'campaign.run_status_changed'
  | 'device.pairing_code_created'
  | 'device.paired'
  | 'device.token_rotated'
  | 'device.revoked'
  | 'candidate.reviewed'
  | 'candidate.archived'
  | 'candidate.unarchived'
  | 'candidate.tags_changed'
  | 'outreach.status_changed'
  | 'export.created';

export interface WriteAuditEventInput {
  workspaceId: string;
  actorUserId?: string;
  actorDeviceId?: string;
  action: AuditAction;
  subjectType: string;
  subjectId: string;
  summary: Record<string, unknown>;
  ipAddress?: string;
}

export interface AuditEventRecord {
  id: string;
  action: AuditAction;
  subjectType: string;
  subjectId: string;
  actorUserId: string | null;
  actorDeviceId: string | null;
  summary: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: Date;
}

type AuditExecutor = Pick<Pool | PoolConnection, 'execute'>;

interface AuditRow extends RowDataPacket {
  action: AuditAction;
  actor_device_id: string | null;
  actor_user_id: string | null;
  created_at: Date;
  id: string;
  ip_address: string | null;
  subject_id: string;
  subject_type: string;
  summary_json: Record<string, unknown>;
}

export async function writeAuditEvent(
  executor: AuditExecutor,
  input: WriteAuditEventInput,
): Promise<string> {
  const id = randomUUID();
  const summary = redactSensitiveValues(input.summary) as Record<string, unknown>;
  await executor.execute(
    `INSERT INTO audit_events
     (id, workspace_id, actor_user_id, actor_device_id, action,
      subject_type, subject_id, summary_json, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.actorUserId ?? null,
      input.actorDeviceId ?? null,
      input.action,
      input.subjectType,
      input.subjectId,
      JSON.stringify(summary),
      input.ipAddress ?? null,
    ],
  );
  return id;
}

export async function listAuditEvents(
  pool: Pool,
  workspaceId: string,
  limit = 100,
): Promise<AuditEventRecord[]> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 200));
  const [rows] = await pool.query<AuditRow[]>(
    `SELECT id, actor_user_id, actor_device_id, action, subject_type,
            subject_id, summary_json, ip_address, created_at
     FROM audit_events
     WHERE workspace_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [workspaceId, boundedLimit],
  );
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    actorUserId: row.actor_user_id,
    actorDeviceId: row.actor_device_id,
    summary: row.summary_json,
    ipAddress: row.ip_address,
    createdAt: row.created_at,
  }));
}
