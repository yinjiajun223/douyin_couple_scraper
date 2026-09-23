import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { CollectorRunProgress } from '@douyin/contracts';

import type { RecoveryPageType, RecoveryResult, RecoveryStage } from './recovery-controller.js';
import type { CollectionNavigationErrorCode, CollectionSafetyIssueCode } from './safety-gate.js';

const DEFAULT_MAX_BYTES = 1_024 * 1_024;
const DEFAULT_MAX_FILES = 3;

export interface RecoveryLogInput {
  at: string;
  browserGeneration: number;
  issueCode: CollectionSafetyIssueCode;
  navigationErrorCode?: CollectionNavigationErrorCode;
  pageType: RecoveryPageType;
  progress: CollectorRunProgress;
  result: RecoveryResult;
  runId: string;
  stage: RecoveryStage;
  statusCode?: number;
}

export class RecoveryEventLog {
  private readonly directory: string;
  private readonly target: string;

  public constructor(
    dataRoot: string,
    private readonly limits: { maxBytes: number; maxFiles: number } = {
      maxBytes: DEFAULT_MAX_BYTES,
      maxFiles: DEFAULT_MAX_FILES,
    },
  ) {
    this.directory = path.join(dataRoot, 'diagnostics');
    this.target = path.join(this.directory, 'recovery.jsonl');
  }

  public async append(input: RecoveryLogInput): Promise<void> {
    const safeEvent = {
      at: input.at,
      browserGeneration: Math.max(0, Math.trunc(input.browserGeneration)),
      issueCode: input.issueCode,
      ...(input.navigationErrorCode ? { navigationErrorCode: input.navigationErrorCode } : {}),
      pageType: input.pageType,
      progress: {
        candidatesFound: Math.max(0, Math.trunc(input.progress.candidatesFound)),
        creatorProfilesSeen: Math.max(0, Math.trunc(input.progress.creatorProfilesSeen)),
        elapsedSeconds: Math.max(0, Math.trunc(input.progress.elapsedSeconds)),
        feedItemsSeen: Math.max(0, Math.trunc(input.progress.feedItemsSeen)),
      },
      result: input.result,
      runId: input.runId,
      stage: input.stage,
      ...(input.statusCode === undefined ? {} : { statusCode: Math.trunc(input.statusCode) }),
    };
    const line = `${JSON.stringify(safeEvent)}\n`;
    await mkdir(this.directory, { recursive: true });
    if ((await this.currentSize()) + Buffer.byteLength(line, 'utf8') > this.limits.maxBytes) {
      await this.rotate();
    }
    await appendFile(this.target, line, { encoding: 'utf8', mode: 0o600 });
  }

  private async currentSize(): Promise<number> {
    try {
      return (await stat(this.target)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  private async rotate(): Promise<void> {
    const maxFiles = Math.max(1, Math.trunc(this.limits.maxFiles));
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? this.target : `${this.target}.${index - 1}`;
      const destination = `${this.target}.${index}`;
      await unlink(destination).catch(ignoreMissingFile);
      await rename(source, destination).catch(ignoreMissingFile);
    }
    if (maxFiles === 1) await unlink(this.target).catch(ignoreMissingFile);
  }
}

function ignoreMissingFile(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
