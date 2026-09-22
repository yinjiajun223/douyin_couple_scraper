import type { Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import { bootstrapFirstAdmin } from './bootstrap-admin.js';
import { listWorkspaceDevices } from './directory.js';
import { revokeDevice } from './devices.js';
import { disableUserAccount } from './sessions.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('采集设备目录', () => {
  const workspaceId = '82000000-0000-4000-8000-000000000001';
  const operatorA = '82000000-0000-4000-8000-000000000002';
  const operatorB = '82000000-0000-4000-8000-000000000003';
  const deviceManual = '82000000-0000-4000-8000-000000000010';
  const deviceActive = '82000000-0000-4000-8000-000000000011';
  const deviceCascaded = '82000000-0000-4000-8000-000000000012';
  let pool: Pool;
  let adminUserId: string;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceName: '设备目录测试',
      workspaceSlug: 'device-directory-test',
    });
    adminUserId = (
      await bootstrapFirstAdmin(pool, {
        displayName: '设备目录管理员',
        email: 'device-directory-admin@example.test',
        password: 'StrongDeviceAdmin2026',
        workspaceId,
      })
    ).userId;
    for (const [id, email, name] of [
      [operatorA, 'device-a@example.test', '设备运营甲'],
      [operatorB, 'device-b@example.test', '设备运营乙'],
    ] as const) {
      await pool.execute(
        `INSERT INTO users (id, email, password_hash, display_name)
         VALUES (?, ?, 'integration-test-only', ?)`,
        [id, email, name],
      );
      await pool.execute(
        `INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'operator')`,
        [workspaceId, id],
      );
    }
    await pool.execute(
      `INSERT INTO devices (id, workspace_id, owner_user_id, name, token_hash)
       VALUES (?, ?, ?, '甲的手动撤销设备', ?), (?, ?, ?, '甲的在用设备', ?), (?, ?, ?, '乙的停用级联设备', ?)`,
      [
        deviceManual,
        workspaceId,
        operatorA,
        `${'8'.repeat(63)}1`,
        deviceActive,
        workspaceId,
        operatorA,
        `${'8'.repeat(63)}2`,
        deviceCascaded,
        workspaceId,
        operatorB,
        `${'8'.repeat(63)}3`,
      ],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('主动撤销与停用级联都写入撤销时间，且不返回令牌材料', async () => {
    await revokeDevice(pool, workspaceId, deviceManual, adminUserId, 'admin');
    await disableUserAccount(pool, workspaceId, operatorB);

    const devices = await listWorkspaceDevices(pool, workspaceId, adminUserId, 'admin');
    const manual = devices.find((device) => device.id === deviceManual);
    const cascaded = devices.find((device) => device.id === deviceCascaded);

    expect(manual?.status).toBe('revoked');
    expect(manual?.revokedAt).toBeInstanceOf(Date);
    expect(cascaded?.status).toBe('revoked');
    expect(cascaded?.revokedAt).toBeInstanceOf(Date);
    for (const device of devices) {
      expect(Object.keys(device)).not.toContain('tokenHash');
      expect(Object.values(device).join('|')).not.toContain('8'.repeat(20));
    }
  });

  it('仍在用的设备没有撤销时间', async () => {
    const devices = await listWorkspaceDevices(pool, workspaceId, adminUserId, 'admin');
    const active = devices.find((device) => device.id === deviceActive);

    expect(active?.status).toBe('active');
    expect(active?.revokedAt).toBeNull();
  });

  it('非管理员只能看到自己名下的设备', async () => {
    const devices = await listWorkspaceDevices(pool, workspaceId, operatorA, 'operator');
    const ids = devices.map((device) => device.id).sort();

    expect(ids).toEqual([deviceActive, deviceManual].sort());
  });
});
