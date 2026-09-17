import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';
import {
  bootstrapFirstAdmin,
  cleanupMediaObjects,
  createMysqlPool,
  MAX_EVIDENCE_IMAGE_BYTES,
  runMigrations,
  seedInitialWorkspace,
  SIGNED_UPLOAD_TTL_SECONDS,
} from '@douyin/domain';
import type { ObjectStorageClient } from '@douyin/domain';

import { buildServer } from './server.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

describeWithMysql('OSS 素材签名上传 API', () => {
  const workspaceId = '6a000000-0000-4000-8000-000000000001';
  const creatorId = '6a000000-0000-4000-8000-000000000002';
  const creatorObservationId = '6a000000-0000-4000-8000-000000000003';
  const credentials = {
    workspaceId,
    email: 'media-upload-admin@example.test',
    displayName: '素材上传管理员',
    password: 'StrongMediaUploadAdmin2026',
  };
  const otherWorkspaceId = '6b000000-0000-4000-8000-000000000001';
  const otherCredentials = {
    workspaceId: otherWorkspaceId,
    email: 'other-media-admin@example.test',
    displayName: '其他工作区管理员',
    password: 'StrongOtherMediaAdmin2026',
  };
  let pool: Pool;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceSlug: 'media-upload-api-test',
      workspaceName: '素材上传 API 测试',
    });
    await bootstrapFirstAdmin(pool, credentials);
    await seedInitialWorkspace(pool, {
      workspaceId: otherWorkspaceId,
      workspaceSlug: 'other-media-api-test',
      workspaceName: '其他素材工作区',
    });
    await bootstrapFirstAdmin(pool, otherCredentials);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('只给领取当前运行的设备签发短期、单对象 PUT 地址', async () => {
    const createSignedPutUrl = vi
      .fn<ObjectStorageClient['createSignedPutUrl']>()
      .mockImplementation(
        async (input) => `https://private-oss.example/${input.objectKey}?signed=1`,
      );
    const createSignedGetUrl = vi
      .fn<ObjectStorageClient['createSignedGetUrl']>()
      .mockImplementation(async (input) => `https://private-oss.example/${input.objectKey}?get=1`);
    const headObject = vi.fn<ObjectStorageClient['headObject']>();
    const deleteObject = vi.fn<ObjectStorageClient['deleteObject']>();
    const storage: ObjectStorageClient = {
      createSignedGetUrl,
      createSignedPutUrl,
      deleteObject,
      headObject,
    };
    const server = buildServer({
      pool,
      logger: false,
      objectStorage: storage,
      secureCookies: true,
    });
    const login = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        workspaceId,
        email: credentials.email,
        password: credentials.password,
      },
    });
    const browserHeaders = {
      cookie: firstHeader(login.headers['set-cookie'])!.split(';')[0]!,
      'x-csrf-token': login.json().csrfToken as string,
    };
    const pairingCode = await server.inject({
      method: 'POST',
      url: '/devices/pairing-codes',
      headers: browserHeaders,
      payload: { expiresInMinutes: 10 },
    });
    const paired = await server.inject({
      method: 'POST',
      url: '/collector/pair',
      payload: {
        code: pairingCode.json().code,
        name: '素材上传测试电脑',
        collectorVersion: '1.0.0',
        parserVersion: '1.0.0',
      },
    });
    const deviceId = paired.json().deviceId as string;
    const collectorHeaders = { authorization: `Bearer ${paired.json().token as string}` };
    const campaign = await server.inject({
      method: 'POST',
      url: '/campaigns',
      headers: browserHeaders,
      payload: {
        name: '素材上传范围测试',
        recommendationProfileDescription: '校园推荐流',
        rules: createDefaultCampaignRuleSet(),
      },
    });
    const createdRun = await server.inject({
      method: 'POST',
      url: `/campaigns/${campaign.json().id}/runs`,
      headers: browserHeaders,
    });
    const runId = createdRun.json().id as string;
    await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/claim`,
      headers: collectorHeaders,
    });
    await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/start`,
      headers: collectorHeaders,
    });
    await pool.execute(
      `INSERT INTO creators
       (id, workspace_id, platform, platform_creator_id, canonical_profile_url,
        first_observed_at, last_observed_at)
       VALUES (?, ?, 'douyin', 'media-upload-creator', 'https://www.douyin.com/user/media-upload-creator',
               CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [creatorId, workspaceId],
    );
    await pool.execute(
      `INSERT INTO creator_observations
       (id, workspace_id, creator_id, run_id, device_id, nickname, follower_count,
        profile_url, parser_confidence, collector_version, parser_version, observed_at)
       VALUES (?, ?, ?, ?, ?, '测试达人', 1200,
               'https://www.douyin.com/user/media-upload-creator', 0.99, '1.0.0', '1.0.0',
               CURRENT_TIMESTAMP(3))`,
      [creatorObservationId, workspaceId, creatorId, runId, deviceId],
    );

    const requestPayload = {
      byteSize: 4_096,
      checksumSha256: 'a'.repeat(64),
      creatorObservationId,
      mimeType: 'image/png',
      purpose: 'profile_screenshot',
    };
    const issuedAt = Date.now();
    const response = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/media/uploads`,
      headers: collectorHeaders,
      payload: requestPayload,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      maxByteSize: MAX_EVIDENCE_IMAGE_BYTES,
      requiredHeaders: {
        'content-length': '4096',
        'content-type': 'image/png',
        'x-oss-meta-sha256': 'a'.repeat(64),
      },
    });
    expect(response.json().objectKey).toMatch(
      new RegExp(
        `^workspaces/${workspaceId}/runs/${runId}/media/[0-9a-f-]+-profile_screenshot\\.png$`,
      ),
    );
    expect(Date.parse(response.json().expiresAt)).toBeGreaterThanOrEqual(
      issuedAt + SIGNED_UPLOAD_TTL_SECONDS * 1_000 - 2_000,
    );
    expect(Date.parse(response.json().expiresAt)).toBeLessThanOrEqual(
      issuedAt + SIGNED_UPLOAD_TTL_SECONDS * 1_000 + 2_000,
    );
    expect(createSignedPutUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        byteSize: 4_096,
        expiresInSeconds: SIGNED_UPLOAD_TTL_SECONDS,
        objectKey: response.json().objectKey,
      }),
    );

    const attemptedObjectOverride = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/media/uploads`,
      headers: collectorHeaders,
      payload: {
        ...requestPayload,
        objectKey: `workspaces/${workspaceId}/runs/another-run/media/stolen.png`,
      },
    });
    expect(attemptedObjectOverride.statusCode).toBe(400);

    const attemptedExpiryOverride = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/media/uploads`,
      headers: collectorHeaders,
      payload: { ...requestPayload, expiresInSeconds: 86_400 },
    });
    expect(attemptedExpiryOverride.statusCode).toBe(400);

    const oversized = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/media/uploads`,
      headers: collectorHeaders,
      payload: { ...requestPayload, byteSize: MAX_EVIDENCE_IMAGE_BYTES + 1 },
    });
    expect(oversized.statusCode).toBe(400);

    const anotherRunId = '6a000000-0000-4000-8000-000000000099';
    const wrongRun = await server.inject({
      method: 'POST',
      url: `/collector/runs/${anotherRunId}/media/uploads`,
      headers: collectorHeaders,
      payload: requestPayload,
    });
    expect(wrongRun.statusCode).toBe(403);
    expect(wrongRun.json()).toMatchObject({ code: 'MEDIA_RUN_ACCESS_DENIED' });

    const [stored] = await pool.query<RowDataPacket[]>(
      `SELECT object_key, status, mime_type, byte_size, checksum_sha256
       FROM media_objects WHERE id = ?`,
      [response.json().id],
    );
    expect(stored[0]).toMatchObject({
      object_key: response.json().objectKey,
      status: 'pending',
      mime_type: 'image/png',
      byte_size: 4_096,
      checksum_sha256: 'a'.repeat(64),
    });

    const confirmationPayload = {
      byteSize: requestPayload.byteSize,
      checksumSha256: requestPayload.checksumSha256,
      creatorObservationId,
    };
    headObject.mockRejectedValueOnce(new Error('NoSuchKey'));
    const missingObject = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/media/${response.json().id}/confirm`,
      headers: collectorHeaders,
      payload: confirmationPayload,
    });
    expect(missingObject.statusCode).toBe(409);
    expect(missingObject.json()).toMatchObject({ code: 'MEDIA_STORED_OBJECT_UNAVAILABLE' });

    headObject.mockResolvedValueOnce({
      byteSize: requestPayload.byteSize,
      checksumSha256: 'b'.repeat(64),
      contentType: requestPayload.mimeType,
      etag: 'test-etag',
    });
    const mismatchedObject = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/media/${response.json().id}/confirm`,
      headers: collectorHeaders,
      payload: confirmationPayload,
    });
    expect(mismatchedObject.statusCode).toBe(409);
    expect(mismatchedObject.json()).toMatchObject({
      code: 'MEDIA_CONFIRMATION_MISMATCH',
      fields: ['storedChecksumSha256'],
    });
    const [stillPending] = await pool.query<RowDataPacket[]>(
      'SELECT status, confirmed_at FROM media_objects WHERE id = ?',
      [response.json().id],
    );
    expect(stillPending[0]).toMatchObject({ status: 'pending', confirmed_at: null });

    const wrongAssociation = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/media/${response.json().id}/confirm`,
      headers: collectorHeaders,
      payload: {
        ...confirmationPayload,
        creatorObservationId: '6a000000-0000-4000-8000-000000000098',
      },
    });
    expect(wrongAssociation.statusCode).toBe(403);

    headObject.mockResolvedValueOnce({
      byteSize: requestPayload.byteSize,
      checksumSha256: requestPayload.checksumSha256,
      contentType: requestPayload.mimeType,
      etag: 'confirmed-etag',
    });
    const confirmed = await server.inject({
      method: 'POST',
      url: `/collector/runs/${runId}/media/${response.json().id}/confirm`,
      headers: collectorHeaders,
      payload: confirmationPayload,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ id: response.json().id, status: 'confirmed' });
    const [confirmedRows] = await pool.query<RowDataPacket[]>(
      'SELECT status, confirmed_at, expires_at FROM media_objects WHERE id = ?',
      [response.json().id],
    );
    expect(confirmedRows[0]).toMatchObject({
      status: 'confirmed',
      confirmed_at: expect.any(Date),
      expires_at: null,
    });

    const unauthenticatedAccess = await server.inject({
      method: 'GET',
      url: `/media/${response.json().id}/access`,
    });
    expect(unauthenticatedAccess.statusCode).toBe(401);

    const memberAccess = await server.inject({
      method: 'GET',
      url: `/media/${response.json().id}/access`,
      headers: { cookie: browserHeaders.cookie },
    });
    expect(memberAccess.statusCode).toBe(200);
    expect(memberAccess.json()).toMatchObject({
      id: response.json().id,
      downloadUrl: expect.stringContaining('?get=1'),
    });
    expect(createSignedGetUrl).toHaveBeenCalledWith({
      expiresInSeconds: 120,
      objectKey: response.json().objectKey,
    });

    const otherLogin = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        workspaceId: otherWorkspaceId,
        email: otherCredentials.email,
        password: otherCredentials.password,
      },
    });
    const crossWorkspaceAccess = await server.inject({
      method: 'GET',
      url: `/media/${response.json().id}/access`,
      headers: { cookie: firstHeader(otherLogin.headers['set-cookie'])!.split(';')[0]! },
    });
    expect(crossWorkspaceAccess.statusCode).toBe(404);

    const currentUserId = login.json().user.id as string;
    await pool.execute('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?', [
      workspaceId,
      currentUserId,
    ]);
    const revokedMemberAccess = await server.inject({
      method: 'GET',
      url: `/media/${response.json().id}/access`,
      headers: { cookie: browserHeaders.cookie },
    });
    expect(revokedMemberAccess.statusCode).toBe(401);

    const pendingMediaId = '6a000000-0000-4000-8000-000000000004';
    const pendingObjectKey = `workspaces/${workspaceId}/runs/${runId}/media/${pendingMediaId}-diagnostic.webp`;
    await pool.execute(
      `UPDATE media_objects
       SET confirmed_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 10 DAY)
       WHERE id = ?`,
      [response.json().id],
    );
    await pool.execute(
      `INSERT INTO media_objects
       (id, workspace_id, creator_observation_id, object_key, purpose, mime_type,
        byte_size, checksum_sha256, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'diagnostic', 'image/webp', 2048, ?, 'pending',
               DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR),
               DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR))`,
      [pendingMediaId, workspaceId, creatorObservationId, pendingObjectKey, 'c'.repeat(64)],
    );
    const firstCleanup = await cleanupMediaObjects(pool, storage, {
      batchSize: 20,
      retentionDays: 1,
      workspaceId,
    });
    expect(firstCleanup).toMatchObject({
      deletedConfirmed: 0,
      deletedUnconfirmed: 1,
      failed: 0,
      preservedReferenced: 1,
    });
    expect(deleteObject).toHaveBeenCalledWith(pendingObjectKey);
    expect(deleteObject).not.toHaveBeenCalledWith(response.json().objectKey);

    await pool.execute(
      `UPDATE campaigns SET status = 'archived', archived_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [campaign.json().id],
    );
    const secondCleanup = await cleanupMediaObjects(pool, storage, {
      batchSize: 20,
      retentionDays: 1,
      workspaceId,
    });
    expect(secondCleanup.deletedConfirmed).toBe(1);
    expect(deleteObject).toHaveBeenCalledWith(response.json().objectKey);

    await server.close();
  });
});
