import type { Role, RunSummary } from '../types';

export function manualDecisionLabel(decision: 'pending' | 'approved' | 'rejected') {
  return { approved: '通过', pending: '待定', rejected: '不符合' }[decision];
}

export function pipelineStatusLabel(status: string) {
  return (
    {
      pending_review: '待复核',
      unsuitable: '不符合',
      to_contact: '待联系',
      contacted: '已联系',
      communicating: '沟通中',
      partnered: '已合作',
      declined: '不合作',
    }[status] ?? status
  );
}

export function formatFollowerCount(value: number | null) {
  return value === null ? '未知' : new Intl.NumberFormat('zh-CN').format(value);
}

export function hardFilterLabel(outcome: 'pass' | 'fail' | 'unknown') {
  return { pass: '通过', fail: '不通过', unknown: '未知' }[outcome];
}

export function ruleLabel(ruleKey: string) {
  return { followers: '粉丝范围', 'recent-viral-post': '近期爆款作品' }[ruleKey] ?? ruleKey;
}

export function formatEvidenceThreshold(evidence: Record<string, unknown>) {
  if (typeof evidence.minimumLikes === 'number') return `门槛 ${evidence.minimumLikes} 赞`;
  if (typeof evidence.minimum === 'number' && typeof evidence.maximum === 'number') {
    return `范围 ${evidence.minimum}–${evidence.maximum}`;
  }
  return '保留当时观察值与阈值';
}

export function runStatusLabel(status: RunSummary['status']) {
  return {
    ready: '待领取',
    claimed: '已领取',
    running: '采集中',
    paused: '已暂停',
    completed: '已完成',
    failed: '异常',
    terminated: '已终止',
  }[status];
}

export function runStopReasonLabel(reason: string) {
  return (
    {
      target_candidates: '目标候选数已达到',
      max_feed_items: '最多浏览作品数已达到',
      max_creator_profiles: '最多核验主页数已达到',
      max_duration_minutes: '最长运行时间已达到',
      manual_termination: '运营人员手动终止',
    }[reason] ?? reason
  );
}

export function formatRunTime(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function roleLabel(role: Role) {
  return { admin: '管理员', operator: '运营', readonly: '只读' }[role];
}
