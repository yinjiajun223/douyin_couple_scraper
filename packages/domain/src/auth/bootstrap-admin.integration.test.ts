import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import { AdminAlreadyBootstrappedError, bootstrapFirstAdmin } from './bootstrap-admin.js';
import { verifyPassword } from './passwords.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('首位管理员 bootstrap', () => {
  const pool = createMysqlPool(databaseUrl!);
  const workspaceId = '17000000-0000-4000-8000-000000000001';
  const input = {
    workspaceId,
    email: 'FIRST.ADMIN@EXAMPLE.TEST',
    displayName: '首位管理员',
    password: 'StrongAdmin2026',
  };

  beforeAll(async () => {
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'admin-bootstrap-test',
      workspaceName: '管理员初始化测试',
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('首次创建管理员，重复执行不创建重复账户', async () => {
    const first = await bootstrapFirstAdmin(pool, input);
    const second = await bootstrapFirstAdmin(pool, input);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT users.id, users.email, users.password_hash, memberships.role
       FROM users
       JOIN memberships ON memberships.user_id = users.id
       WHERE memberships.workspace_id = ?`,
      [workspaceId],
    );

    expect(first.status).toBe('created');
    expect(second).toEqual({ status: 'already_initialized', userId: first.userId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({ email: 'first.admin@example.test', role: 'admin' }),
    );
    await expect(verifyPassword(String(rows[0]?.password_hash), input.password)).resolves.toBe(
      true,
    );
  });

  it('已有首位管理员后拒绝换用其他邮箱再次初始化', async () => {
    await expect(
      bootstrapFirstAdmin(pool, {
        ...input,
        email: 'other.admin@example.test',
      }),
    ).rejects.toBeInstanceOf(AdminAlreadyBootstrappedError);
  });
});
