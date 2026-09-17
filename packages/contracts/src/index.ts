export const CONTRACT_PACKAGE_VERSION = '0.1.0';

export {
  API_VERSION,
  COLLECTOR_PROTOCOL_VERSION,
  assertCollectorProtocolCompatible,
  collectorBatchSchema,
  collectorHelloSchema,
  collectorRunProgressSchema,
  creatorObservationSchema,
  ingestionAcknowledgementSchema,
  IncompatibleCollectorProtocolError,
  postObservationSchema,
} from './collector.js';
export type {
  CollectorBatch,
  CollectorHello,
  CollectorRunProgress,
  CreatorObservation,
  IngestionAcknowledgement,
  PostObservation,
} from './collector.js';
export { aiScreeningResultSchema } from './ai.js';
export type { AiScreeningResult } from './ai.js';
export {
  CAMPAIGN_RULE_SCHEMA_VERSION,
  campaignRuleSetSchema,
  createDefaultCampaignRuleSet,
  parseCampaignRuleSet,
  UnsupportedCampaignRuleSchemaVersionError,
} from './rules.js';
export type { CampaignRuleSet } from './rules.js';
