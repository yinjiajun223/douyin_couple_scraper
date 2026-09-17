import { createMysqlPool, runMigrations } from './migrations.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('缺少 DATABASE_URL，未执行数据库迁移');
}

const pool = createMysqlPool(databaseUrl);

try {
  const result = await runMigrations(pool);
  console.log(
    JSON.stringify({
      status: 'ok',
      applied: result.applied,
      skipped: result.skipped,
    }),
  );
} finally {
  await pool.end();
}
