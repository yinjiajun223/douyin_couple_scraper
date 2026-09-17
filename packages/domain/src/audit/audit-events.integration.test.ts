import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapFirstAdmin } from '../auth/bootstrap-admin.js';
import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import { listAuditEvents, writeAuditEvent } from './audit-events.js';
import type { AuditAction } from './audit-events.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('不可篡改审计事件', () => {
  const pool = createMysqlPool(databaseUrl!);
  const workspaceId = '1c000000-0000-4000-8000-000000000001';
  let userId = '';

  beforeAll(async () => {
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'audit-test',
      workspaceName: '审计测试',
    });
    userId = (
      await bootstrapFirstAdmin(pool, {
        workspaceId,
        email: 'audit-admin@example.test',
        displayName: '审计管理员',
        password: 'StrongAuditAdmin2026',
      })
    ).userId;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('账户、规则、设备、复核、合作、AI和导出动作走同一脱敏写入通道', async () => {
    const actions: AuditAction[] = [
      'account.invitation_created',
      'campaign.rules_updated',
      'device.paired',
      'candidate.reviewed',
      'outreach.status_changed',
      'ai.connection_changed',
      'export.created',
    ];
    for (const [index, action] of actions.entries()) {
      await writeAuditEvent(pool, {
        workspaceId,
        actorUserId: userId,
        action,
        subjectType: action.split('.')[0]!,
        subjectId: `subject-${index}`,
        summary: {
          changed: true,
          password: 'must-not-appear',
          nested: { apiKey: 'must-not-appear', authorization: 'Bearer secret' },
        },
      });
    }

    const events = await listAuditEvents(pool, workspaceId, 50);
    expect(events.map((event) => event.action)).toEqual(expect.arrayContaining(actions));
    const event = events.find((item) => item.action === 'ai.connection_changed');
    expect(event?.summary).toEqual({
      changed: true,
      password: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', authorization: '[REDACTED]' },
    });
    expect(JSON.stringify(events)).not.toContain('must-not-appear');
  });

  it('数据库拒绝更新或删除审计事件', async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM audit_events WHERE workspace_id = ? LIMIT 1',
      [workspaceId],
    );
    const eventId = rows[0]?.id as string;
    await expect(
      pool.execute("UPDATE audit_events SET action = 'export.created' WHERE id = ?", [eventId]),
    ).rejects.toMatchObject({ code: 'ER_SIGNAL_EXCEPTION' });
    await expect(
      pool.execute('DELETE FROM audit_events WHERE id = ?', [eventId]),
    ).rejects.toMatchObject({ code: 'ER_SIGNAL_EXCEPTION' });
  });
});
