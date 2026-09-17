import { z } from 'zod';

export const API_VERSION = '1.0.0' as const;
export const COLLECTOR_PROTOCOL_VERSION = '1.0.0' as const;

const semanticVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/, '必须是语义化版本号');
const identifierSchema = z.string().min(1).max(200);
const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const collectorHelloSchema = z
  .object({
    protocolVersion: semanticVersionSchema,
    collectorVersion: semanticVersionSchema,
    parserVersion: semanticVersionSchema,
    deviceId: z.uuid(),
  })
  .strict();

export const postObservationSchema = z
  .object({
    platformPostId: identifierSchema,
    postUrl: z.url(),
    caption: z.string().max(5_000).nullable(),
    likeCount: z.number().int().nonnegative().nullable(),
    likeCountRaw: z.string().max(100).nullable(),
    publishedAt: isoDateTimeSchema.nullable(),
    observedAt: isoDateTimeSchema,
    screenshotLocalId: z.string().min(1).max(200).nullable(),
  })
  .strict();

export const creatorObservationSchema = z
  .object({
    observationId: z.uuid(),
    platform: z.literal('douyin'),
    platformCreatorId: identifierSchema,
    profileUrl: z.url(),
    nickname: z.string().min(1).max(200),
    biography: z.string().max(5_000).nullable(),
    followerCount: z.number().int().nonnegative().nullable(),
    followerCountRaw: z.string().max(100).nullable(),
    observedAt: isoDateTimeSchema,
    posts: z.array(postObservationSchema).max(200),
    postsWindowComplete: z.boolean().optional(),
    parserConfidence: z.number().min(0).max(1),
  })
  .strict();

export const collectorBatchSchema = z
  .object({
    protocolVersion: semanticVersionSchema,
    collectorVersion: semanticVersionSchema,
    parserVersion: semanticVersionSchema,
    deviceId: z.uuid(),
    runId: z.uuid(),
    idempotencyKey: z.string().min(16).max(200),
    observations: z.array(creatorObservationSchema).min(1).max(100),
  })
  .strict();

export const collectorRunProgressSchema = z
  .object({
    feedItemsSeen: z.number().int().nonnegative().max(10_000_000),
    creatorProfilesSeen: z.number().int().nonnegative().max(10_000_000),
    candidatesFound: z.number().int().nonnegative().max(10_000_000),
    elapsedSeconds: z.number().int().nonnegative().max(31_536_000),
  })
  .strict();

export const ingestionAcknowledgementSchema = z
  .object({
    idempotencyKey: z.string().min(16).max(200),
    duplicateBatch: z.boolean(),
    results: z.array(
      z
        .object({
          observationId: z.uuid(),
          status: z.enum(['accepted', 'duplicate', 'rejected']),
          reason: z.string().max(500).optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type CollectorHello = z.infer<typeof collectorHelloSchema>;
export type PostObservation = z.infer<typeof postObservationSchema>;
export type CreatorObservation = z.infer<typeof creatorObservationSchema>;
export type CollectorBatch = z.infer<typeof collectorBatchSchema>;
export type CollectorRunProgress = z.infer<typeof collectorRunProgressSchema>;
export type IngestionAcknowledgement = z.infer<typeof ingestionAcknowledgementSchema>;

export class IncompatibleCollectorProtocolError extends Error {
  constructor(readonly receivedVersion: string) {
    super(`不兼容的采集协议版本：${receivedVersion}；服务端要求 ${COLLECTOR_PROTOCOL_VERSION}`);
    this.name = 'IncompatibleCollectorProtocolError';
  }
}

export function assertCollectorProtocolCompatible(receivedVersion: string): void {
  const parsed = semanticVersionSchema.safeParse(receivedVersion);
  const supportedMajor = Number(COLLECTOR_PROTOCOL_VERSION.split('.')[0]);
  const receivedMajor = parsed.success ? Number(parsed.data.split('.')[0]) : Number.NaN;

  if (!parsed.success || receivedMajor !== supportedMajor) {
    throw new IncompatibleCollectorProtocolError(receivedVersion);
  }
}
