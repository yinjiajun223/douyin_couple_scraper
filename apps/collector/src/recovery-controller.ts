import type { CollectionNavigationErrorCode, CollectionSafetyIssue } from './safety-gate.js';

export type RecoveryPageType = 'feed' | 'profile';
export type RecoveryStage =
  'circuit_open' | 'idle' | 'recreate_profile_page' | 'reload_page' | 'restart_browser';
export type RecoveryResult =
  'attempting' | 'cancelled' | 'exhausted' | 'idle' | 'recovered' | 'waiting';

export interface RecoveryCheckpoint {
  attemptCount: number;
  circuitBreakerCount: number;
  contextRestartTimestamps: string[];
  eventStartedAt: string | null;
  issueCode: CollectionSafetyIssue['code'] | null;
  lastRecoveredAt: string | null;
  lastResult: RecoveryResult;
  navigationErrorCode: CollectionNavigationErrorCode | null;
  nextAttemptAt: string | null;
  pageType: RecoveryPageType | null;
  stage: RecoveryStage;
  statusCode: number | null;
}

export interface RecoveryStep {
  baseDelayMs: number;
  stage: Exclude<RecoveryStage, 'circuit_open' | 'idle'>;
}

export const RECOVERY_STEPS: readonly RecoveryStep[] = [
  { baseDelayMs: 15_000, stage: 'reload_page' },
  { baseDelayMs: 60_000, stage: 'recreate_profile_page' },
  { baseDelayMs: 300_000, stage: 'restart_browser' },
];

export const RECOVERY_RECURRENCE_WINDOW_MS = 120_000;
export const RECOVERY_CIRCUIT_WINDOW_MS = 3_600_000;
export const RECOVERY_CONTEXT_RESTART_LIMIT = 3;

export function createIdleRecoveryCheckpoint(): RecoveryCheckpoint {
  return {
    attemptCount: 0,
    circuitBreakerCount: 0,
    contextRestartTimestamps: [],
    eventStartedAt: null,
    issueCode: null,
    lastRecoveredAt: null,
    lastResult: 'idle',
    navigationErrorCode: null,
    nextAttemptAt: null,
    pageType: null,
    stage: 'idle',
    statusCode: null,
  };
}

export function normalizeRecoveryCheckpoint(value: unknown): RecoveryCheckpoint {
  if (!value || typeof value !== 'object') return createIdleRecoveryCheckpoint();
  const input = value as Partial<RecoveryCheckpoint>;
  let stage: RecoveryStage = 'idle';
  if (input.stage === 'circuit_open') stage = 'circuit_open';
  else if (RECOVERY_STEPS.some((entry) => entry.stage === input.stage)) {
    stage = input.stage as RecoveryStage;
  }
  const result = ['attempting', 'cancelled', 'exhausted', 'idle', 'recovered', 'waiting'].includes(
    String(input.lastResult),
  )
    ? input.lastResult!
    : 'idle';
  return {
    attemptCount: Number.isInteger(input.attemptCount) ? Math.max(0, input.attemptCount!) : 0,
    circuitBreakerCount: Number.isInteger(input.circuitBreakerCount)
      ? Math.max(0, input.circuitBreakerCount!)
      : 0,
    contextRestartTimestamps: Array.isArray(input.contextRestartTimestamps)
      ? input.contextRestartTimestamps.filter((entry): entry is string => typeof entry === 'string')
      : [],
    eventStartedAt: typeof input.eventStartedAt === 'string' ? input.eventStartedAt : null,
    issueCode: isIssueCode(input.issueCode) ? input.issueCode : null,
    lastRecoveredAt: typeof input.lastRecoveredAt === 'string' ? input.lastRecoveredAt : null,
    lastResult: result,
    navigationErrorCode: isNavigationErrorCode(input.navigationErrorCode)
      ? input.navigationErrorCode
      : null,
    nextAttemptAt: typeof input.nextAttemptAt === 'string' ? input.nextAttemptAt : null,
    pageType: input.pageType === 'feed' || input.pageType === 'profile' ? input.pageType : null,
    stage,
    statusCode: Number.isInteger(input.statusCode) ? input.statusCode! : null,
  };
}

export function recoveryDelayMs(step: RecoveryStep, randomValue: number): number {
  const boundedRandom = Math.min(1, Math.max(0, randomValue));
  return step.baseDelayMs + Math.floor(step.baseDelayMs * 0.2 * boundedRandom);
}

export function recoveryStartIndex(state: RecoveryCheckpoint, nowMs: number): number {
  if (state.lastResult !== 'recovered' || !state.lastRecoveredAt) return 0;
  const recoveredAt = Date.parse(state.lastRecoveredAt);
  if (!Number.isFinite(recoveredAt) || nowMs - recoveredAt >= RECOVERY_RECURRENCE_WINDOW_MS)
    return 0;
  const previousIndex = RECOVERY_STEPS.findIndex((entry) => entry.stage === state.stage);
  return previousIndex < 0 ? 0 : Math.min(previousIndex + 1, RECOVERY_STEPS.length - 1);
}

export function recordContextRestart(
  state: RecoveryCheckpoint,
  nowMs: number,
): { circuitOpen: boolean; timestamps: string[] } {
  const timestamps = state.contextRestartTimestamps
    .map((entry) => Date.parse(entry))
    .filter((entry) => Number.isFinite(entry) && nowMs - entry < RECOVERY_CIRCUIT_WINDOW_MS)
    .concat(nowMs)
    .map((entry) => new Date(entry).toISOString());
  return {
    circuitOpen: timestamps.length >= RECOVERY_CONTEXT_RESTART_LIMIT,
    timestamps,
  };
}

function isIssueCode(value: unknown): value is CollectionSafetyIssue['code'] {
  return (
    value === 'captcha_required' ||
    value === 'login_required' ||
    value === 'low_parser_confidence' ||
    value === 'platform_restriction' ||
    value === 'transient_page_failure'
  );
}

function isNavigationErrorCode(value: unknown): value is CollectionNavigationErrorCode {
  return (
    value === 'ERR_CONNECTION_CLOSED' ||
    value === 'ERR_CONNECTION_RESET' ||
    value === 'ERR_TIMED_OUT' ||
    value === 'NAVIGATION_TIMEOUT'
  );
}
