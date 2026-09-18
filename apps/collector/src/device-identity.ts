import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface SecretProtector {
  protect(plaintext: Buffer): Promise<Buffer>;
  unprotect(ciphertext: Buffer): Promise<Buffer>;
}

export interface PairCollectorDeviceInput {
  apiBaseUrl: string;
  collectorVersion: string;
  deviceName: string;
  pairingCode: string;
  parserVersion: string;
}

export interface PairedCollectorDevice {
  deviceId: string;
}

interface PairingResponse {
  deviceId: string;
  token: string;
}

type FetchPort = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Pick<Response, 'json' | 'ok' | 'status'>>;

export class CollectorPairingError extends Error {
  public constructor(public readonly status: number) {
    super(`Collector pairing failed with HTTP status ${status}.`);
    this.name = 'CollectorPairingError';
  }
}

export class WindowsDpapiUnavailableError extends Error {
  public constructor() {
    super('Windows DPAPI is required to store the collector device token.');
    this.name = 'WindowsDpapiUnavailableError';
  }
}

export class MacOsKeychainUnavailableError extends Error {
  public constructor() {
    super('macOS Keychain is required to store the collector device token.');
    this.name = 'MacOsKeychainUnavailableError';
  }
}

export class UnsupportedCollectorPlatformError extends Error {
  public constructor(platform: NodeJS.Platform) {
    super(`Collector device token storage is not supported on ${platform}.`);
    this.name = 'UnsupportedCollectorPlatformError';
  }
}

export class WindowsDpapiProtector implements SecretProtector {
  public async protect(plaintext: Buffer): Promise<Buffer> {
    this.assertWindows();
    const protectedBase64 = await invokeDpapi('Protect', plaintext.toString('base64'));
    return Buffer.from(protectedBase64, 'base64');
  }

  public async unprotect(ciphertext: Buffer): Promise<Buffer> {
    this.assertWindows();
    const plaintextBase64 = await invokeDpapi('Unprotect', ciphertext.toString('base64'));
    return Buffer.from(plaintextBase64, 'base64');
  }

  private assertWindows(): void {
    if (process.platform !== 'win32') throw new WindowsDpapiUnavailableError();
  }
}

type ProcessRunner = (
  executable: string,
  arguments_: readonly string[],
  standardInput?: string,
) => Promise<string>;

const MACOS_KEYCHAIN_SERVICE = 'cn.yinjiajun.douyin-ops.collector';
const MACOS_KEYCHAIN_MARKER_VERSION = 'macos-keychain:v1';

export class MacOsKeychainProtector implements SecretProtector {
  private readonly account: string;

  public constructor(
    dataDirectory: string,
    private readonly runner: ProcessRunner = runProcess,
  ) {
    const identity = createHash('sha256').update(path.resolve(dataDirectory)).digest('hex');
    this.account = `collector-${identity.slice(0, 32)}`;
  }

  public async protect(plaintext: Buffer): Promise<Buffer> {
    this.assertMacOs();
    const encodedSecret = plaintext.toString('base64url');
    const command = [
      'add-generic-password',
      '-U',
      '-a',
      this.account,
      '-s',
      MACOS_KEYCHAIN_SERVICE,
      '-w',
      encodedSecret,
    ].join(' ');
    await this.runner('/usr/bin/security', ['-q', '-i'], `${command}\n`);
    return Buffer.from(`${MACOS_KEYCHAIN_MARKER_VERSION}:${this.account}\n`, 'utf8');
  }

  public async unprotect(ciphertext: Buffer): Promise<Buffer> {
    this.assertMacOs();
    const marker = ciphertext.toString('utf8').trim();
    if (marker !== `${MACOS_KEYCHAIN_MARKER_VERSION}:${this.account}`) {
      throw new Error('The macOS Keychain device-token marker is invalid.');
    }
    const encodedSecret = await this.runner('/usr/bin/security', [
      'find-generic-password',
      '-a',
      this.account,
      '-s',
      MACOS_KEYCHAIN_SERVICE,
      '-w',
    ]);
    if (!encodedSecret.trim()) throw new Error('The macOS Keychain device token is empty.');
    return Buffer.from(encodedSecret.trim(), 'base64url');
  }

  public async delete(): Promise<void> {
    this.assertMacOs();
    await this.runner('/usr/bin/security', [
      'delete-generic-password',
      '-a',
      this.account,
      '-s',
      MACOS_KEYCHAIN_SERVICE,
    ]);
  }

  private assertMacOs(): void {
    if (process.platform !== 'darwin') throw new MacOsKeychainUnavailableError();
  }
}

interface PlatformSecretProtector {
  filename: string;
  protector: SecretProtector;
}

export function createPlatformSecretProtector(
  dataDirectory: string,
  platform: NodeJS.Platform = process.platform,
): PlatformSecretProtector {
  if (platform === 'win32') {
    return { filename: 'device-token.dpapi', protector: new WindowsDpapiProtector() };
  }
  if (platform === 'darwin') {
    return {
      filename: 'device-token.keychain',
      protector: new MacOsKeychainProtector(dataDirectory),
    };
  }
  throw new UnsupportedCollectorPlatformError(platform);
}

export class DeviceTokenStore {
  private readonly tokenPath: string;
  private readonly protector: SecretProtector;
  private cachedToken: string | undefined;
  private loadingToken: Promise<string | null> | null = null;

  public constructor(dataDirectory: string, protector?: SecretProtector) {
    const selected = protector
      ? { filename: 'device-token.dpapi', protector }
      : createPlatformSecretProtector(dataDirectory);
    this.protector = selected.protector;
    this.tokenPath = path.join(path.resolve(dataDirectory), 'secrets', selected.filename);
  }

  public async save(token: string): Promise<void> {
    if (token.length < 24) throw new RangeError('Device token is too short.');
    const ciphertext = await this.protector.protect(Buffer.from(token, 'utf8'));
    await mkdir(path.dirname(this.tokenPath), { recursive: true });
    const temporaryPath = `${this.tokenPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, ciphertext, { mode: 0o600 });
    await rename(temporaryPath, this.tokenPath);
    this.cachedToken = token;
  }

  public async load(): Promise<string | null> {
    if (this.cachedToken) return this.cachedToken;
    if (this.loadingToken) return this.loadingToken;
    this.loadingToken = this.readToken();
    try {
      return await this.loadingToken;
    } finally {
      this.loadingToken = null;
    }
  }

  private async readToken(): Promise<string | null> {
    try {
      const ciphertext = await readFile(this.tokenPath);
      this.cachedToken = (await this.protector.unprotect(ciphertext)).toString('utf8');
      return this.cachedToken;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

export async function pairAndStoreCollectorDevice(
  input: PairCollectorDeviceInput,
  tokenStore: DeviceTokenStore,
  fetcher: FetchPort = fetch,
): Promise<PairedCollectorDevice> {
  const endpoint = new URL('/collector/pair', ensureTrailingSlash(input.apiBaseUrl));
  const response = await fetcher(endpoint, {
    body: JSON.stringify({
      code: input.pairingCode,
      collectorVersion: input.collectorVersion,
      name: input.deviceName,
      parserVersion: input.parserVersion,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new CollectorPairingError(response.status);

  const payload = (await response.json()) as Partial<PairingResponse>;
  if (typeof payload.deviceId !== 'string' || typeof payload.token !== 'string') {
    throw new CollectorPairingError(502);
  }
  await tokenStore.save(payload.token);
  return { deviceId: payload.deviceId };
}

export function redactCollectorSecrets<T>(value: T, secrets: readonly string[] = []): T {
  const sensitiveKeyPattern = /(authorization|cookie|password|secret|token|pairingCode)/iu;
  const visit = (entry: unknown, key?: string): unknown => {
    if (key && sensitiveKeyPattern.test(key)) return '[REDACTED]';
    if (typeof entry === 'string') {
      return secrets.reduce(
        (redacted, secret) => (secret ? redacted.replaceAll(secret, '[REDACTED]') : redacted),
        entry,
      );
    }
    if (Array.isArray(entry)) return entry.map((item) => visit(item));
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry).map(([childKey, child]) => [childKey, visit(child, childKey)]),
      );
    }
    return entry;
  };
  return visit(value) as T;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function invokeDpapi(operation: 'Protect' | 'Unprotect', inputBase64: string): Promise<string> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Security',
    '$inputText = [Console]::In.ReadToEnd()',
    '$bytes = [Convert]::FromBase64String($inputText)',
    `$outputBytes = [Security.Cryptography.ProtectedData]::${operation}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($outputBytes))',
  ].join('; ');

  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else
        reject(
          new Error(`Windows DPAPI operation failed (${code ?? 'unknown'}): ${stderr.trim()}`),
        );
    });
    child.stdin.end(inputBase64);
  });
}

function runProcess(
  executable: string,
  arguments_: readonly string[],
  standardInput = '',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stderr.resume();
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('error', () => {
      reject(new Error('Secure credential operation could not be started.'));
    });
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Secure credential operation failed (${code ?? 'unknown'}).`));
    });
    child.stdin.end(standardInput);
  });
}
