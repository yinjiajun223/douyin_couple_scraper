export const DEFAULT_WORKSPACE_ID =
  import.meta.env.VITE_WORKSPACE_ID ?? '00000000-0000-4000-8000-000000000001';

export const COLLECTOR_URL = 'http://127.0.0.1:43127';

export const stages = [
  { label: '硬筛数据', detail: '粉丝与近 15 天作品', tone: 'verified' },
  { label: '人工确认', detail: '运营人员保留最终判断', tone: 'human' },
] as const;

export const candidateDateOptions = [
  { label: '今天', value: 'today' },
  { label: '昨天', value: 'yesterday' },
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' },
  { label: '自定义', value: 'custom' },
  { label: '全部日期', value: 'all' },
] as const;

export const reviewDecisionOptions = [
  { label: '人工通过', value: 'approved' },
  { label: '不符合', value: 'rejected' },
  { label: '待定', value: 'pending' },
] as const;

export const pipelineStatusOptions = [
  { label: '待复核', value: 'pending_review' },
  { label: '不符合', value: 'unsuitable' },
  { label: '待联系', value: 'to_contact' },
  { label: '已联系', value: 'contacted' },
  { label: '沟通中', value: 'communicating' },
  { label: '已合作', value: 'partnered' },
  { label: '不合作', value: 'declined' },
] as const;

export const memberRoleOptions = [
  { label: '运营', value: 'operator' },
  { label: '只读', value: 'readonly' },
  { label: '管理员', value: 'admin' },
] as const;

export const EVIDENCE_ZOOM_MIN = 1;
export const EVIDENCE_ZOOM_MAX = 4;
export const EVIDENCE_ZOOM_STEP = 0.25;
