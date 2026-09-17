import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { loadLocalEnvironment } from '../scripts/local-env.mjs';

const directory = mkdtempSync(join(tmpdir(), 'douyin-local-environment-'));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('local development environment', () => {
  it('loads development values over inherited production settings', () => {
    const file = join(directory, 'development.env');
    writeFileSync(
      file,
      'NODE_ENV=development\nDATABASE_URL=mysql://local:local@127.0.0.1:33306/douyin_ops_dev\n',
      'utf8',
    );
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'mysql://remote:remote@remote.invalid/production');

    loadLocalEnvironment(file);

    expect(process.env.NODE_ENV).toBe('development');
    expect(new URL(process.env.DATABASE_URL).hostname).toBe('127.0.0.1');
  });

  for (const script of ['dev-setup', 'dev-local']) {
    it(`${script} rejects a production template with an actionable message`, () => {
      const file = join(directory, `${script}-production.env`);
      writeFileSync(file, 'NODE_ENV=production\n', 'utf8');
      const result = runScript(script, file);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('.env.local.example');
      expect(result.stdout).not.toContain('本地服务正在启动');
    });

    it(`${script} still rejects a remote database from the local file`, () => {
      const file = join(directory, `${script}-remote.env`);
      writeFileSync(
        file,
        'NODE_ENV=development\nDATABASE_URL=mysql://local:local@remote.invalid/dev\n',
        'utf8',
      );
      const result = runScript(script, file);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('本机 MySQL');
      expect(result.stderr).not.toContain('mysql://');
    });
  }
});

function runScript(script, file) {
  return spawnSync(process.execPath, [`scripts/${script}.mjs`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, LOCAL_ENV_FILE: file, NODE_ENV: 'production' },
    timeout: 5_000,
  });
}
