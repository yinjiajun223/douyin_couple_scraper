import type { CollectorRunProgress } from '@douyin/contracts';

export const DOUYIN_MIN_PARSER_CONFIDENCE = 0.75;
export const LOW_CONFIDENCE_CONSECUTIVE_LIMIT_MAX = 1_000;

export type LowConfidencePolicy =
  { consecutiveLimit: number; mode: 'pause_after_consecutive' } | { mode: 'never_pause' };

export const DEFAULT_LOW_CONFIDENCE_POLICY: LowConfidencePolicy = {
  mode: 'never_pause',
};

export type CollectionSafetyIssueCode =
  'abnormal_page' | 'captcha_required' | 'login_required' | 'low_parser_confidence';

export interface CollectionSafetyIssue {
  code: CollectionSafetyIssueCode;
  humanMessage: string;
}

export interface CollectionPageSnapshot {
  bodyText: string;
  parserConfidence?: number;
  statusCode?: number;
  title?: string;
  url: string;
}

export interface SafetyPausePersistence {
  saveSafetyPause(input: {
    issue: CollectionSafetyIssue;
    progress: CollectorRunProgress;
    runId: string;
  }): Promise<void>;
}

export interface SafetyPauseRunControl {
  changeRunStatus(runId: string, action: 'pause'): Promise<unknown>;
}

export function parseLowConfidencePolicy(input: unknown): LowConfidencePolicy {
  if (!input || typeof input !== 'object') return { ...DEFAULT_LOW_CONFIDENCE_POLICY };
  const value = input as Record<string, unknown>;
  if (value.mode === 'never_pause') return { mode: 'never_pause' };
  if (value.mode !== 'pause_after_consecutive') {
    throw new RangeError('低可信度处理方式无效。');
  }
  const consecutiveLimit = Number(value.consecutiveLimit);
  if (
    !Number.isInteger(consecutiveLimit) ||
    consecutiveLimit < 1 ||
    consecutiveLimit > LOW_CONFIDENCE_CONSECUTIVE_LIMIT_MAX
  ) {
    throw new RangeError(
      `连续低可信度暂停次数必须是 1-${LOW_CONFIDENCE_CONSECUTIVE_LIMIT_MAX} 的整数。`,
    );
  }
  return { consecutiveLimit, mode: 'pause_after_consecutive' };
}

export function decideLowConfidenceAction(
  policy: LowConfidencePolicy,
  consecutiveFailures: number,
): 'pause' | 'skip' {
  if (policy.mode === 'never_pause') return 'skip';
  return consecutiveFailures >= policy.consecutiveLimit ? 'pause' : 'skip';
}

export function updateLowConfidenceConsecutiveFailures(
  currentFailures: number,
  outcome: 'low_confidence' | 'trusted',
): number {
  return outcome === 'trusted' ? 0 : Math.max(0, currentFailures) + 1;
}

export function detectCollectionSafetyIssue(
  snapshot: CollectionPageSnapshot,
  minimumParserConfidence = DOUYIN_MIN_PARSER_CONFIDENCE,
): CollectionSafetyIssue | null {
  const searchable = `${snapshot.title ?? ''}\n${snapshot.bodyText}`;
  if (
    /\/login(?:[/?#]|$)/iu.test(snapshot.url) ||
    /(扫码登录|手机号登录|登录后继续|请先登录)/u.test(searchable)
  ) {
    return {
      code: 'login_required',
      humanMessage: '抖音登录状态已失效。进度已保存，请人工在可见浏览器中重新登录后手动继续。',
    };
  }
  if (/(安全验证|验证码|拖动滑块|完成验证|verifycenter)/iu.test(`${snapshot.url}\n${searchable}`)) {
    return {
      code: 'captcha_required',
      humanMessage: '抖音要求人工完成安全验证。进度已保存，采集已暂停，不会尝试绕过验证。',
    };
  }
  if (
    (snapshot.statusCode !== undefined && snapshot.statusCode >= 400) ||
    /(访问频繁|请求异常|页面不存在|网络错误|服务异常|账号异常)/u.test(searchable)
  ) {
    return {
      code: 'abnormal_page',
      humanMessage: '检测到抖音异常页面。进度已保存，请人工检查页面和账号状态后再继续。',
    };
  }
  if (
    snapshot.parserConfidence !== undefined &&
    snapshot.parserConfidence < minimumParserConfidence
  ) {
    return {
      code: 'low_parser_confidence',
      humanMessage: '页面解析可信度过低，本条数据不会写入。',
    };
  }
  return null;
}

export async function applyCollectionSafetyGate(input: {
  page: CollectionPageSnapshot;
  persistence: SafetyPausePersistence;
  progress: CollectorRunProgress;
  runControl: SafetyPauseRunControl;
  runId: string;
}): Promise<{ issue: CollectionSafetyIssue | null; status: 'continue' | 'paused' }> {
  const issue = detectCollectionSafetyIssue(input.page);
  if (!issue) return { issue: null, status: 'continue' };

  await input.persistence.saveSafetyPause({
    issue,
    progress: input.progress,
    runId: input.runId,
  });
  await input.runControl.changeRunStatus(input.runId, 'pause');
  return { issue, status: 'paused' };
}
