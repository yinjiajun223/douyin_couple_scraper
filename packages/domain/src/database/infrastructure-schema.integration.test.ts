import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';

import { createMysqlPool, runMigrations } from './migrations.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('AI连接、后台任务与采集幂等数据模型', () => {
  const pool = createMysqlPool(databaseUrl!);
  const workspaceId = '14000000-0000-4000-8000-000000000001';
  const userId = '24000000-0000-4000-8000-000000000001';
  const deviceId = '34000000-0000-4000-8000-000000000001';
  const campaignId = '44000000-0000-4000-8000-000000000001';
  const ruleId = '44000000-0000-4000-8000-000000000002';
  const runId = '44000000-0000-4000-8000-000000000003';

  beforeAll(async () => {
    await runMigrations(pool);
    await pool.execute('INSERT INTO workspaces (id, slug, name) VALUES (?, ?, ?)', [
      workspaceId,
      'infrastructure-test',
      '基础设施测试',
    ]);
    await pool.execute(
      'INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)',
      [userId, 'infrastructure@example.test', 'argon2-test-hash', '系统管理员'],
    );
    await pool.execute(
      `INSERT INTO devices (id, workspace_id, owner_user_id, name, token_hash)
       VALUES (?, ?, ?, ?, ?)`,
      [deviceId, workspaceId, userId, '幂等测试设备', deviceId.replaceAll('-', '').padEnd(64, '0')],
    );
    const rules = JSON.stringify(createDefaultCampaignRuleSet());
    await pool.execute(
      `INSERT INTO campaigns
       (id, workspace_id, name, rule_schema_version, rules_json, created_by_user_id)
       VALUES (?, ?, '幂等测试任务', 1, ?, ?)`,
      [campaignId, workspaceId, rules, userId],
    );
    await pool.execute(
      `INSERT INTO campaign_rule_versions
       (id, workspace_id, campaign_id, version, rule_schema_version, rules_json, created_by_user_id)
       VALUES (?, ?, ?, 1, 1, ?, ?)`,
      [ruleId, workspaceId, campaignId, rules, userId],
    );
    await pool.execute(
      `INSERT INTO collection_runs
       (id, workspace_id, campaign_id, rule_version_id, progress_json, created_by_user_id)
       VALUES (?, ?, ?, ?, '{}', ?)`,
      [runId, workspaceId, campaignId, ruleId, userId],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('AI密钥仅接受加密材料而非明文凭据字段', async () => {
    await pool.execute(
      `INSERT INTO ai_connections
       (id, workspace_id, label, adapter_type, base_url, model, capabilities_json,
        limits_json, credential_ciphertext, credential_iv, credential_auth_tag,
        credential_key_version, created_by_user_id)
       VALUES (?, ?, ?, 'openai-compatible', ?, ?, '{}', '{}', ?, ?, ?, 1, ?)`,
      [
        '54000000-0000-4000-8000-000000000001',
        workspaceId,
        '备用服务商',
        'https://ai.example.test/v1',
        'vision-model',
        Buffer.from('encrypted-secret'),
        Buffer.alloc(12, 1),
        Buffer.alloc(16, 2),
        userId,
      ],
    );

    const [columns] = await pool.query<RowDataPacket[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'ai_connections'`,
    );
    const names = columns.map((row) => row.COLUMN_NAME ?? row.column_name);
    expect(names).toContain('credential_ciphertext');
    expect(names).not.toContain('api_key');
  });

  it('后台任务唯一键阻止同一最终结果被重复排队', async () => {
    const values = [
      '64000000-0000-4000-8000-000000000001',
      workspaceId,
      'ai-screening',
      'candidate:abc:prompt-v1',
      '{"candidateId":"abc"}',
    ];
    await pool.execute(
      `INSERT INTO background_jobs
       (id, workspace_id, job_type, deduplication_key, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
      values,
    );
    await expect(
      pool.execute(
        `INSERT INTO background_jobs
         (id, workspace_id, job_type, deduplication_key, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
        ['64000000-0000-4000-8000-000000000002', ...values.slice(1)],
      ),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT status, attempt_count, max_attempts, lease_owner, lease_expires_at FROM background_jobs WHERE id = ?',
      [values[0]],
    );
    expect(rows[0]).toEqual(
      expect.objectContaining({
        status: 'ready',
        attempt_count: 0,
        max_attempts: 5,
        lease_owner: null,
        lease_expires_at: null,
      }),
    );
  });

  it('同一设备重复上传幂等键只能保存一份最终回执', async () => {
    const values = [
      '74000000-0000-4000-8000-000000000001',
      workspaceId,
      deviceId,
      runId,
      'batch-20260915-00000001',
      'a'.repeat(64),
      '{"idempotencyKey":"batch-20260915-00000001","duplicateBatch":false,"results":[]}',
      '2026-09-16 10:00:00.000',
    ];
    await pool.execute(
      `INSERT INTO ingestion_keys
       (id, workspace_id, device_id, run_id, idempotency_key,
        request_checksum_sha256, status, acknowledgement_json, completed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, CURRENT_TIMESTAMP(3), ?)`,
      values,
    );
    await expect(
      pool.execute(
        `INSERT INTO ingestion_keys
         (id, workspace_id, device_id, run_id, idempotency_key,
          request_checksum_sha256, status, acknowledgement_json, completed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, CURRENT_TIMESTAMP(3), ?)`,
        ['74000000-0000-4000-8000-000000000002', ...values.slice(1)],
      ),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT acknowledgement_json FROM ingestion_keys WHERE workspace_id = ? AND device_id = ? AND idempotency_key = ?',
      [workspaceId, deviceId, values[4]],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.acknowledgement_json).toMatchObject({ duplicateBatch: false });
  });
});
