import { parseCollectorConfig } from '@douyin/domain/collector';
import {
  CollectorBrowserProfileStore,
  launchSelectedCollectorProfile,
} from './browser-profiles.js';
import {
  CollectorControlApiClient,
  createCollectorControlServer,
  listenCollectorControlServer,
} from './control-server.js';
import { DeviceTokenStore } from './device-identity.js';
import { CollectorRuntime } from './runtime.js';
import { uploadScreenshotEvidence } from './media-upload.js';

export {
  CollectorBrowserProfileStore,
  CollectorProfileNotFoundError,
  launchSelectedCollectorProfile,
  UnsafeCollectorDataDirectoryError,
} from './browser-profiles.js';
export type { CollectorBrowserProfile, PersistentBrowserLauncher } from './browser-profiles.js';
export {
  CollectorPairingError,
  createPlatformSecretProtector,
  DeviceTokenStore,
  MacOsKeychainProtector,
  MacOsKeychainUnavailableError,
  pairAndStoreCollectorDevice,
  redactCollectorSecrets,
  UnsupportedCollectorPlatformError,
  WindowsDpapiProtector,
  WindowsDpapiUnavailableError,
} from './device-identity.js';
export type {
  PairedCollectorDevice,
  PairCollectorDeviceInput,
  SecretProtector,
} from './device-identity.js';
export {
  CollectorControlApiClient,
  CollectorControlApiError,
  CollectorNotPairedError,
  CollectorUpgradeRequiredError,
  createCollectorControlServer,
  listenCollectorControlServer,
} from './control-server.js';
export type { CollectorControlApiPort, CollectorControlServerOptions } from './control-server.js';
export { COLLECTOR_VERSION } from './version.js';
export { COLLECTOR_CONTROL_HTML } from './control-page.js';
export { collectVisibleRecommendationFeed } from './recommendation-feed.js';
export type {
  RecommendationFeedOptions,
  RecommendationFeedPage,
  RecommendationFeedResult,
} from './recommendation-feed.js';
export {
  DouyinProfileIdentityMismatchError,
  inspectDouyinCreatorProfile,
} from './profile-inspection.js';
export type { DouyinProfileInspection, ProfileInspectionPage } from './profile-inspection.js';
export {
  applyCollectionSafetyGate,
  decideLowConfidenceAction,
  DEFAULT_LOW_CONFIDENCE_POLICY,
  detectCollectionSafetyIssue,
  DOUYIN_MIN_PARSER_CONFIDENCE,
  LOW_CONFIDENCE_CONSECUTIVE_LIMIT_MAX,
  parseLowConfidencePolicy,
  updateLowConfidenceConsecutiveFailures,
} from './safety-gate.js';
export {
  IngestionAcknowledgementMismatchError,
  PersistentIngestionQueue,
} from './ingestion-queue.js';
export { CollectorMediaUploadError, uploadScreenshotEvidence } from './media-upload.js';
export type { UploadedScreenshot, UploadScreenshotInput } from './media-upload.js';
export type {
  CollectorBatchSender,
  ProcessQueueOptions,
  ProcessQueueResult,
} from './ingestion-queue.js';
export type {
  CollectionPageSnapshot,
  CollectionSafetyIssue,
  CollectionSafetyIssueCode,
  LowConfidencePolicy,
  SafetyPausePersistence,
  SafetyPauseRunControl,
} from './safety-gate.js';

export function collectorStatus() {
  return { service: 'collector', status: 'awaiting-operator' as const };
}

async function start(): Promise<void> {
  const config = parseCollectorConfig(process.env);
  const profileStore = new CollectorBrowserProfileStore(config.COLLECTOR_DATA_DIR);
  const tokenStore = new DeviceTokenStore(config.COLLECTOR_DATA_DIR);
  const apiClient = new CollectorControlApiClient(config.COLLECTOR_API_BASE_URL, tokenStore);
  const runtime = new CollectorRuntime({
    apiClient,
    profileStore,
    launchProfile: launchSelectedCollectorProfile,
    uploadScreenshot: (input) =>
      uploadScreenshotEvidence({ ...input, apiBaseUrl: config.COLLECTOR_API_BASE_URL }, tokenStore),
  });
  const server = createCollectorControlServer({
    apiClient,
    runtime,
    profileStore,
  });
  await listenCollectorControlServer(server, config.COLLECTOR_CONTROL_PORT);
  console.log(
    JSON.stringify({
      ...collectorStatus(),
      controlUrl: `http://127.0.0.1:${config.COLLECTOR_CONTROL_PORT}`,
    }),
  );
}

if (process.env.NODE_ENV !== 'test') {
  await start();
}
