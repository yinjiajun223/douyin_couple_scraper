import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { COLLECTOR_PROTOCOL_VERSION, ingestionAcknowledgementSchema } from '@douyin/contracts';
import type { CampaignRuleSet, CollectorBatch, CollectorRunProgress } from '@douyin/contracts';
import { DOUYIN_PARSER_VERSION } from '@douyin/platform-douyin';

import type { CollectorBrowserProfileStore } from './browser-profiles.js';
import { COLLECTOR_CONTROL_HTML } from './control-page.js';
import type { DeviceTokenStore } from './device-identity.js';
import { CollectorPairingError, pairAndStoreCollectorDevice } from './device-identity.js';
import type { CollectorRuntime } from './runtime.js';
import { COLLECTOR_VERSION } from './version.js';

export interface RemoteRun {
  campaignName?: string;
  id: string;
  progress?: CollectorRunProgress;
  rules?: CampaignRuleSet;
  status: string;
}

type FetchPort = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Pick<Response, 'json' | 'ok' | 'status'>>;

export class CollectorNotPairedError extends Error {
  public constructor() {
    super('请先使用管理员提供的配对码完成设备配对。');
    this.name = 'CollectorNotPairedError';
  }
}

export class CollectorControlApiError extends Error {
  public constructor(public readonly status: number) {
    super(
      status === 401
        ? '设备未配对或授权已撤销，请重新生成配对码。'
        : `中心服务请求失败（HTTP ${status}），请检查连接或刷新任务状态。`,
    );
    this.name = 'CollectorControlApiError';
  }
}

export class CollectorUpgradeRequiredError extends Error {
  public constructor(public readonly minimumVersion: string) {
    super(`采集助手版本过低，需要升级到 ${minimumVersion} 或更高版本后才能继续。`);
    this.name = 'CollectorUpgradeRequiredError';
  }
}

export class CollectorControlApiClient {
  public constructor(
    private readonly apiBaseUrl: string,
    private readonly tokenStore: DeviceTokenStore,
    private readonly fetcher: FetchPort = fetch,
  ) {}

  public async syncRuns(): Promise<RemoteRun[]> {
    const result = await this.request('/collector/runs', 'GET');
    return Array.isArray(result.runs) ? (result.runs as RemoteRun[]) : [];
  }

  public async startRun(runId: string, claim = true): Promise<RemoteRun> {
    if (claim) await this.request(`/collector/runs/${encodeURIComponent(runId)}/claim`, 'POST');
    return (await this.request(
      `/collector/runs/${encodeURIComponent(runId)}/start`,
      'POST',
    )) as unknown as RemoteRun;
  }

  public async pair(pairingCode: string, deviceName: string) {
    return pairAndStoreCollectorDevice(
      {
        apiBaseUrl: this.apiBaseUrl,
        pairingCode,
        deviceName,
        collectorVersion: COLLECTOR_VERSION,
        parserVersion: DOUYIN_PARSER_VERSION,
      },
      this.tokenStore,
      this.fetcher,
    );
  }

  public async getDevice(): Promise<{ deviceId: string; name: string }> {
    return (await this.request('/collector/me', 'GET')).device as {
      deviceId: string;
      name: string;
    };
  }

  public async sendBatch(batch: CollectorBatch) {
    return ingestionAcknowledgementSchema.parse(
      await this.request('/collector/ingestion/batches', 'POST', batch),
    );
  }

  public async reportProgress(runId: string, progress: CollectorRunProgress): Promise<RemoteRun> {
    return (await this.request(
      `/collector/runs/${encodeURIComponent(runId)}/progress`,
      'POST',
      progress,
    )) as unknown as RemoteRun;
  }

  public async changeRunStatus(
    runId: string,
    action: 'pause' | 'resume' | 'terminate',
  ): Promise<RemoteRun> {
    return (await this.request(
      `/collector/runs/${encodeURIComponent(runId)}/${action}`,
      'POST',
    )) as unknown as RemoteRun;
  }

  private async request(
    pathname: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const token = await this.tokenStore.load();
    if (!token) throw new CollectorNotPairedError();
    const response = await this.fetcher(new URL(pathname, this.apiBaseUrl), {
      headers: {
        authorization: `Bearer ${token}`,
        'x-collector-protocol-version': COLLECTOR_PROTOCOL_VERSION,
        'x-collector-version': COLLECTOR_VERSION,
        'x-parser-version': DOUYIN_PARSER_VERSION,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (response.status === 426) {
      throw new CollectorUpgradeRequiredError(String(payload.minimumCollectorVersion ?? '未知'));
    }
    if (!response.ok) throw new CollectorControlApiError(response.status);
    return payload;
  }
}

export interface CollectorControlApiPort {
  changeRunStatus(runId: string, action: 'pause' | 'resume' | 'terminate'): Promise<RemoteRun>;
  startRun(runId: string, claim?: boolean): Promise<RemoteRun>;
  syncRuns(): Promise<RemoteRun[]>;
}

export interface CollectorControlServerOptions {
  apiClient: CollectorControlApiClient;
  runtime: CollectorRuntime;
  profileStore: CollectorBrowserProfileStore;
}

export function createCollectorControlServer(options: CollectorControlServerOptions): Server {
  let mutating = false;
  return createServer(async (request, response) => {
    let acquired = false;
    try {
      const host = request.headers.host ?? '';
      if (
        !/^(127\.0\.0\.1|localhost)(:\d+)?$/u.test(host) ||
        (request.headers.origin && request.headers.origin !== `http://${host}`) ||
        request.headers['sec-fetch-site'] === 'cross-site'
      ) {
        return respondJson(response, 403, { message: '仅允许在本机控制页面操作。' });
      }
      if (
        request.method === 'POST' &&
        !request.headers['content-type']?.startsWith('application/json')
      ) {
        return respondJson(response, 415, { message: '需要 JSON 请求。' });
      }
      if (request.method === 'POST') {
        if (mutating)
          return respondJson(response, 409, { message: '另一个本机操作正在处理，请稍后重试。' });
        mutating = true;
        acquired = true;
      }
      await options.runtime.restore();
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/') {
        return respondHtml(response, COLLECTOR_CONTROL_HTML);
      }
      if (request.method === 'GET' && url.pathname === '/control/api/state') {
        let connectionError: string | undefined;
        let device: { deviceId: string; name: string } | undefined;
        let runs: RemoteRun[] = [];
        try {
          [device, runs] = await Promise.all([
            options.apiClient.getDevice(),
            options.apiClient.syncRuns(),
          ]);
        } catch (error) {
          connectionError = error instanceof Error ? error.message : '中心服务连接失败。';
        }
        const profiles = await options.profileStore.listProfiles();
        const selected = await options.profileStore.getSelectedProfile();
        return respondJson(response, 200, {
          ...(connectionError ? { connectionError } : {}),
          paired: Boolean(device),
          deviceName: device?.name,
          profiles: profiles.map(({ id, label }) => ({ id, label })),
          runs: options.runtime.decorateRuns(runs),
          runtime: await options.runtime.status(),
          selectedProfileId: selected?.id ?? null,
        });
      }
      if (request.method === 'POST' && url.pathname === '/control/api/pair') {
        options.runtime.assertIdle();
        const body = await readJsonBody(request);
        const deviceName = String(body.deviceName ?? '').trim();
        if (deviceName.length < 2) {
          return respondJson(response, 400, {
            code: 'INVALID_DEVICE_NAME',
            message: '设备名称至少需要 2 个字符。',
          });
        }
        return respondJson(
          response,
          200,
          await options.apiClient.pair(String(body.pairingCode ?? '').trim(), deviceName),
        );
      }
      if (request.method === 'POST' && url.pathname === '/control/api/profiles/open') {
        await options.runtime.openBrowser();
        return respondJson(response, 200, {
          message: '抖音已打开。请先人工登录并确认推荐内容，再开始运行。',
        });
      }
      if (request.method === 'POST' && url.pathname === '/control/api/profiles') {
        options.runtime.assertIdle();
        const body = await readJsonBody(request);
        const profile = await options.profileStore.createProfile(String(body.label ?? ''));
        return respondJson(response, 201, profile);
      }
      if (request.method === 'POST' && url.pathname === '/control/api/profiles/select') {
        options.runtime.assertIdle();
        await options.runtime.closeBrowser();
        const body = await readJsonBody(request);
        return respondJson(
          response,
          200,
          await options.profileStore.selectProfile(String(body.profileId ?? '')),
        );
      }
      if (request.method === 'POST' && url.pathname === '/control/api/settings/low-confidence') {
        const body = await readJsonBody(request);
        return respondJson(response, 200, {
          lowConfidencePolicy: await options.runtime.configureLowConfidencePolicy(body),
        });
      }
      const runAction = url.pathname.match(
        /^\/control\/api\/runs\/([^/]+)\/(start|pause|resume|terminate)$/u,
      );
      if (request.method === 'POST' && runAction?.[1] && runAction[2]) {
        const runId = decodeURIComponent(runAction[1]);
        const action = runAction[2] as 'pause' | 'resume' | 'start' | 'terminate';
        if (action === 'start') {
          await options.runtime.start(runId);
        } else {
          await options.runtime.control(runId, action);
        }
        return respondJson(response, 200, { id: runId });
      }
      return respondJson(response, 404, { code: 'NOT_FOUND' });
    } catch (error) {
      return respondJson(response, 400, {
        code: error instanceof Error ? error.name : 'CONTROL_ERROR',
        message:
          error instanceof CollectorPairingError
            ? '配对码无效、已使用或已过期，请在工作台重新生成后输入。'
            : error instanceof Error
              ? error.message
              : '本地控制操作失败。',
      });
    } finally {
      if (acquired) mutating = false;
    }
  });
}

export async function listenCollectorControlServer(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of request) {
    raw += String(chunk);
    if (raw.length > 64 * 1_024) throw new RangeError('请求内容过大。');
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function respondHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
  });
  response.end(html);
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}
