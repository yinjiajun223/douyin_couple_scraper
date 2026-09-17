import { createMysqlPool, runMigrations } from '../database/migrations.js';
import { seedInitialWorkspace } from '../database/seed.js';
import { bootstrapFirstAdmin } from './bootstrap-admin.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('缺少 DATABASE_URL，未执行管理员初始化');

const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const displayName = process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (!email || !displayName || !password) {
  throw new Error(
    '缺少 BOOTSTRAP_ADMIN_EMAIL、BOOTSTRAP_ADMIN_DISPLAY_NAME 或 BOOTSTRAP_ADMIN_PASSWORD',
  );
}

const pool = createMysqlPool(databaseUrl);

try {
  await runMigrations(pool);
  const workspace = await seedInitialWorkspace(pool, {
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
  const result = await bootstrapFirstAdmin(pool, {
    workspaceId: workspace.workspaceId,
    email,
    displayName,
    password,
  });
  console.log(JSON.stringify({ status: result.status, userId: result.userId }));
} finally {
  await pool.end();
}
