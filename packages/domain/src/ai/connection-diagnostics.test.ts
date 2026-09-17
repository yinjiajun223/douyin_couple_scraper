import { describe, expect, it } from 'vitest';

import type { AiProvider, AiProviderRequest, AiProviderResponse } from './provider.js';
import { diagnoseAiProvider } from './connection-diagnostics.js';

class PartialProvider implements AiProvider {
  public async complete(request: AiProviderRequest): Promise<AiProviderResponse> {
    if (request.imageUrls) throw new Error('image input rejected');
    return {
      content: request.jsonSchema ? '{"ok":true}' : 'ok',
      finishReason: 'stop',
      model: 'mock',
      requestId: null,
      usage: { completionTokens: null, promptTokens: null, totalTokens: null },
    };
  }
}

describe('AI connection diagnostics', () => {
  it('reports text, image, and structured JSON capabilities independently', async () => {
    await expect(
      diagnoseAiProvider(new PartialProvider(), { images: true, jsonSchema: true }),
    ).resolves.toEqual({
      images: {
        code: 'Error',
        message: 'image input rejected',
        status: 'failed',
      },
      jsonSchema: { status: 'passed' },
      overall: 'partial',
      text: { status: 'passed' },
    });
  });

  it('marks undeclared optional capabilities as unsupported instead of failed', async () => {
    const result = await diagnoseAiProvider(new PartialProvider(), {
      images: false,
      jsonSchema: false,
    });
    expect(result).toMatchObject({
      images: { status: 'unsupported' },
      jsonSchema: { status: 'unsupported' },
      overall: 'passed',
    });
  });
});
