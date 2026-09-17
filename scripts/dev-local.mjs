import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadLocalEnvironment } from './local-env.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const environmentFile = resolve(repositoryRoot, process.env.LOCAL_ENV_FILE ?? '.env.local');
if (!existsSync(environmentFile)) {
  throw new Error('缺少 .env.local。请先复制示例并执行 npm run dev:setup。');
}
loadLocalEnvironment(environmentFile);
assertLocalEnvironment();

const nodeArguments = ['--enable-source-maps'];
const typescriptProjects = [
  'packages/contracts/tsconfig.json',
  'packages/platform-douyin/tsconfig.json',
  'packages/domain/tsconfig.json',
  'apps/api/tsconfig.json',
  'apps/worker/tsconfig.json',
  'apps/collector/tsconfig.json',
];
const children = [];
let stopping = false;

runBuild();
start('types', process.execPath, [
  resolve(repositoryRoot, 'node_modules/typescript/bin/tsc'),
  '-b',
  ...typescriptProjects,
  '--watch',
  '--preserveWatchOutput',
]);
start('api', process.execPath, [...nodeArguments, '--watch', 'apps/api/dist/server.js']);
start('worker', process.execPath, [...nodeArguments, '--watch', 'apps/worker/dist/index.js']);
start('collector', process.execPath, [...nodeArguments, '--watch', 'apps/collector/dist/index.js']);
start('web', process.execPath, [
  resolve(repositoryRoot, 'node_modules/vite/bin/vite.js'),
  'apps/web',
  '--host',
  '127.0.0.1',
  '--port',
  '5173',
  '--strictPort',
]);

console.log('\n本地服务正在启动：');
console.log('管理后台：http://127.0.0.1:5173');
console.log('API 健康检查：http://127.0.0.1:3000/health/ready');
console.log('采集控制页：http://127.0.0.1:43127');
console.log('按 Ctrl+C 停止应用；MySQL 数据会保留。\n');

process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));

function assertLocalEnvironment() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'dev:local 的本地配置不能使用 NODE_ENV=production。请对照 .env.local.example 修正 .env.local，确认使用本地数据库配置。',
    );
  }
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  if (!['127.0.0.1', 'localhost'].includes(databaseUrl.hostname)) {
    throw new Error('dev:local 只允许连接本机 MySQL。');
  }
  const collectorApiUrl = new URL(process.env.COLLECTOR_API_BASE_URL ?? '');
  if (!['127.0.0.1', 'localhost'].includes(collectorApiUrl.hostname)) {
    throw new Error('dev:local 只允许 collector 连接本机 API。');
  }
}

function runBuild() {
  const result = spawnSync(
    process.execPath,
    [
      resolve(repositoryRoot, 'node_modules/typescript/bin/tsc'),
      '-b',
      ...typescriptProjects,
      '--pretty',
      'false',
    ],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('本地服务启动前构建失败。');
}

function start(name, command, arguments_) {
  const child = spawn(command, arguments_, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  pipeWithPrefix(child.stdout, name, console.log);
  pipeWithPrefix(child.stderr, name, console.error);
  child.once('error', (error) => {
    console.error(`[${name}] 启动失败：${error.message}`);
    stop(1);
  });
  child.once('exit', (code) => {
    if (!stopping) {
      console.error(`[${name}] 意外退出，代码 ${code ?? 'unknown'}。`);
      stop(code ?? 1);
    }
  });
}

function pipeWithPrefix(stream, name, writer) {
  const lines = createInterface({ input: stream });
  lines.on('line', (line) => writer(`[${name}] ${line}`));
}

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  console.log('\n正在停止本地应用……');
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => {
    process.exitCode = exitCode;
  }, 250);
}
