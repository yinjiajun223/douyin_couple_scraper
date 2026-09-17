import { resolve } from 'node:path';

import { createMysqlPool } from '../database/migrations.js';
import { importLegacyExport } from './legacy-import.js';

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const databaseUrl = process.env.DATABASE_URL;
const filePath = argument('--input');
const workspaceId = argument('--workspace-id');
const actorUserId = argument('--actor-user-id');
if (!databaseUrl || !filePath || !workspaceId || !actorUserId) {
  throw new Error(
    'Usage: DATABASE_URL=... npm run legacy:import -- --input <json-or-csv> --workspace-id <uuid> --actor-user-id <uuid>',
  );
}

const pool = createMysqlPool(databaseUrl);
try {
  const report = await importLegacyExport(pool, {
    actorUserId,
    filePath: resolve(filePath),
    workspaceId,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
