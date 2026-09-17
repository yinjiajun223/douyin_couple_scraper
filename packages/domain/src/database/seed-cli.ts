import { createMysqlPool, runMigrations } from './migrations.js';
import { seedInitialWorkspace } from './seed.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('缺少 DATABASE_URL，未执行数据库初始化');
}

const pool = createMysqlPool(databaseUrl);

try {
  await runMigrations(pool);
  const result = await seedInitialWorkspace(pool, {
    ...(process.env.BOOTSTRAP_WORKSPACE_ID
      ? { workspaceId: process.env.BOOTSTRAP_WORKSPACE_ID }
      : {}),
    ...(process.env.BOOTSTRAP_WORKSPACE_SLUG
      ? { workspaceSlug: process.env.BOOTSTRAP_WORKSPACE_SLUG }
      : {}),
    ...(process.env.BOOTSTRAP_WORKSPACE_NAME
      ? { workspaceName: process.env.BOOTSTRAP_WORKSPACE_NAME }
      : {}),
  });
  console.log(JSON.stringify({ status: 'ok', ...result }));
} finally {
  await pool.end();
}
