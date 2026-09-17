import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapFirstAdmin,
  createMysqlPool,
  CredentialCipher,
  runMigrations,
  seedInitialWorkspace,
} from '@douyin/domain';
import type { AiProviderRequest } from '@douyin/domain';

import { buildServer } from './server.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

describeWithMysql('AI connections API', () => {
  const workspaceId = '5b000000-0000-4000-8000-000000000001';
  const credentials = {
    displayName: 'AI API 管理员',
    email: 'ai-api-admin@example.test',
    password: 'StrongAiApiAdmin2026',
    workspaceId,
  };
  let pool: Pool;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceName: 'AI API 测试',
      workspaceSlug: 'ai-api-test',
    });
    await bootstrapFirstAdmin(pool, credentials);
  });

  afterAll(async () => pool.end());

  it('never returns the provider credential in create/list/error responses', async () => {
    const plaintext = 'api-plaintext-key-must-not-appear';
    const server = buildServer({
      aiProviderFactory: () => ({
        complete: async (request: AiProviderRequest) => {
          if (request.imageUrls) throw new Error('mock image failure');
          return {
            content: request.jsonSchema ? '{"ok":true}' : 'ok',
            finishReason: 'stop',
            model: 'mock',
            requestId: null,
            usage: { completionTokens: null, promptTokens: null, totalTokens: null },
          };
        },
      }),
      credentialCipher: CredentialCipher.fromSingleKey('c'.repeat(32)),
      logger: false,
      pool,
      secureCookies: true,
    });
    const login = await server.inject({
      method: 'POST',
      payload: {
        email: credentials.email,
        password: credentials.password,
        workspaceId,
      },
      url: '/auth/login',
    });
    expect(login.statusCode).toBe(200);
    const headers = {
      cookie: firstHeader(login.headers['set-cookie'])!.split(';')[0]!,
      'x-csrf-token': login.json().csrfToken as string,
    };
    const created = await server.inject({
      headers,
      method: 'POST',
      payload: {
        apiKey: plaintext,
        baseUrl: 'https://wrapped-provider.example/gateway/v1',
        label: '包层模型',
        model: 'wrapped-vision',
        supportsImages: true,
        supportsJsonSchema: true,
      },
      url: '/ai-connections',
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(plaintext);
    expect(created.json()).toMatchObject({ credential: 'configured' });

    const listed = await server.inject({ headers, method: 'GET', url: '/ai-connections' });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(plaintext);
    expect(listed.body).not.toMatch(/credential_(ciphertext|iv|auth_tag)/u);

    const tested = await server.inject({
      headers,
      method: 'POST',
      url: `/ai-connections/${created.json().id}/test`,
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      images: { status: 'failed' },
      jsonSchema: { status: 'passed' },
      overall: 'partial',
      text: { status: 'passed' },
    });

    const invalid = await server.inject({
      headers,
      method: 'POST',
      payload: { apiKey: plaintext, baseUrl: 'not-a-url', label: '坏配置', model: 'x' },
      url: '/ai-connections',
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain(plaintext);

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT HEX(credential_ciphertext) AS ciphertext FROM ai_connections WHERE id = ?',
      [created.json().id],
    );
    expect(JSON.stringify(rows)).not.toContain(plaintext);
    await server.close();
  });
});
