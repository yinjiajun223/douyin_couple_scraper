import type { CampaignRuleSet } from '@douyin/contracts';
import { aiScreeningResultSchema, parseCampaignRuleSet } from '@douyin/contracts';

export const AI_SCREENING_PROMPT_VERSION = 'douyin-screening-v1' as const;
export const AI_SCREENING_RESULT_SCHEMA_VERSION = 1 as const;

export interface AiScreeningPrompt {
  jsonSchema: { name: string; schema: Record<string, unknown> };
  promptVersion: typeof AI_SCREENING_PROMPT_VERSION;
  resultSchemaVersion: typeof AI_SCREENING_RESULT_SCHEMA_VERSION;
  systemPrompt: string;
  userText: string;
}

export function buildAiScreeningPrompt(
  rawRules: CampaignRuleSet,
  publicEvidence: {
    biography: string | null;
    nickname: string;
    postCaptions: Array<{ id: string; caption: string | null }>;
  },
): AiScreeningPrompt {
  const rules = parseCampaignRuleSet(rawRules);
  const aiRules = rules.aiRules.map((rule) => {
    if (rule.type === 'estimated-age-band') {
      return { id: rule.id, type: rule.type, target: `${rule.minAge}-${rule.maxAge}` };
    }
    if (rule.type === 'content-fit') return { id: rule.id, type: rule.type, prompt: rule.prompt };
    return { id: rule.id, type: rule.type };
  });
  return {
    jsonSchema: { name: 'douyin_screening_result', schema: aiScreeningJsonSchema },
    promptVersion: AI_SCREENING_PROMPT_VERSION,
    resultSchemaVersion: AI_SCREENING_RESULT_SCHEMA_VERSION,
    systemPrompt: [
      '你是抖音博主合作筛选助手，只分析输入的公开资料。',
      '不得把猜测写成事实；证据不足时必须使用 unknown，并降低可信度。',
      '年龄只能作为疑似年龄段辅助判断，不能推断或输出其他敏感个人属性。',
      '每条依据的 sourceIds 必须引用输入中的证据 ID，不得编造来源。',
      '输出必须严格符合 JSON Schema，不要输出 Markdown 或额外字段。',
    ].join('\n'),
    userText: JSON.stringify({
      evidence: {
        biography: publicEvidence.biography,
        nickname: publicEvidence.nickname,
        posts: publicEvidence.postCaptions,
      },
      rules: aiRules,
    }),
  };
}

export function parseAiScreeningResult(rawContent: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new InvalidAiScreeningOutputError('AI 返回的内容不是合法 JSON');
  }
  const result = aiScreeningResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidAiScreeningOutputError('AI 返回内容不符合筛选结果 schema');
  }
  if (
    result.data.estimatedAge.status === 'estimated' &&
    result.data.estimatedAge.maximum < result.data.estimatedAge.minimum
  ) {
    throw new InvalidAiScreeningOutputError('AI 返回的年龄区间无效');
  }
  return result.data;
}

export class InvalidAiScreeningOutputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidAiScreeningOutputError';
  }
}

export const aiScreeningJsonSchema: Record<string, unknown> = {
  additionalProperties: false,
  properties: {
    amateurStatus: {
      additionalProperties: false,
      properties: {
        confidence: { maximum: 1, minimum: 0, type: 'number' },
        evidence: { items: { $ref: '#/$defs/evidence' }, maxItems: 20, type: 'array' },
        value: { enum: ['likely-amateur', 'likely-professional', 'unknown'], type: 'string' },
      },
      required: ['value', 'confidence', 'evidence'],
      type: 'object',
    },
    contentTags: {
      items: { maxLength: 100, minLength: 1, type: 'string' },
      maxItems: 30,
      type: 'array',
    },
    estimatedAge: {
      oneOf: [
        {
          additionalProperties: false,
          properties: {
            confidence: { maximum: 1, minimum: 0, type: 'number' },
            evidence: { items: { $ref: '#/$defs/evidence' }, maxItems: 20, type: 'array' },
            maximum: { maximum: 100, minimum: 13, type: 'integer' },
            minimum: { maximum: 100, minimum: 13, type: 'integer' },
            status: { const: 'estimated', type: 'string' },
          },
          required: ['status', 'minimum', 'maximum', 'confidence', 'evidence'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            confidence: { const: 0, type: 'number' },
            evidence: { items: { $ref: '#/$defs/evidence' }, maxItems: 20, type: 'array' },
            reason: { maxLength: 1000, minLength: 1, type: 'string' },
            status: { const: 'unknown', type: 'string' },
          },
          required: ['status', 'reason', 'confidence', 'evidence'],
          type: 'object',
        },
      ],
    },
    riskFlags: {
      items: {
        additionalProperties: false,
        properties: {
          code: { maxLength: 100, minLength: 1, type: 'string' },
          confidence: { maximum: 1, minimum: 0, type: 'number' },
          explanation: { maxLength: 1000, minLength: 1, type: 'string' },
          severity: { enum: ['info', 'warning', 'high'], type: 'string' },
        },
        required: ['code', 'severity', 'explanation', 'confidence'],
        type: 'object',
      },
      type: 'array',
    },
    schemaVersion: { const: 1, type: 'integer' },
    suitability: {
      additionalProperties: false,
      properties: {
        confidence: { maximum: 1, minimum: 0, type: 'number' },
        evidence: { items: { $ref: '#/$defs/evidence' }, maxItems: 20, type: 'array' },
        value: { enum: ['recommended', 'review', 'not-recommended', 'unknown'], type: 'string' },
      },
      required: ['value', 'confidence', 'evidence'],
      type: 'object',
    },
    summary: { maxLength: 2000, minLength: 1, type: 'string' },
  },
  required: [
    'schemaVersion',
    'estimatedAge',
    'amateurStatus',
    'contentTags',
    'suitability',
    'riskFlags',
    'summary',
  ],
  type: 'object',
  $defs: {
    evidence: {
      additionalProperties: false,
      properties: {
        sourceIds: {
          items: { maxLength: 200, minLength: 1, type: 'string' },
          maxItems: 20,
          type: 'array',
        },
        statement: { maxLength: 1000, minLength: 1, type: 'string' },
      },
      required: ['statement', 'sourceIds'],
      type: 'object',
    },
  },
};
