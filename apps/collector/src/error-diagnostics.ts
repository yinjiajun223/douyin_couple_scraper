import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { COLLECTOR_VERSION } from './version.js';

const OPERATIONS = [
  'start',
  'collect',
  'open_browser',
  'read_feed',
  'inspect_profile',
  'check_safety',
  'check_feed_safety',
  'check_profile_safety',
  'capture_screenshot',
  'build_batch',
  'persist_queue',
  'sync_batch',
  'upload_evidence',
  'sync_runs',
  'get_device',
  'report_progress',
  'save_checkpoint',
  'scroll_feed',
] as const;
export type DiagnosticOperation = (typeof OPERATIONS)[number];
const ERROR_TYPES = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'TimeoutError',
  'AbortError',
  'ZodError',
  'CollectorControlApiError',
  'CollectorMediaUploadError',
  'CollectorNotPairedError',
  'CollectorUpgradeRequiredError',
  'IngestionAcknowledgementMismatchError',
  'UnknownError',
  'CollectionPausedError',
] as const;
const ERROR_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EBUSY',
  'EIO',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_RESET',
  'ERR_TIMED_OUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'api_request_failed',
  'invalid_signed_upload',
  'object_upload_failed',
  'unpaired_device',
  'BROWSER_CLOSED',
  'EXECUTION_CONTEXT_DESTROYED',
  'UNCLASSIFIED',
  'captcha_required',
  'login_required',
  'platform_restriction',
  'CAPTCHA_VERIFICATION_URL',
  'CAPTCHA_VISIBLE_DIALOG',
  'CAPTCHA_VISIBLE_WIDGET',
  'CAPTCHA_DOCUMENT_PROMPT',
] as const;
const ORIGIN =
  /(?:^|[/\\(\s])((?:runtime|profile-inspection|control-server|media-upload|ingestion-queue|recommendation-feed)\.(?:js|ts):\d{1,7}:\d{1,5})(?=[)\s]|$)/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_BYTES = 1_024 * 1_024;
const MAX_FILES = 3;
const MAX_RECENT = 20;

export interface ErrorDiagnostic {
  id: string;
  at: string;
  runId: string | null;
  collectorVersion: string;
  operation: DiagnosticOperation;
  errorType: string;
  code: string;
  statusCode: number | null;
  origin: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function allowed<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : fallback;
}

/** No messages, URLs, raw stacks, arbitrary names/codes or request metadata leave this boundary. */
export function createErrorDiagnostic(
  error: unknown,
  operation: DiagnosticOperation,
  runId: string,
  now: number,
): ErrorDiagnostic {
  const outer = record(error);
  let code: string = 'UNCLASSIFIED';
  let cause = outer;
  for (let depth = 0; depth < 4; depth += 1) {
    code = allowed(cause.code, ERROR_CODES, 'UNCLASSIFIED');
    if (code !== 'UNCLASSIFIED') break;
    cause = record(cause.cause);
  }
  if (code === 'UNCLASSIFIED' && typeof outer.message === 'string') {
    if (/^(?:[^\n]*: )?Target (?:page, context or browser|closed)/u.test(outer.message))
      code = 'BROWSER_CLOSED';
    else if (/Execution context was destroyed/u.test(outer.message))
      code = 'EXECUTION_CONTEXT_DESTROYED';
  }
  const status = outer.status;
  return {
    id: randomUUID(),
    at: new Date(now).toISOString(),
    runId: UUID.test(runId) ? runId : null,
    collectorVersion: COLLECTOR_VERSION,
    operation: allowed(operation, OPERATIONS, 'collect'),
    errorType: allowed(outer.name, ERROR_TYPES, 'UnknownError'),
    code,
    statusCode:
      typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : null,
    origin:
      typeof outer.stack === 'string'
        ? (outer.stack.split('\n').slice(1).join('\n').match(ORIGIN)?.[1] ?? null)
        : null,
  };
}

function parseDiagnostic(value: unknown): ErrorDiagnostic | null {
  const item = record(value);
  if (
    typeof item.id !== 'string' ||
    !UUID.test(item.id) ||
    typeof item.at !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(item.at) ||
    !Number.isFinite(Date.parse(item.at))
  )
    return null;
  return {
    id: item.id,
    at: item.at,
    runId: typeof item.runId === 'string' && UUID.test(item.runId) ? item.runId : null,
    collectorVersion:
      typeof item.collectorVersion === 'string' &&
      /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(item.collectorVersion)
        ? item.collectorVersion
        : 'unknown',
    operation: allowed(item.operation, OPERATIONS, 'collect'),
    errorType: allowed(item.errorType, ERROR_TYPES, 'UnknownError'),
    code: allowed(item.code, ERROR_CODES, 'UNCLASSIFIED'),
    statusCode:
      typeof item.statusCode === 'number' &&
      Number.isInteger(item.statusCode) &&
      item.statusCode >= 100 &&
      item.statusCode <= 599
        ? item.statusCode
        : null,
    origin:
      typeof item.origin === 'string' && item.origin.match(ORIGIN)?.[1] === item.origin
        ? item.origin
        : null,
  };
}

export class ErrorDiagnosticLog {
  private readonly target: string;
  public constructor(
    dataRoot: string,
    private readonly maxBytes = MAX_BYTES,
  ) {
    this.target = path.join(dataRoot, 'diagnostics', 'errors.jsonl');
  }

  public async append(event: ErrorDiagnostic): Promise<void> {
    const safe = parseDiagnostic(event);
    if (!safe) throw new Error('Invalid diagnostic metadata');
    // A preceding separator keeps the new event readable after an interrupted write.
    const line = `\n${JSON.stringify(safe)}\n`;
    if (Buffer.byteLength(line) > this.maxBytes) throw new Error('Diagnostic exceeds size limit');
    await mkdir(path.dirname(this.target), { recursive: true });
    let size = 0;
    try {
      size = (await stat(this.target)).size;
    } catch (error) {
      ignoreMissing(error);
    }
    if (size + Buffer.byteLength(line) > this.maxBytes) {
      for (let index = MAX_FILES - 1; index >= 1; index -= 1) {
        const source = index === 1 ? this.target : `${this.target}.${index - 1}`;
        const destination = `${this.target}.${index}`;
        await unlink(destination).catch(ignoreMissing);
        await rename(source, destination).catch(ignoreMissing);
      }
    }
    await appendFile(this.target, line, { encoding: 'utf8', mode: 0o600 });
  }

  public async recent(): Promise<ErrorDiagnostic[]> {
    const events: ErrorDiagnostic[] = [];
    for (let index = 0; index < MAX_FILES && events.length < MAX_RECENT; index += 1) {
      const file = index === 0 ? this.target : `${this.target}.${index}`;
      try {
        if ((await stat(file)).size > MAX_BYTES)
          throw new Error('Diagnostic log exceeds size limit');
        for (const line of (await readFile(file, 'utf8')).trim().split('\n').reverse()) {
          try {
            const event = parseDiagnostic(JSON.parse(line));
            if (event) events.push(event);
          } catch {
            /* Ignore incomplete lines from an interrupted append. */
          }
          if (events.length >= MAX_RECENT) break;
        }
      } catch (error) {
        ignoreMissing(error);
      }
    }
    return events;
  }
}

function ignoreMissing(error: unknown): void {
  if (record(error).code !== 'ENOENT') throw error;
}
