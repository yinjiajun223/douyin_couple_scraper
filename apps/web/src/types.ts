import type { CampaignRuleSet } from '@douyin/contracts';

export type Role = 'admin' | 'operator' | 'readonly';

export type View =
  'today' | 'campaigns' | 'runs' | 'candidates' | 'members' | 'devices' | 'templates' | 'audit';

export interface CurrentUser {
  id: string;
  workspaceId: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface Member {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: 'active' | 'disabled';
}

export interface Device {
  id: string;
  name: string;
  ownerDisplayName: string;
  status: 'active' | 'revoked';
  collectorVersion: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface CampaignSummary {
  id: string;
  name: string;
  recommendation_profile_description: string | null;
  rules_json: CampaignRuleSet;
  source_template_id: string | null;
  status: 'active' | 'archived';
  version: number;
}

export interface RunSummary {
  id: string;
  campaignId: string;
  campaignName: string;
  ruleVersion: number;
  status: 'ready' | 'claimed' | 'running' | 'paused' | 'completed' | 'failed' | 'terminated';
  stopReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  progress: {
    feedItemsSeen: number;
    creatorProfilesSeen: number;
    candidatesFound: number;
    elapsedSeconds: number;
  };
  device: { id: string; name: string } | null;
  claimedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObservedCreatorVerdict {
  admitted: boolean;
  candidateId: string | null;
  creatorId: string;
  platformCreatorId: string;
  nickname: string;
  profileUrl: string;
  followerCount: number | null;
  followerCountRaw: string | null;
  observationId: string;
  observedAt: string;
  outcome: 'pass' | 'fail' | 'unknown';
  pipelineStatus: string | null;
  evaluations: Array<{
    ruleId: string;
    ruleType: 'follower-range' | 'recent-post-likes';
    outcome: 'pass' | 'fail' | 'unknown';
    evidence: Record<string, unknown>;
  }>;
}

export interface CandidateSummary {
  id: string;
  campaignName: string;
  nickname: string;
  biography: string | null;
  profileUrl: string;
  followerCount: number | null;
  firstVisibleAt: string;
  observedAt: string;
  manualDecision: 'pending' | 'approved' | 'rejected';
  pipelineStatus: string;
  tags: string[];
  ownerUserId?: string | null;
}

export interface DashboardSummary {
  failedRuns: number;
  myAssignments: number;
  pendingReview: number;
  runningRuns: number;
  toContact: number;
}

export interface CandidateDetailData {
  candidate: {
    id: string;
    campaignName: string;
    pipelineStatus: string;
    version?: number;
  };
  observations: Array<{
    id: string;
    nickname: string;
    biography: string | null;
    profileUrl: string;
    followerCount: number | null;
    followerCountRaw: string | null;
    observedAt: string;
    device: { id: string; name: string };
  }>;
  sources: Array<{
    runId: string;
    campaignName: string;
    device: { id: string; name: string };
    observationCount: number;
    lastObservedAt: string;
  }>;
  evaluations: Array<{
    id: string;
    ruleVersion: number;
    ruleKey: string;
    outcome: 'pass' | 'fail' | 'unknown';
    evidence: Record<string, unknown>;
    matchedPost: {
      observationId: string;
      url: string;
      likeCount: number | null;
      likeCountRaw: string | null;
      publishedAt: string | null;
    } | null;
    evaluatedAt: string;
  }>;
  media?: Array<{
    id: string;
    purpose: 'profile_screenshot' | 'post_screenshot';
    mimeType: string;
    createdAt: string;
  }>;
  workflow?: {
    candidateVersion: number;
    pipelineStatus: string;
    reviews: Array<{
      id: string;
      decision: 'pending' | 'approved' | 'rejected';
      reason: string | null;
      reviewerDisplayName: string;
      createdAt: string;
    }>;
    outreach: {
      ownerUserId: string | null;
      ownerDisplayName: string | null;
      contactChannel: string | null;
      contactValue: string | null;
      quotedAmount: number | null;
      currency: string | null;
      nextFollowUpAt: string | null;
      nextAction: string | null;
      version: number;
    } | null;
    notes: Array<{
      id: string;
      body: string;
      authorDisplayName: string;
      createdAt: string;
    }>;
    events: Array<{
      id: string;
      eventType: string;
      previousStatus: string | null;
      nextStatus: string | null;
      actorDisplayName: string | null;
      createdAt: string;
    }>;
  };
}

export interface CampaignTemplateSummary {
  id: string;
  name: string;
  description: string | null;
  rules_json: CampaignRuleSet;
  version: number;
}

// 与 `packages/domain/src/audit/audit-events.ts` 的 AuditAction 保持一致；
// 这里单独声明而不是跨包导入，因为 web 不能依赖服务端领域包。
export type AuditAction =
  | 'account.bootstrap_admin'
  | 'account.invitation_created'
  | 'account.invitation_accepted'
  | 'account.invitation_revoked'
  | 'account.disabled'
  | 'account.enabled'
  | 'account.role_changed'
  | 'campaign.rules_updated'
  | 'campaign.run_created'
  | 'campaign.run_status_changed'
  | 'device.pairing_code_created'
  | 'device.paired'
  | 'device.token_rotated'
  | 'device.revoked'
  | 'candidate.reviewed'
  | 'candidate.archived'
  | 'candidate.unarchived'
  | 'candidate.tags_changed'
  | 'outreach.status_changed'
  | 'export.created';

export type AuditSubjectType =
  | 'campaign'
  | 'candidate'
  | 'candidate_export'
  | 'collection_run'
  | 'device'
  | 'device_pairing_code'
  | 'invitation'
  | 'user';

export interface AuditEventSummary {
  id: string;
  action: string;
  subjectType: string;
  actorUserId: string | null;
  createdAt: string;
}
