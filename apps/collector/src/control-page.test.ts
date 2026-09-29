import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { COLLECTOR_CONTROL_HTML } from './control-page.js';

function renderPage() {
  const elements = new Map<
    string,
    {
      textContent: string;
      innerHTML: string;
      hidden: boolean;
      elements: unknown[];
      addEventListener: ReturnType<typeof vi.fn>;
    }
  >();
  const querySelector = (selector: string) => {
    if (!elements.has(selector))
      elements.set(selector, {
        textContent: '',
        innerHTML: '',
        hidden: false,
        elements: [],
        addEventListener: vi.fn(),
      });
    return elements.get(selector)!;
  };
  const script = COLLECTOR_CONTROL_HTML.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  if (!script) throw new Error('Control page script missing');
  const context = {
    document: { querySelector },
    fetch: () => new Promise(() => undefined),
    setTimeout: vi.fn(),
  };
  runInNewContext(script + '\nglobalThis.renderForTest = render;', context);
  const render = (context as typeof context & { renderForTest: (state: unknown) => void })
    .renderForTest;
  return { querySelector, render };
}

describe('本机诊断控制页', () => {
  it('下拉框和面板使用工作台统一视觉规范', () => {
    expect(COLLECTOR_CONTROL_HTML).toContain('--panel-radius: 8px 28px 8px 8px');
    expect(COLLECTOR_CONTROL_HTML).toContain('select { appearance: none;');
    expect(COLLECTOR_CONTROL_HTML).toContain('background-position: calc(100% - 17px) 18px');
  });

  it('展示当前步骤等待时长及暂停状态，历史恢复记录不充当当前故障', () => {
    const { render, querySelector } = renderPage();
    const state = {
      profiles: [],
      runs: [
        {
          id: 'run',
          status: 'running',
          recoverableSkips: {
            lastPageType: 'profile',
            lastReason: 'transient_page_failure',
            lastSkippedAt: '2026-09-24T03:59:00.000Z',
            total: 2,
          },
          recoveryDiagnostics: {
            issueCode: 'transient_page_failure',
            lastResult: 'exhausted',
            eventStartedAt: '2026-09-24T04:00:00.000Z',
          },
        },
      ],
      runtime: {
        activeRunId: 'run',
        stopping: true,
        currentOperation: {
          operation: 'inspect_profile',
          stage: 'responses',
          elapsedSeconds: 2,
        },
      },
    };
    render(state);
    expect(querySelector('#current-operation').hidden).toBe(false);
    expect(querySelector('#current-operation').textContent).toContain('正在暂停');
    expect(querySelector('#current-operation').textContent).toContain('作品接口正文');
    expect(querySelector('#current-operation').textContent).toContain('2 秒');
    expect(querySelector('#runs').innerHTML).toContain('最近一次恢复记录（不代表当前步骤）');
    expect(querySelector('#runs').innerHTML).toContain('<b>2</b>故障跳过');
    expect(querySelector('#runs').innerHTML).toContain('最近一次可恢复跳过（不代表当前步骤）');
    expect(querySelector('#runs').innerHTML).toContain('已跳过并继续');
    state.runtime.currentOperation.elapsedSeconds = 4;
    render(state);
    expect(querySelector('#current-operation').textContent).toContain('4 秒');
    render({ profiles: [], runs: [], runtime: {} });
    expect(querySelector('#current-operation').hidden).toBe(true);
  });

  it('用中文展示安全暂停对应页面与触发依据', () => {
    const { render, querySelector } = renderPage();
    render({
      profiles: [],
      runs: [],
      runtime: {
        errorDiagnostics: [
          {
            id: 'diagnostic-id',
            at: '2026-09-24T00:00:00.000Z',
            runId: 'run-id',
            operation: 'check_profile_safety',
            errorType: 'CollectionPausedError',
            code: 'CAPTCHA_VISIBLE_DIALOG',
            collectorVersion: '0.1.8',
          },
        ],
      },
    });
    expect(querySelector('#error-diagnostics').innerHTML).toContain('作者页安全检查');
    expect(querySelector('#error-diagnostics').innerHTML).toContain('触发依据：可见验证弹窗');
    expect(querySelector('#error-diagnostics').innerHTML).toContain('安全暂停');
  });

  it('即使没有任务或远端断网也展示历史，并转义诊断内容', () => {
    const { render, querySelector } = renderPage();
    render({
      profiles: [],
      runs: [],
      connectionError: '远端连接失败',
      runtime: {
        collectorVersion: '0.1.7',
        diagnosticStorageError: true,
        errorDiagnostics: [
          {
            id: 'diagnostic-id',
            at: '2026-09-24T00:00:00.000Z',
            runId: '<img src=x>',
            operation: 'report_progress',
            errorType: 'TypeError',
            code: 'ECONNRESET',
            statusCode: 503,
            collectorVersion: '0.1.7',
            origin: 'runtime.js:12:3',
          },
        ],
      },
    });
    expect(querySelector('#collector-version').textContent).toBe('v0.1.7');
    expect(querySelector('#diagnostic-storage-warning').hidden).toBe(false);
    expect(querySelector('#error-diagnostics').innerHTML).toContain('上报进度');
    expect(querySelector('#error-diagnostics').innerHTML).toContain('ECONNRESET');
    expect(querySelector('#error-diagnostics').innerHTML).toContain('HTTP 503');
    expect(querySelector('#error-diagnostics').innerHTML).toContain('&lt;img src=x&gt;');
    expect(querySelector('#error-diagnostics').innerHTML).not.toContain('<img');
  });

  it('兼容旧状态缺少诊断字段，正常显示空状态', () => {
    const { render, querySelector } = renderPage();
    render({ profiles: [], runs: [], runtime: {} });
    expect(querySelector('#error-diagnostics').innerHTML).toContain('旧版本发生的错误无法补录');
    expect(querySelector('#diagnostic-storage-warning').hidden).toBe(true);
  });
});
