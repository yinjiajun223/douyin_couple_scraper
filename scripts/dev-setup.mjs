import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadLocalEnvironment } from './local-env.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const environmentFile = resolve(repositoryRoot, process.env.LOCAL_ENV_FILE ?? '.env.local');
const composeFile = resolve(repositoryRoot, 'infra/development/mysql.compose.yml');

if (!existsSync(environmentFile)) {
  throw new Error('缺少 .env.local。请先执行：Copy-Item .env.local.example .env.local');
}
loadLocalEnvironment(environmentFile);
assertLocalEnvironment();

run('docker', ['compose', '-f', composeFile, 'up', '-d', '--wait']);
runNpm(['run', 'build', '-w', '@douyin/contracts']);
runNpm(['run', 'build', '-w', '@douyin/platform-douyin']);
runNpm(['run', 'build', '-w', '@douyin/domain']);
runNpm(['run', 'bootstrap-admin', '-w', '@douyin/domain']);

console.log('\n本地数据库和首位管理员已准备完成。');
console.log(`管理员邮箱：${process.env.BOOTSTRAP_ADMIN_EMAIL}`);
console.log('管理员密码保存在 .env.local 的 BOOTSTRAP_ADMIN_PASSWORD。');
console.log('下一步执行：npm run dev:local');

function assertLocalEnvironment() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'dev:setup 的本地配置不能使用 NODE_ENV=production。请对照 .env.local.example 修正 .env.local，确认使用本地数据库配置。',
    );
  }
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  if (!['127.0.0.1', 'localhost'].includes(databaseUrl.hostname)) {
    throw new Error('dev:setup 只允许初始化本机 MySQL，不会操作远程 RDS。');
  }
  for (const name of [
    'BOOTSTRAP_ADMIN_EMAIL',
    'BOOTSTRAP_ADMIN_DISPLAY_NAME',
    'BOOTSTRAP_ADMIN_PASSWORD',
  ]) {
    if (!process.env[name]) throw new Error(`.env.local 缺少 ${name}。`);
  }
}

function runNpm(arguments_) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('无法定位 npm CLI，请通过 npm run dev:setup 执行。');
  run(process.execPath, [npmCli, ...arguments_]);
}

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} 执行失败，退出码 ${result.status ?? 'unknown'}。`);
  }
}
