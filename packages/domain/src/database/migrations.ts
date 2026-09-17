import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, PoolOptions, RowDataPacket } from 'mysql2/promise';

const migrationFilePattern = /^\d{4}_[a-z0-9_]+\.sql$/;
const statementBreakpoint = /^\s*--\s*statement-breakpoint\s*$/mu;
const migrationLockName = 'douyin_ops_schema_migrations';

const createMigrationTableSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) NOT NULL PRIMARY KEY,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
`;

interface MigrationRow extends RowDataPacket {
  version: string;
  checksum: string;
}

interface LockRow extends RowDataPacket {
  acquired: number | null;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export function createMysqlPool(databaseUrl: string): Pool {
  const parsed = new URL(databaseUrl);
  const tlsMode = parsed.searchParams.get('ssl-mode')?.toUpperCase();
  parsed.searchParams.delete('ssl-mode');

  const options: PoolOptions = {
    uri: parsed.toString(),
    connectionLimit: 5,
    enableKeepAlive: true,
    timezone: 'Z',
    waitForConnections: true,
  };
  if (tlsMode === 'REQUIRED') {
    options.ssl = { rejectUnauthorized: true };
  }

  return mysql.createPool(options);
}

export function defaultMigrationDirectory(): string {
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}

async function loadMigrationFiles(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && migrationFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));

  return Promise.all(
    filenames.map(async (version) => {
      const sql = await readFile(join(directory, version), 'utf8');
      return {
        version,
        sql,
        checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
      };
    }),
  );
}

async function acquireMigrationLock(connection: PoolConnection) {
  const [rows] = await connection.query<LockRow[]>('SELECT GET_LOCK(?, 30) AS acquired', [
    migrationLockName,
  ]);
  if (rows[0]?.acquired !== 1) {
    throw new Error('无法取得数据库迁移锁');
  }
}

async function releaseMigrationLock(connection: PoolConnection) {
  await connection.query('SELECT RELEASE_LOCK(?)', [migrationLockName]);
}

export async function runMigrations(
  pool: Pool,
  directory = defaultMigrationDirectory(),
): Promise<MigrationResult> {
  const connection = await pool.getConnection();
  const result: MigrationResult = { applied: [], skipped: [] };
  let lockAcquired = false;

  try {
    await acquireMigrationLock(connection);
    lockAcquired = true;
    await connection.query(createMigrationTableSql);

    const [rows] = await connection.query<MigrationRow[]>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    const applied = new Map(rows.map((row) => [row.version, row.checksum]));
    const migrations = await loadMigrationFiles(directory);

    for (const migration of migrations) {
      const previousChecksum = applied.get(migration.version);
      if (previousChecksum) {
        if (previousChecksum !== migration.checksum) {
          throw new Error(`已应用迁移 ${migration.version} 的校验和发生变化`);
        }
        result.skipped.push(migration.version);
        continue;
      }

      const statements = migration.sql
        .split(statementBreakpoint)
        .map((statement) => statement.trim())
        .filter(Boolean);

      for (const statement of statements) {
        await connection.query(statement);
      }
      await connection.execute('INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)', [
        migration.version,
        migration.checksum,
      ]);
      result.applied.push(migration.version);
    }

    return result;
  } finally {
    if (lockAcquired) {
      await releaseMigrationLock(connection);
    }
    connection.release();
  }
}
