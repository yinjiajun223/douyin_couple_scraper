import { createHash } from 'node:crypto';

import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapFirstAdmin,
  createMysqlPool,
  runMigrations,
  seedInitialWorkspace,
} from '@douyin/domain';

import { buildServer } from './server.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

describeWithMysql('本地采集设备授权', () => {
  const workspaceId = '1b000000-0000-4000-8000-000000000001';
  const credentials = {
    workspaceId,
    email: 'device-admin@example.test',
    displayName: '设备管理员',
    password: 'StrongDeviceAdmin2026',
  };
  let pool: Pool;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'device-auth-test',
      workspaceName: '设备授权测试',
    });
    await bootstrapFirstAdmin(pool, credentials);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('配对码单次使用，令牌哈希保存且可轮换和撤销', async () => {
    const server = buildServer({ pool, logger: false, secureCookies: true });
    const login = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        workspaceId,
        email: credentials.email,
        password: credentials.password,
      },
    });
    const cookie = firstHeader(login.headers['set-cookie'])!.split(';')[0]!;
    const csrfToken = login.json().csrfToken as string;
    const browserHeaders = { cookie, 'x-csrf-token': csrfToken };

    const pairingCode = await server.inject({
      method: 'POST',
      url: '/devices/pairing-codes',
      headers: browserHeaders,
      payload: { expiresInMinutes: 10 },
    });
    expect(pairingCode.statusCode).toBe(201);

    const pairPayload = {
      code: pairingCode.json().code,
      name: '运营电脑一号',
      collectorVersion: '1.0.0',
      parserVersion: '1.0.0',
    };
    const paired = await server.inject({
      method: 'POST',
      url: '/collector/pair',
      payload: pairPayload,
    });
    expect(paired.statusCode).toBe(201);
    const deviceId = paired.json().deviceId as string;
    const firstToken = paired.json().token as string;

    const pairedAgain = await server.inject({
      method: 'POST',
      url: '/collector/pair',
      payload: pairPayload,
    });
    expect(pairedAgain.statusCode).toBe(409);

    const [storedDevices] = await pool.query<RowDataPacket[]>(
      'SELECT token_hash FROM devices WHERE id = ?',
      [deviceId],
    );
    expect(storedDevices[0]?.token_hash).toBe(
      createHash('sha256').update(firstToken).digest('hex'),
    );
    expect(storedDevices[0]?.token_hash).not.toBe(firstToken);

    const collectorMe = await server.inject({
      method: 'GET',
      url: '/collector/me',
      headers: { authorization: `Bearer ${firstToken}` },
    });
    expect(collectorMe.statusCode).toBe(200);

    const versionReport = await server.inject({
      method: 'GET',
      url: '/collector/runs/ready',
      headers: {
        authorization: `Bearer ${firstToken}`,
        'x-collector-protocol-version': '1.0.0',
        'x-collector-version': '1.2.0',
        'x-parser-version': '0.2.0',
      },
    });
    expect(versionReport.statusCode).toBe(200);
    const [reportedVersions] = await pool.query<RowDataPacket[]>(
      'SELECT collector_version, parser_version FROM devices WHERE id = ?',
      [deviceId],
    );
    expect(reportedVersions[0]).toMatchObject({
      collector_version: '1.2.0',
      parser_version: '0.2.0',
    });

    const incompatibleProtocol = await server.inject({
      method: 'GET',
      url: '/collector/runs/ready',
      headers: {
        authorization: `Bearer ${firstToken}`,
        'x-collector-protocol-version': '2.0.0',
        'x-collector-version': '1.2.0',
        'x-parser-version': '0.2.0',
      },
    });
    expect(incompatibleProtocol.statusCode).toBe(426);
    expect(incompatibleProtocol.json()).toMatchObject({
      code: 'COLLECTOR_UPGRADE_REQUIRED',
      requiredProtocolVersion: '1.0.0',
    });

    const strictServer = buildServer({
      collectorMinVersion: '9.0.0',
      pool,
      logger: false,
      secureCookies: true,
    });
    const outdatedCollector = await strictServer.inject({
      method: 'GET',
      url: '/collector/runs/ready',
      headers: {
        authorization: `Bearer ${firstToken}`,
        'x-collector-protocol-version': '1.0.0',
        'x-collector-version': '1.2.0',
        'x-parser-version': '0.2.0',
      },
    });
    expect(outdatedCollector.statusCode).toBe(426);
    expect(outdatedCollector.json()).toMatchObject({
      code: 'COLLECTOR_UPGRADE_REQUIRED',
      currentCollectorVersion: '1.2.0',
      minimumCollectorVersion: '9.0.0',
    });
    await strictServer.close();

    const memberEndpoint = await server.inject({
      method: 'POST',
      url: '/invitations',
      headers: { authorization: `Bearer ${firstToken}` },
      payload: { email: 'forbidden@example.test', role: 'operator', expiresInHours: 1 },
    });
    expect(memberEndpoint.statusCode).toBe(401);

    const rotated = await server.inject({
      method: 'POST',
      url: `/devices/${deviceId}/rotate-token`,
      headers: browserHeaders,
    });
    expect(rotated.statusCode).toBe(200);
    const secondToken = rotated.json().token as string;
    expect(secondToken).not.toBe(firstToken);

    const oldToken = await server.inject({
      method: 'GET',
      url: '/collector/me',
      headers: { authorization: `Bearer ${firstToken}` },
    });
    const newToken = await server.inject({
      method: 'GET',
      url: '/collector/me',
      headers: { authorization: `Bearer ${secondToken}` },
    });
    expect(oldToken.statusCode).toBe(401);
    expect(newToken.statusCode).toBe(200);

    const revoked = await server.inject({
      method: 'POST',
      url: `/devices/${deviceId}/revoke`,
      headers: browserHeaders,
    });
    expect(revoked.statusCode).toBe(204);
    const revokedToken = await server.inject({
      method: 'GET',
      url: '/collector/me',
      headers: { authorization: `Bearer ${secondToken}` },
    });
    expect(revokedToken.statusCode).toBe(401);
    await server.close();
  });
});
