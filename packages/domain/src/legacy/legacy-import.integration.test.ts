import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapFirstAdmin } from '../auth/bootstrap-admin.js';
import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import { importLegacyExport } from './legacy-import.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;
const repositorySamplePath = fileURLToPath(
  new URL('../../../../data/全部候选.json', import.meta.url),
);

describeWithMysql('legacy JSON/CSV import', () => {
  const workspaceId = '72000000-0000-4000-8000-000000000001';
  let actorUserId: string;
  let pool: Pool;
  let temporaryDirectory: string;

  beforeAll(async () => {
    pool = createMysqlPool(databaseUrl!);
    await runMigrations(pool);
    await seedInitialWorkspace(pool, {
      workspaceId,
      workspaceName: 'Legacy import integration',
      workspaceSlug: 'legacy-import-integration',
    });
    const admin = await bootstrapFirstAdmin(pool, {
      displayName: 'Legacy import admin',
      email: 'legacy-import@example.test',
      password: 'StrongLegacyImport2026',
      workspaceId,
    });
    actorUserId = admin.userId;
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'douyin-legacy-import-'));
  });

  afterAll(async () => {
    await pool.end();
    await rm(temporaryDirectory, { force: true, recursive: true });
  });

  it('imports through the normal ingestion path, keeps unknowns, skips screenshots and deduplicates reruns', async () => {
    const filePath = join(temporaryDirectory, 'legacy-sample.json');
    await writeFile(
      filePath,
      JSON.stringify([
        {
          collectedAt: '2026-09-09T08:38:40.247Z',
          followerCount: 73,
          followerRaw: '73\n',
          nickname: '影',
          profileUrl: 'https://www.douyin.com/user/self',
          screenshot: 'data/screenshots/legacy-profile.png',
        },
        {
          collectedAt: '2026-09-09T08:39:40.247Z',
          followerCount: 90,
          nickname: '同一链接的重复记录',
          profileUrl: 'https://www.douyin.com/user/self?from=search',
        },
        {
          nickname: '缺少粉丝和作品数据',
          profileUrl: 'https://www.douyin.com/user/unknown-fields',
        },
        { nickname: '非法记录', profileUrl: 'https://example.com/not-douyin' },
      ]),
      'utf8',
    );

    const first = await importLegacyExport(pool, { actorUserId, filePath, workspaceId });
    const second = await importLegacyExport(pool, { actorUserId, filePath, workspaceId });

    expect(first).toMatchObject({
      duplicateInputRecords: 1,
      existingImport: false,
      importedObservations: 2,
      invalidRecords: 1,
      skippedScreenshots: 1,
      sourceRecords: 4,
      uniqueCreators: 2,
    });
    expect(second).toMatchObject({
      duplicateInputRecords: 1,
      existingImport: true,
      importedObservations: 0,
      invalidRecords: 1,
      runId: first.runId,
      uniqueCreators: 2,
    });

    const [runs] = await pool.query<RowDataPacket[]>(
      'SELECT status, stop_reason, progress_json FROM collection_runs WHERE id = ?',
      [first.runId],
    );
    const [observations] = await pool.query<RowDataPacket[]>(
      `SELECT creators.platform_creator_id, observations.follower_count
       FROM creator_observations observations
       JOIN creators ON creators.id = observations.creator_id
       WHERE observations.workspace_id = ?
       ORDER BY creators.platform_creator_id`,
      [workspaceId],
    );
    const [candidates] = await pool.query<RowDataPacket[]>(
      `SELECT creators.platform_creator_id, candidates.hard_filter_status
       FROM campaign_candidates candidates
       JOIN creators ON creators.id = candidates.creator_id
       WHERE candidates.workspace_id = ?
       ORDER BY creators.platform_creator_id`,
      [workspaceId],
    );
    const [media] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM media_objects WHERE workspace_id = ?',
      [workspaceId],
    );
    expect(runs[0]).toMatchObject({ status: 'completed', stop_reason: 'legacy_import' });
    expect(runs[0]!.progress_json).toMatchObject({ legacyImport: true });
    expect(observations).toEqual([
      expect.objectContaining({ follower_count: 90 }),
      expect.objectContaining({ follower_count: null }),
    ]);
    expect(candidates).toEqual([
      expect.objectContaining({ hard_filter_status: 'unknown' }),
      expect.objectContaining({ hard_filter_status: 'unknown' }),
    ]);
    expect(media).toHaveLength(0);
  });

  (existsSync(repositorySamplePath) ? it : it.skip)(
    'imports the repository legacy sample and reports its exact count on repeat',
    async () => {
      const first = await importLegacyExport(pool, {
        actorUserId,
        filePath: repositorySamplePath,
        workspaceId,
      });
      const second = await importLegacyExport(pool, {
        actorUserId,
        filePath: repositorySamplePath,
        workspaceId,
      });
      expect(first).toMatchObject({
        duplicateInputRecords: 0,
        existingImport: false,
        importedObservations: 80,
        invalidRecords: 0,
        skippedScreenshots: 1,
        sourceRecords: 80,
        uniqueCreators: 80,
      });
      expect(second).toMatchObject({
        duplicateInputRecords: 0,
        existingImport: true,
        importedObservations: 0,
        runId: first.runId,
        sourceRecords: 80,
        uniqueCreators: 80,
      });
      const [sources] = await pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS source_count FROM run_creator_sources WHERE run_id = ?',
        [first.runId],
      );
      expect(Number(sources[0]!.source_count)).toBe(80);
    },
  );
});
