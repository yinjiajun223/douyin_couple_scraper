import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export function loadLocalEnvironment(environmentFile) {
  Object.assign(process.env, parseEnv(readFileSync(environmentFile, 'utf8')));
}
