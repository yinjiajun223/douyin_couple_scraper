import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMysqlPool, runMigrations } from './migrations.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('账户与权限数据模型', () => {
  const pool = createMysqlPool(databaseUrl!);
  const workspaceId = '10000000-0000-4000-8000-000000000001';
  const userId = '20000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    await runMigrations(pool);
    await pool.execute('INSERT INTO workspaces (id, slug, name) VALUES (?, ?, ?)', [
      workspaceId,
      'test-workspace',
      '测试工作区',
    ]);
    await pool.execute(
      'INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)',
      [userId, 'admin@example.test', 'argon2-test-hash', '测试管理员'],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('创建全部账户相关表', async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name IN ('workspaces', 'users', 'memberships', 'invitations', 'sessions', 'devices', 'audit_events')`,
    );

    expect(rows.map((row) => row.TABLE_NAME ?? row.table_name).sort()).toEqual([
      'audit_events',
      'devices',
      'invitations',
      'memberships',
      'sessions',
      'users',
      'workspaces',
    ]);
  });

  it('邀请令牌保持唯一', async () => {
    const values = [
      '30000000-0000-4000-8000-000000000001',
      workspaceId,
      'member@example.test',
      'operator',
      'a'.repeat(64),
      '2030-01-01 00:00:00.000',
      userId,
    ];
    await pool.execute(
      `INSERT INTO invitations
       (id, workspace_id, email, role, token_hash, expires_at, invited_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      values,
    );

    await expect(
      pool.execute(
        `INSERT INTO invitations
         (id, workspace_id, email, role, token_hash, expires_at, invited_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['30000000-0000-4000-8000-000000000002', ...values.slice(1)],
      ),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  it('角色约束拒绝未知角色', async () => {
    await expect(
      pool.execute('INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?)', [
        workspaceId,
        userId,
        'superuser',
      ]),
    ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
  });

  it('工作区仍被成员引用时禁止级联删除', async () => {
    await pool.execute('INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?)', [
      workspaceId,
      userId,
      'admin',
    ]);

    await expect(
      pool.execute('DELETE FROM workspaces WHERE id = ?', [workspaceId]),
    ).rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' });
  });
});
