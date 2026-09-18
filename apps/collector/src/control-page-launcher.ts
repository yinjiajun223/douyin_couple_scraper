import { spawn } from 'node:child_process';

export function openCollectorControlPage(
  url: string,
  platform = process.platform,
  spawnProcess: typeof spawn = spawn,
): boolean {
  const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : '';
  if (!command) return false;

  const process = spawnProcess(command, [url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  process.once('error', () => undefined);
  process.unref();
  return true;
}
