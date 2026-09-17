import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMysqlPool, runMigrations } from './migrations.js';

const databaseUrl = process.env.MYSQL_TEST_URL;
const describeWithMysql = databaseUrl ? describe : describe.skip;

describeWithMysql('MySQL 8 迁移框架', () => {
  const pool = createMysqlPool(databaseUrl!);
  let migrationDirectory = '';

  beforeAll(async () => {
    migrationDirectory = await mkdtemp(join(tmpdir(), 'douyin-migrations-'));
    await writeFile(
      join(migrationDirectory, '0001_create_probe.sql'),
      `CREATE TABLE migration_probe (
        id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
        label VARCHAR(100) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`,
      'utf8',
    );
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS migration_probe');
    await pool.end();
    await rm(migrationDirectory, { recursive: true, force: true });
  });

  it('在空数据库应用迁移并记录版本', async () => {
    const result = await runMigrations(pool, migrationDirectory);
    const [tables] = await pool.query<RowDataPacket[]>("SHOW TABLES LIKE 'migration_probe'");
    const [versions] = await pool.query<RowDataPacket[]>(
      "SELECT version FROM schema_migrations WHERE version = '0001_create_probe.sql'",
    );

    expect(result).toEqual({ applied: ['0001_create_probe.sql'], skipped: [] });
    expect(tables).toHaveLength(1);
    expect(versions).toEqual([expect.objectContaining({ version: '0001_create_probe.sql' })]);
  });

  it('重复执行不会重复创建结构', async () => {
    const result = await runMigrations(pool, migrationDirectory);
    const [versions] = await pool.query<RowDataPacket[]>(
      "SELECT version FROM schema_migrations WHERE version = '0001_create_probe.sql'",
    );

    expect(result).toEqual({ applied: [], skipped: ['0001_create_probe.sql'] });
    expect(versions).toHaveLength(1);
  });
});
