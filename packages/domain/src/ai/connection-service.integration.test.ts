import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapFirstAdmin } from '../auth/bootstrap-admin.js';
import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import {
  createAiConnection,
  listAiConnections,
  loadAiProviderConfig,
  rotateAiConnectionEncryption,
} from './connection-service.js';
import { CredentialCipher } from './credential-cipher.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('AI connection credential storage', () => {
  const workspaceId = '5a000000-0000-4000-8000-000000000001';
  const plaintext = 'provider-api-key-must-never-leak';
  let pool: Pool;
  let actorUserId: string;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceName: 'AI 连接测试',
      workspaceSlug: 'ai-connection-test',
    });
    actorUserId = (
      await bootstrapFirstAdmin(pool, {
        displayName: 'AI 管理员',
        email: 'ai-connection-admin@example.test',
        password: 'StrongAiConnectionAdmin2026',
        workspaceId,
      })
    ).userId;
  });

  afterAll(async () => pool.end());

  it('stores only ciphertext, returns redacted metadata, and rotates the envelope key', async () => {
    const oldCipher = new CredentialCipher({ activeVersion: 1, keys: { 1: 'a'.repeat(32) } });
    const created = await createAiConnection(pool, oldCipher, {
      actorUserId,
      apiKey: plaintext,
      baseUrl: 'https://company-gateway.example/v1',
      label: '公司模型网关',
      model: 'company-vision-model',
      supportsImages: true,
      supportsJsonSchema: true,
      workspaceId,
    });

    expect(JSON.stringify(created)).not.toContain(plaintext);
    expect(JSON.stringify(await listAiConnections(pool, workspaceId))).not.toContain(plaintext);
    expect((await loadAiProviderConfig(pool, oldCipher, workspaceId, created.id)).apiKey).toBe(
      plaintext,
    );

    const [storedBefore] = await pool.query<RowDataPacket[]>(
      `SELECT HEX(credential_ciphertext) AS ciphertext, credential_key_version
       FROM ai_connections WHERE id = ?`,
      [created.id],
    );
    expect(JSON.stringify(storedBefore)).not.toContain(plaintext);
    expect(storedBefore[0]?.credential_key_version).toBe(1);

    const rotatingCipher = new CredentialCipher({
      activeVersion: 2,
      keys: { 1: 'a'.repeat(32), 2: 'b'.repeat(32) },
    });
    expect(await rotateAiConnectionEncryption(pool, rotatingCipher, workspaceId)).toBe(1);
    const newOnlyCipher = new CredentialCipher({ activeVersion: 2, keys: { 2: 'b'.repeat(32) } });
    expect((await loadAiProviderConfig(pool, newOnlyCipher, workspaceId, created.id)).apiKey).toBe(
      plaintext,
    );

    const [storedAfter] = await pool.query<RowDataPacket[]>(
      `SELECT credential_key_version FROM ai_connections WHERE id = ?`,
      [created.id],
    );
    expect(storedAfter[0]?.credential_key_version).toBe(2);
    const [auditRows] = await pool.query<RowDataPacket[]>(
      `SELECT summary_json FROM audit_events
       WHERE workspace_id = ? AND subject_id = ? ORDER BY created_at DESC`,
      [workspaceId, created.id],
    );
    expect(JSON.stringify(auditRows)).not.toContain(plaintext);
    expect(auditRows[0]?.summary_json).toMatchObject({ apiKey: '[REDACTED]' });
  });
});
