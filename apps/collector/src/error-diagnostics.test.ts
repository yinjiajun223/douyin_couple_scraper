import { appendFile, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createErrorDiagnostic, ErrorDiagnosticLog } from './error-diagnostics.js';

const directories: string[] = [];
const runId = '00000000-0000-4000-8000-000000000020';
const now = Date.parse('2026-09-24T00:00:00.000Z');
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'douyin-error-diagnostics-'));
  directories.push(root);
  return root;
}

describe('本机错误诊断', () => {
  it('只保留白名单元数据，不记录消息、网址、身份信息或完整堆栈', () => {
    const error = Object.assign(new TypeError('Authorization Bearer private-marker'), {
      cause: Object.assign(new Error('Cookie private-marker'), { code: 'ECONNRESET' }),
      status: 503,
      stack:
        'TypeError: private-marker\n    at send (file:///C:/Users/private-marker/app/control-server.js:123:8)',
    });
    const event = createErrorDiagnostic(error, 'report_progress', runId, now);
    expect(event).toMatchObject({
      errorType: 'TypeError',
      code: 'ECONNRESET',
      statusCode: 503,
      origin: 'control-server.js:123:8',
    });
    expect(JSON.stringify(event)).not.toMatch(/private-marker|Authorization|Cookie|file:|Users/);
    expect(
      createErrorDiagnostic(
        { name: 'private-marker', code: 'private-marker', status: 'private-marker' },
        'collect',
        'private-marker',
        now,
      ),
    ).toMatchObject({
      errorType: 'UnknownError',
      code: 'UNCLASSIFIED',
      statusCode: null,
      runId: null,
    });
  });

  it.each([
    ['page.screenshot: Target page, context or browser has been closed', 'BROWSER_CLOSED'],
    [
      'page.evaluate: Execution context was destroyed, most likely because of a navigation',
      'EXECUTION_CONTEXT_DESTROYED',
    ],
    ['arbitrary private-marker', 'UNCLASSIFIED'],
  ])('将已知浏览器错误映射为固定代码：%s', (message, code) => {
    expect(createErrorDiagnostic(new Error(message), 'capture_screenshot', runId, now).code).toBe(
      code,
    );
  });

  it('从原因链提取代码时有深度上限，循环引用不会挂起', () => {
    const error = new Error('private-marker');
    error.cause = error;
    expect(createErrorDiagnostic(error, 'collect', runId, now).code).toBe('UNCLASSIFIED');
  });

  it('仅返回最近 20 条，重启读取时过滤损坏行与额外敏感字段', async () => {
    const root = await temporaryRoot();
    const log = new ErrorDiagnosticLog(root);
    const events = Array.from({ length: 25 }, (_, index) =>
      createErrorDiagnostic(new Error(), 'collect', runId, now + index),
    );
    for (const event of events) await log.append(event);
    await appendFile(
      path.join(root, 'diagnostics/errors.jsonl'),
      '\n{"broken":\n' +
        JSON.stringify({ ...events[24], id: 'not-a-uuid' }) +
        '\n' +
        JSON.stringify({
          ...events[24],
          code: 'private-marker',
          origin: 'private-marker',
          message: 'private-marker',
        }) +
        '\n',
    );
    const restored = await new ErrorDiagnosticLog(root).recent();
    expect(restored).toHaveLength(20);
    expect(restored[0]).toMatchObject({ code: 'UNCLASSIFIED', origin: null });
    expect(restored[1]?.id).toBe(events[24]?.id);
    expect(JSON.stringify(restored)).not.toContain('private-marker');
  });

  it('自动轮换，最多保留 3 个限额文件，读取顺序为新到旧', async () => {
    const root = await temporaryRoot();
    const event = createErrorDiagnostic(new Error(), 'collect', runId, now);
    const maxBytes = Buffer.byteLength(JSON.stringify(event) + '\n') + 1;
    const log = new ErrorDiagnosticLog(root, maxBytes);
    for (let index = 0; index < 6; index += 1)
      await log.append({ ...event, at: new Date(now + index).toISOString() });
    expect((await readdir(path.join(root, 'diagnostics'))).sort()).toEqual([
      'errors.jsonl',
      'errors.jsonl.1',
      'errors.jsonl.2',
    ]);
    for (const filename of ['errors.jsonl', 'errors.jsonl.1', 'errors.jsonl.2'])
      expect((await stat(path.join(root, 'diagnostics', filename))).size).toBeLessThanOrEqual(
        maxBytes,
      );
    expect((await log.recent()).map((entry) => entry.at)).toEqual(
      [5, 4, 3].map((index) => new Date(now + index).toISOString()),
    );
    expect(await readFile(path.join(root, 'diagnostics/errors.jsonl'), 'utf8')).not.toContain(
      'stack',
    );
  });

  it('上次退出留下半行内容时，新错误仍可持久化并读取', async () => {
    const root = await temporaryRoot();
    const log = new ErrorDiagnosticLog(root);
    const previous = createErrorDiagnostic(new Error(), 'collect', runId, now);
    await log.append(previous);
    await appendFile(path.join(root, 'diagnostics/errors.jsonl'), '{"interrupted":');
    const next = createErrorDiagnostic(new TypeError(), 'report_progress', runId, now + 1);
    await log.append(next);
    expect(await new ErrorDiagnosticLog(root).recent()).toEqual([next, previous]);
  });
});
