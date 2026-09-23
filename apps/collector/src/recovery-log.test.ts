import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RecoveryEventLog } from './recovery-log.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('恢复事件脱敏日志', () => {
  it('仅写白名单字段并将日志限制为三个轮转文件', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'douyin-recovery-log-'));
    temporaryDirectories.push(dataRoot);
    const log = new RecoveryEventLog(dataRoot, { maxBytes: 340, maxFiles: 3 });
    const forbidden = {
      authorization: 'Bearer secret-token',
      bodyText: '服务异常 私密页面正文',
      cookie: 'sessionid=secret-cookie',
      deviceToken: 'device-token-secret',
      headers: { authorization: 'Bearer secret-token' },
      profileUrl: 'https://www.douyin.com/user/private-profile-address',
      responseBody: '完整响应体',
      title: '私密页面标题',
    };

    for (let index = 0; index < 12; index += 1) {
      await log.append({
        at: new Date(Date.UTC(2026, 8, 23, 0, 0, index)).toISOString(),
        browserGeneration: index,
        issueCode: 'transient_page_failure',
        navigationErrorCode: 'ERR_CONNECTION_RESET',
        pageType: 'profile',
        progress: {
          candidatesFound: 1,
          creatorProfilesSeen: index,
          elapsedSeconds: index * 60,
          feedItemsSeen: index,
        },
        result: 'waiting',
        runId: '00000000-0000-4000-8000-000000000030',
        stage: 'reload_page',
        statusCode: 503,
        ...forbidden,
      } as never);
    }

    const directory = path.join(dataRoot, 'diagnostics');
    const files = (await readdir(directory)).sort();
    expect(files).toEqual(['recovery.jsonl', 'recovery.jsonl.1', 'recovery.jsonl.2']);
    const combined = (
      await Promise.all(files.map((file) => readFile(path.join(directory, file), 'utf8')))
    ).join('\n');
    expect(combined).toContain('transient_page_failure');
    for (const secret of Object.values(forbidden).flatMap((value) =>
      typeof value === 'string' ? [value] : Object.values(value),
    )) {
      expect(combined).not.toContain(secret);
    }
    expect(combined).not.toMatch(
      /cookie|authorization|deviceToken|bodyText|responseBody|profileUrl|title/u,
    );
  });
});
