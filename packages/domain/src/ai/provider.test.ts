import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { AiProviderTimeoutError, OpenAiCompatibleProvider } from './provider.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('OpenAI-compatible provider', () => {
  it('支持自定义 base URL、模型、Bearer 鉴权、多模态和 JSON schema', async () => {
    let captured: {
      authorization: string | undefined;
      body: Record<string, unknown> | undefined;
      path: string | undefined;
    } = { authorization: undefined, body: undefined, path: undefined };
    const server = createServer(async (request, response) => {
      let rawBody = '';
      for await (const chunk of request) rawBody += String(chunk);
      captured = {
        authorization: request.headers.authorization,
        body: JSON.parse(rawBody) as Record<string, unknown>,
        path: request.url,
      };
      response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'request-1' });
      response.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '{"fit":"likely"}' } }],
          model: 'vendor-model-2026',
          usage: { completion_tokens: 8, prompt_tokens: 20, total_tokens: 28 },
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'vendor-secret-key',
      baseUrl: `http://127.0.0.1:${port}/company-proxy/v1`,
      model: 'vendor-model-2026',
      supportsImages: true,
      supportsJsonSchema: true,
      timeoutMs: 2_000,
    });

    await expect(
      provider.complete({
        imageUrls: ['https://private-oss.example/signed-image'],
        jsonSchema: {
          name: 'screening_result',
          schema: {
            additionalProperties: false,
            properties: { fit: { type: 'string' } },
            required: ['fit'],
            type: 'object',
          },
        },
        systemPrompt: '只返回结构化筛选结果。',
        userText: '分析公开主页。',
      }),
    ).resolves.toEqual({
      content: '{"fit":"likely"}',
      finishReason: 'stop',
      model: 'vendor-model-2026',
      requestId: 'request-1',
      usage: { completionTokens: 8, promptTokens: 20, totalTokens: 28 },
    });
    expect(captured.path).toBe('/company-proxy/v1/chat/completions');
    expect(captured.authorization).toBe('Bearer vendor-secret-key');
    expect(captured.body).toMatchObject({
      model: 'vendor-model-2026',
      response_format: {
        json_schema: { name: 'screening_result', strict: true },
        type: 'json_schema',
      },
    });
    expect(JSON.stringify(captured.body)).toContain('signed-image');
  });

  it('到达配置超时后主动中止请求并返回稳定错误类型', async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
      }, 100);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'vendor-secret-key',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'slow-model',
      supportsImages: false,
      supportsJsonSchema: false,
      timeoutMs: 20,
    });

    await expect(
      provider.complete({ systemPrompt: 'system', userText: 'test' }),
    ).rejects.toBeInstanceOf(AiProviderTimeoutError);
  });
});
