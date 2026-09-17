import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const composeFile = fileURLToPath(new URL('../infra/test/mysql.compose.yml', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error('无法定位当前 npm CLI');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} 执行失败，退出码 ${result.status ?? 'unknown'}`);
  }
}

try {
  run('docker', ['compose', '-f', composeFile, 'up', '-d', '--wait']);
  run(process.execPath, [npmCli, 'run', 'test:integration', '-w', '@douyin/domain'], {
    env: {
      ...process.env,
      MYSQL_TEST_URL: 'mysql://douyin_test:local-test-password@127.0.0.1:33307/douyin_ops_test',
    },
  });
  run(process.execPath, [npmCli, 'run', 'test:integration', '-w', '@douyin/api'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MYSQL_TEST_URL: 'mysql://douyin_test:local-test-password@127.0.0.1:33307/douyin_ops_test',
    },
  });
  run(process.execPath, [npmCli, 'exec', '--', 'playwright', 'test', 'tests/local-flow.e2e.spec.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MYSQL_TEST_URL: 'mysql://douyin_test:local-test-password@127.0.0.1:33307/douyin_ops_test',
    },
  });
} finally {
  run('docker', ['compose', '-f', composeFile, 'down', '--volumes', '--remove-orphans']);
}
