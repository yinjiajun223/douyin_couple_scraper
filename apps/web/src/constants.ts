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

export type PipelineStatus = (typeof pipelineStatusOptions)[number]['value'];

// 7 个合作阶段收成 5 个分区以控制标签数量，另加一个跨阶段的「全部」承接工作台的
// 「我负责的」卡片（该计数器不按阶段过滤）。分组在服务端过滤，前端不再以硬筛结论
// 作为主分区轴。
export const candidateSections = [
  {
    label: '全部',
    statuses: pipelineStatusOptions.map((option) => option.value),
    value: 'all',
  },
  { label: '待复核', statuses: ['pending_review'], value: 'pending_review' },
  { label: '待联系', statuses: ['to_contact'], value: 'to_contact' },
  { label: '跟进中', statuses: ['contacted', 'communicating'], value: 'following_up' },
  { label: '已合作', statuses: ['partnered'], value: 'partnered' },
  { label: '不合适', statuses: ['unsuitable', 'declined'], value: 'unsuitable' },
] as const satisfies ReadonlyArray<{
  label: string;
  statuses: readonly PipelineStatus[];
  value: string;
}>;

export type CandidateSection = (typeof candidateSections)[number]['value'];

export const memberRoleOptions = [
  { label: '运营', value: 'operator' },
  { label: '只读', value: 'readonly' },
  { label: '管理员', value: 'admin' },
] as const;

export const EVIDENCE_ZOOM_MIN = 1;
export const EVIDENCE_ZOOM_MAX = 4;
export const EVIDENCE_ZOOM_STEP = 0.25;
