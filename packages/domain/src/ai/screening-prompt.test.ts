import { describe, expect, it } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';

import {
  AI_SCREENING_PROMPT_VERSION,
  buildAiScreeningPrompt,
  InvalidAiScreeningOutputError,
  parseAiScreeningResult,
} from './screening-prompt.js';

const uncertainResult = {
  amateurStatus: { confidence: 0.1, evidence: [], value: 'unknown' },
  contentTags: [],
  estimatedAge: { confidence: 0, evidence: [], reason: '公开证据不足', status: 'unknown' },
  riskFlags: [],
  schemaVersion: 1,
  suitability: { confidence: 0.2, evidence: [], value: 'review' },
  summary: '需要人工复核',
};

describe('versioned AI screening prompt', () => {
  it('embeds configured rules and explicitly requires unknown for insufficient evidence', () => {
    const prompt = buildAiScreeningPrompt(createDefaultCampaignRuleSet(), {
      biography: null,
      nickname: '某用户',
      postCaptions: [{ caption: '校园日常', id: 'post:1' }],
    });
    expect(prompt.promptVersion).toBe(AI_SCREENING_PROMPT_VERSION);
    expect(prompt.systemPrompt).toContain('证据不足时必须使用 unknown');
    expect(prompt.userText).toContain('18-24');
    expect(prompt.jsonSchema.schema).toMatchObject({ additionalProperties: false, type: 'object' });
  });

  it('accepts explicit uncertainty and rejects illegal or overconfident output', () => {
    expect(parseAiScreeningResult(JSON.stringify(uncertainResult))).toMatchObject(uncertainResult);
    expect(() => parseAiScreeningResult('not-json')).toThrow(InvalidAiScreeningOutputError);
    expect(() =>
      parseAiScreeningResult(
        JSON.stringify({
          ...uncertainResult,
          amateurStatus: { confidence: 1.5, evidence: [], value: 'likely-amateur' },
          hiddenExtraField: 'must fail closed',
        }),
      ),
    ).toThrow(InvalidAiScreeningOutputError);
  });
});
