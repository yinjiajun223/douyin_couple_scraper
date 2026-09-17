export interface AiProviderRequest {
  imageUrls?: string[];
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  systemPrompt: string;
  userText: string;
}

export interface AiProviderResponse {
  content: string;
  finishReason: string | null;
  model: string;
  requestId: string | null;
  usage: {
    completionTokens: number | null;
    promptTokens: number | null;
    totalTokens: number | null;
  };
}

export interface AiProvider {
  complete(request: AiProviderRequest): Promise<AiProviderResponse>;
}

export interface OpenAiCompatibleProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  supportsImages: boolean;
  supportsJsonSchema: boolean;
  timeoutMs?: number;
}

type FetchPort = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Pick<Response, 'headers' | 'json' | 'ok' | 'status'>>;

export class AiProviderRequestError extends Error {
  public constructor(public readonly status: number) {
    super(`AI provider request failed with HTTP status ${status}.`);
    this.name = 'AiProviderRequestError';
  }
}

export class AiProviderTimeoutError extends Error {
  public constructor(public readonly timeoutMs: number) {
    super(`AI provider request timed out after ${timeoutMs}ms.`);
    this.name = 'AiProviderTimeoutError';
  }
}

export class AiProviderCapabilityError extends Error {
  public constructor(capability: 'images' | 'json_schema') {
    super(`AI provider connection does not declare ${capability} capability.`);
    this.name = 'AiProviderCapabilityError';
  }
}

export class OpenAiCompatibleProvider implements AiProvider {
  private readonly timeoutMs: number;

  public constructor(
    private readonly config: OpenAiCompatibleProviderConfig,
    private readonly fetcher: FetchPort = fetch,
  ) {
    new URL(config.baseUrl);
    if (!config.apiKey || !config.model) throw new TypeError('AI API key and model are required.');
    this.timeoutMs = config.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new RangeError('AI provider timeout must be between 1 and 120000 milliseconds.');
    }
  }

  public async complete(request: AiProviderRequest): Promise<AiProviderResponse> {
    if (request.imageUrls?.length && !this.config.supportsImages) {
      throw new AiProviderCapabilityError('images');
    }
    if (request.jsonSchema && !this.config.supportsJsonSchema) {
      throw new AiProviderCapabilityError('json_schema');
    }
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(openAiChatCompletionsUrl(this.config.baseUrl), {
        body: JSON.stringify({
          messages: [
            { content: request.systemPrompt, role: 'system' },
            {
              content: request.imageUrls?.length
                ? [
                    { text: request.userText, type: 'text' },
                    ...request.imageUrls.map((url) => ({
                      image_url: { detail: 'low', url },
                      type: 'image_url',
                    })),
                  ]
                : request.userText,
              role: 'user',
            },
          ],
          model: this.config.model,
          ...(request.jsonSchema
            ? {
                response_format: {
                  json_schema: {
                    name: request.jsonSchema.name,
                    schema: request.jsonSchema.schema,
                    strict: true,
                  },
                  type: 'json_schema',
                },
              }
            : {}),
          stream: false,
        }),
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        method: 'POST',
        signal: abortController.signal,
      });
      if (!response.ok) throw new AiProviderRequestError(response.status);
      const payload = (await response.json()) as {
        choices?: Array<{ finish_reason?: string | null; message?: { content?: string } }>;
        model?: string;
        usage?: { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number };
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new AiProviderRequestError(502);
      return {
        content,
        finishReason: payload.choices?.[0]?.finish_reason ?? null,
        model: payload.model ?? this.config.model,
        requestId: response.headers.get('x-request-id'),
        usage: {
          completionTokens: payload.usage?.completion_tokens ?? null,
          promptTokens: payload.usage?.prompt_tokens ?? null,
          totalTokens: payload.usage?.total_tokens ?? null,
        },
      };
    } catch (error) {
      if (abortController.signal.aborted) throw new AiProviderTimeoutError(this.timeoutMs);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function openAiChatCompletionsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const basePath = url.pathname.replace(/\/+$/u, '');
  url.pathname = `${basePath}${basePath.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
  url.search = '';
  url.hash = '';
  return url;
}
