import type { Pool, RowDataPacket } from 'mysql2/promise';

import { writeAuditEvent } from '../audit/audit-events.js';
import type { WorkspaceRole } from '../auth/permissions.js';
import { listCandidates } from './candidate-library.js';

interface OutreachExportRow extends RowDataPacket {
  candidate_id: string;
  contact_channel: string | null;
  contact_value: string | null;
  currency: string | null;
  next_action: string | null;
  owner_name: string | null;
  quoted_amount: string | number | null;
}

export const CANDIDATE_EXPORT_HEADERS = [
  '候选ID',
  '任务',
  '昵称',
  '抖音主页',
  '粉丝数',
  '硬筛结果',
  '人工结论',
  '合作阶段',
  '负责人',
  '联系方式',
  '报价',
  '币种',
  '下一步',
  '标签',
  '观察时间',
] as const;

export async function exportCandidateCsv(
  pool: Pool,
  input: {
    actorRole: WorkspaceRole;
    actorUserId: string;
    filters: Record<string, unknown>;
    workspaceId: string;
  },
) {
  const candidates = await listCandidates(pool, {
    ...input.filters,
    actorRole: input.actorRole,
    actorUserId: input.actorUserId,
    limit: Math.min(Number(input.filters.limit ?? 200), 200),
    workspaceId: input.workspaceId,
  });
  const outreachByCandidate = new Map<string, OutreachExportRow>();
  if (candidates.length > 0) {
    const [rows] = await pool.query<OutreachExportRow[]>(
      `SELECT outreach.candidate_id, outreach.contact_channel, outreach.contact_value,
              outreach.quoted_amount, outreach.currency, outreach.next_action,
              users.display_name AS owner_name
       FROM outreach_records outreach
       LEFT JOIN users ON users.id = outreach.owner_user_id
       WHERE outreach.workspace_id = ?
         AND outreach.candidate_id IN (${candidates.map(() => '?').join(', ')})`,
      [input.workspaceId, ...candidates.map((candidate) => candidate.id)],
    );
    for (const row of rows) outreachByCandidate.set(row.candidate_id, row);
  }
  const records = candidates.map((candidate) => {
    const outreach = outreachByCandidate.get(candidate.id);
    return [
      candidate.id,
      candidate.campaignName,
      candidate.nickname,
      candidate.profileUrl,
      candidate.followerCount,
      candidate.hardFilterStatus,
      candidate.manualDecision,
      candidate.pipelineStatus,
      outreach?.owner_name ?? '',
      [outreach?.contact_channel, outreach?.contact_value].filter(Boolean).join('：'),
      outreach?.quoted_amount ?? '',
      outreach?.currency ?? '',
      outreach?.next_action ?? '',
      candidate.tags.join(' / '),
      candidate.observedAt.toISOString(),
    ];
  });
  const csv = `\uFEFF${[CANDIDATE_EXPORT_HEADERS, ...records]
    .map((record) => record.map(toCsvCell).join(','))
    .join('\r\n')}\r\n`;
  await writeAuditEvent(pool, {
    action: 'export.created',
    actorUserId: input.actorUserId,
    subjectId: `candidate-export:${Date.now()}`,
    subjectType: 'candidate_export',
    summary: { count: records.length, filters: input.filters, fields: CANDIDATE_EXPORT_HEADERS },
    workspaceId: input.workspaceId,
  });
  return { count: records.length, csv };
}

export function toCsvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
