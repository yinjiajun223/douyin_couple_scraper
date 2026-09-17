import type { AiProvider } from './provider.js';

export type AiCapabilityTestStatus = 'passed' | 'failed' | 'unsupported';

export interface AiCapabilityTestResult {
  code?: string;
  message?: string;
  status: AiCapabilityTestStatus;
}

export interface AiConnectionTestResult {
  images: AiCapabilityTestResult;
  jsonSchema: AiCapabilityTestResult;
  overall: 'passed' | 'partial' | 'failed';
  text: AiCapabilityTestResult;
}

export async function diagnoseAiProvider(
  provider: AiProvider,
  capabilities: { images: boolean; jsonSchema: boolean },
): Promise<AiConnectionTestResult> {
  const text = await runCapability(() =>
    provider.complete({ systemPrompt: 'Reply briefly.', userText: 'Connection test' }),
  );
  const images = capabilities.images
    ? await runCapability(() =>
        provider.complete({
          imageUrls: [onePixelPngDataUrl],
          systemPrompt: 'Confirm that an image input was accepted.',
          userText: 'Image capability test',
        }),
      )
    : unsupported();
  const jsonSchema = capabilities.jsonSchema
    ? await runCapability(async () => {
        const response = await provider.complete({
          jsonSchema: {
            name: 'connection_test',
            schema: {
              additionalProperties: false,
              properties: { ok: { const: true, type: 'boolean' } },
              required: ['ok'],
              type: 'object',
            },
          },
          systemPrompt: 'Return the requested JSON object.',
          userText: 'Structured output capability test',
        });
        const parsed = JSON.parse(response.content) as { ok?: unknown };
        if (parsed.ok !== true) throw new InvalidStructuredCapabilityResponseError();
        return response;
      })
    : unsupported();
  const tested = [text, images, jsonSchema].filter((result) => result.status !== 'unsupported');
  const passed = tested.filter((result) => result.status === 'passed').length;
  return {
    images,
    jsonSchema,
    overall: passed === tested.length ? 'passed' : passed === 0 ? 'failed' : 'partial',
    text,
  };
}

class InvalidStructuredCapabilityResponseError extends Error {
  public constructor() {
    super('Provider returned invalid structured JSON for the capability test.');
    this.name = 'InvalidStructuredCapabilityResponseError';
  }
}

async function runCapability(work: () => Promise<unknown>): Promise<AiCapabilityTestResult> {
  try {
    await work();
    return { status: 'passed' };
  } catch (error) {
    return {
      code: error instanceof Error ? error.name : 'UnknownError',
      message: safeDiagnosticMessage(error),
      status: 'failed',
    };
  }
}

function safeDiagnosticMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown provider error.';
  return error.message.slice(0, 500);
}

function unsupported(): AiCapabilityTestResult {
  return { status: 'unsupported' };
}

const onePixelPngDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
