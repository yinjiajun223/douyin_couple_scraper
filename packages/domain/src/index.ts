export const DOMAIN_PACKAGE_VERSION = '0.1.0';

export {
  ConfigValidationError,
  parseApiConfig,
  parseCollectorConfig,
  parseWorkerConfig,
  redactSensitiveValues,
} from './config.js';
export type { ApiConfig, CollectorConfig, WorkerConfig } from './config.js';
export { createMysqlPool, runMigrations } from './database/migrations.js';
export type { MigrationResult } from './database/migrations.js';
export {
  DEFAULT_CAMPAIGN_TEMPLATE_ID,
  DEFAULT_WORKSPACE_ID,
  seedInitialWorkspace,
  WORKSPACE_ROLE_DEFINITIONS,
} from './database/seed.js';
export type { InitialWorkspaceSeedOptions, InitialWorkspaceSeedResult } from './database/seed.js';
export {
  AdminAlreadyBootstrappedError,
  AdminBootstrapLockError,
  bootstrapFirstAdmin,
} from './auth/bootstrap-admin.js';
export type { AdminBootstrapResult } from './auth/bootstrap-admin.js';
export {
  adminBootstrapInputSchema,
  hashPassword,
  strongPasswordSchema,
  verifyPassword,
} from './auth/passwords.js';
export type { AdminBootstrapInput } from './auth/passwords.js';
export {
  authenticateSession,
  deriveSessionCsrfToken,
  disableUserAccount,
  InvalidCredentialsError,
  isValidCsrfToken,
  loginWithPassword,
  revokeAllUserSessions,
  revokeSession,
  SESSION_TTL_SECONDS,
  UserNotFoundError,
} from './auth/sessions.js';
export type { LoginResult, SessionPrincipal } from './auth/sessions.js';
export {
  acceptInvitation,
  createInvitation,
  InvitationAlreadyUsedError,
  InvitationExpiredError,
  InvitationNotFoundError,
  InvitedEmailAlreadyExistsError,
} from './auth/invitations.js';
export type { AcceptInvitationResult, CreateInvitationResult } from './auth/invitations.js';
export {
  assertPermission,
  hasPermission,
  PermissionDeniedError,
  ROLE_PERMISSIONS,
} from './auth/permissions.js';
export type { Permission, WorkspaceRole } from './auth/permissions.js';
export {
  authenticateDevice,
  createDevicePairingCode,
  DeviceAccessDeniedError,
  DeviceNotActiveError,
  pairDevice,
  PairingCodeAlreadyUsedError,
  PairingCodeExpiredError,
  PairingCodeInvalidError,
  revokeDevice,
  rotateDeviceToken,
} from './auth/devices.js';
export type { DevicePrincipal, DeviceTokenResult, PairingCodeResult } from './auth/devices.js';
export { listAuditEvents, writeAuditEvent } from './audit/audit-events.js';
export type { AuditAction, AuditEventRecord, WriteAuditEventInput } from './audit/audit-events.js';
export { listWorkspaceDevices, listWorkspaceMembers } from './auth/directory.js';
export {
  archiveCampaign,
  archiveCampaignTemplate,
  CampaignRecordNotFoundError,
  CampaignVersionConflictError,
  copyCampaign,
  createCampaign,
  createCampaignTemplate,
  listCampaigns,
  listCampaignTemplates,
  updateCampaign,
  updateCampaignTemplate,
} from './campaigns/campaign-service.js';
export {
  assertRunStatusTransition,
  CampaignNotActiveError,
  canTransitionRunStatus,
  claimCollectionRun,
  COLLECTION_RUN_STATUSES,
  CollectionRunDeviceMismatchError,
  CollectionRunNotFoundError,
  CollectionRunNotRunningError,
  createCollectionRun,
  determineRunStopReason,
  InvalidRunStatusTransitionError,
  listCollectionRuns,
  listReadyCollectionRuns,
  listCollectorRuns,
  pauseCollectionRun,
  pauseCollectionRunByDevice,
  reportCollectionRunProgress,
  resumeCollectionRun,
  resumeCollectionRunByDevice,
  RunProgressRegressionError,
  startClaimedCollectionRun,
  terminateCollectionRun,
  terminateCollectionRunByDevice,
} from './campaigns/run-service.js';
export type {
  CollectionRunStatus,
  CollectionRunStopReason,
  CollectionRunSummary,
  CreatedCollectionRun,
  ReadyCollectionRun,
} from './campaigns/run-service.js';
export { evaluateHardFilters } from './screening/hard-filter.js';
export type {
  HardFilterEvidenceReference,
  HardFilterInput,
  HardFilterOutcome,
  HardFilterPostEvidence,
  HardFilterResult,
  HardRuleEvaluation,
} from './screening/hard-filter.js';
export { listRunObservedCreators } from './screening/run-observed-creators.js';
export type {
  ObservedCreatorRuleEvaluation,
  ObservedCreatorVerdict,
} from './screening/run-observed-creators.js';
export {
  CollectorDeviceIdentityMismatchError,
  CollectorRunAccessDeniedError,
  CollectorRunNotIngestibleError,
  ingestCollectorBatch,
  IngestionAlreadyProcessingError,
  IngestionIdempotencyConflictError,
} from './ingestion/collector-ingestion.js';
export {
  CandidateAccessDeniedError,
  assertCandidateAccess,
  candidateVisibilityPredicate,
  firstVisibleAtExpression,
  resolveCandidateScope,
  visibleObservationIdExpression,
} from './candidates/candidate-access.js';
export type { CandidateAccessContext, CandidateScope } from './candidates/candidate-access.js';
export {
  CandidateNotFoundError,
  getCandidateDetail,
  listCandidatePage,
  listCandidates,
} from './candidates/candidate-library.js';
export type {
  CandidateDetail,
  CandidateListItem,
  CandidatePage,
} from './candidates/candidate-library.js';
export {
  appendCandidateNote,
  canTransitionPipeline,
  CandidateVersionConflictError,
  CandidateWorkflowNotFoundError,
  getCandidateWorkflow,
  InvalidPipelineTransitionError,
  OutreachVersionConflictError,
  PIPELINE_STATUSES,
  submitManualReview,
  transitionCandidatePipeline,
  updateCandidateOutreach,
} from './candidates/candidate-workflow.js';
export type { ManualDecision, PipelineStatus } from './candidates/candidate-workflow.js';
export {
  CANDIDATE_EXPORT_HEADERS,
  exportCandidateCsv,
  toCsvCell,
} from './candidates/candidate-export.js';
export { getOperationsDashboard } from './dashboard/operations-dashboard.js';
export type { OperationsDashboard } from './dashboard/operations-dashboard.js';
export {
  AliyunObjectStorageClient,
  buildMediaObjectKey,
  EVIDENCE_IMAGE_MIME_TYPES,
  InvalidMediaUploadError,
  isMediaObjectKeyInScope,
  MAX_EVIDENCE_IMAGE_BYTES,
  MEDIA_PURPOSES,
  validateMediaUpload,
} from './media/object-storage.js';
export type {
  AliyunObjectStorageConfig,
  EvidenceImageMimeType,
  MediaObjectKeyInput,
  MediaPurpose,
  ObjectStorageClient,
  SignedGetRequest,
  SignedPutRequest,
  StoredObjectMetadata,
} from './media/object-storage.js';
export {
  confirmMediaUpload,
  issueMediaAccessUrl,
  issueMediaUpload,
  MediaConfirmationMismatchError,
  MediaObjectNotFoundError,
  MediaObservationAccessDeniedError,
  MediaRunAccessDeniedError,
  MediaRunNotAcceptingUploadError,
  MediaStoredObjectUnavailableError,
  MediaUploadExpiredError,
  PENDING_UPLOAD_TTL_MINUTES,
  SIGNED_DOWNLOAD_TTL_SECONDS,
  SIGNED_UPLOAD_TTL_SECONDS,
} from './media/media-service.js';
export {
  cleanupMediaObjects,
  DEFAULT_MEDIA_CLEANUP_BATCH_SIZE,
  DEFAULT_MEDIA_RETENTION_DAYS,
  DEFAULT_ORPHAN_MEDIA_GRACE_DAYS,
} from './media/media-cleanup.js';
export type { MediaCleanupOptions, MediaCleanupSummary } from './media/media-cleanup.js';
export { importLegacyExport, parseLegacyExport } from './legacy/legacy-import.js';
export type { LegacyCreatorRecord, LegacyImportReport } from './legacy/legacy-import.js';
export type {
  ConfirmedMediaUpload,
  IssuedMediaAccess,
  IssuedMediaUpload,
} from './media/media-service.js';
