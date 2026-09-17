import { z } from 'zod';

const evidenceSchema = z.object({
  statement: z.string().min(1).max(1_000),
  sourceIds: z.array(z.string().min(1).max(200)).max(20),
});

const confidenceSchema = z.number().min(0).max(1);

export const aiScreeningResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    estimatedAge: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('estimated'),
          minimum: z.number().int().min(13).max(100),
          maximum: z.number().int().min(13).max(100),
          confidence: confidenceSchema,
          evidence: z.array(evidenceSchema).max(20),
        })
        .strict(),
      z
        .object({
          status: z.literal('unknown'),
          reason: z.string().min(1).max(1_000),
          confidence: z.literal(0),
          evidence: z.array(evidenceSchema).max(20),
        })
        .strict(),
    ]),
    amateurStatus: z
      .object({
        value: z.enum(['likely-amateur', 'likely-professional', 'unknown']),
        confidence: confidenceSchema,
        evidence: z.array(evidenceSchema).max(20),
      })
      .strict(),
    contentTags: z.array(z.string().min(1).max(100)).max(30),
    suitability: z
      .object({
        value: z.enum(['recommended', 'review', 'not-recommended', 'unknown']),
        confidence: confidenceSchema,
        evidence: z.array(evidenceSchema).max(20),
      })
      .strict(),
    riskFlags: z.array(
      z
        .object({
          code: z.string().min(1).max(100),
          severity: z.enum(['info', 'warning', 'high']),
          explanation: z.string().min(1).max(1_000),
          confidence: confidenceSchema,
        })
        .strict(),
    ),
    summary: z.string().min(1).max(2_000),
  })
  .strict();

export type AiScreeningResult = z.infer<typeof aiScreeningResultSchema>;
