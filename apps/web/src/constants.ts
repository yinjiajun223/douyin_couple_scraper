import type { AuditAction, AuditSubjectType } from './types';

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

// 与服务端 `BATCH_OPERATION_LIMIT`（packages/domain/src/candidates/candidate-batch.ts）一致：
// 超限服务端会整体拒绝，界面提前拦住，运营才不会白等一次往返。
export const BATCH_OPERATION_LIMIT = 100;

export const EVIDENCE_ZOOM_MIN = 1;
export const EVIDENCE_ZOOM_MAX = 4;
export const EVIDENCE_ZOOM_STEP = 0.25;

// Record<AuditAction, string> 是刻意的：新增一个审计动作而忘记配标签会直接编译不过。
export const auditActionLabels: Record<AuditAction, string> = {
  'account.bootstrap_admin': '初始化管理员',
  'account.invitation_created': '发出成员邀请',
  'account.invitation_accepted': '接受成员邀请',
  'account.invitation_revoked': '撤销成员邀请',
  'account.disabled': '停用成员',
  'account.enabled': '启用成员',
  'account.role_changed': '变更成员角色',
  'campaign.rules_updated': '更新筛选任务',
  'campaign.run_created': '创建采集运行',
  'campaign.run_status_changed': '采集运行状态变更',
  'device.pairing_code_created': '生成设备配对码',
  'device.paired': '配对采集设备',
  'device.token_rotated': '轮换设备令牌',
  'device.revoked': '撤销采集设备',
  'candidate.reviewed': '人工复核候选',
  'candidate.archived': '归档候选',
  'candidate.unarchived': '恢复候选',
  'candidate.tags_changed': '更新候选标签',
  'outreach.status_changed': '更新跟进记录',
  'export.created': '导出候选数据',
};

export const auditSubjectLabels: Record<AuditSubjectType, string> = {
  campaign: '筛选任务',
  candidate: '候选达人',
  candidate_export: '候选导出',
  collection_run: '采集运行',
  device: '采集设备',
  device_pairing_code: '设备配对码',
  invitation: '成员邀请',
  user: '成员',
};

// 界面上永远显示中文：遇到尚未收录的取值也只用这两个兜底文案，
// 原始英文键只放进 title 供排查时复制，不作为可见文本。
export const AUDIT_FALLBACK_ACTION_LABEL = '其他操作';
export const AUDIT_FALLBACK_SUBJECT_LABEL = '其他对象';
