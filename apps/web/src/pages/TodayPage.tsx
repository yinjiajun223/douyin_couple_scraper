import { COLLECTOR_URL, stages } from '../constants';
import type { DashboardSummary } from '../types';
import { DashboardCard } from '../components/DashboardCard';

export function TodayPage({
  canWrite,
  dashboard,
  onCreate,
  onOpenCandidates,
  onOpenRuns,
  onOpenDevices,
  deviceCount,
  campaignCount,
}: {
  canWrite: boolean;
  dashboard: DashboardSummary;
  onCreate: () => void;
  onOpenCandidates: (preset: 'pending_review' | 'to_contact' | 'mine') => void;
  onOpenRuns: (preset: 'active' | 'failed') => void;
  onOpenDevices: () => void;
  deviceCount: number;
  campaignCount: number;
}) {
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">DOUYIN / TEAM DESK</p>
          <h1>
            把值得联系的人，
            <br />
            交给团队一起跟进。
          </h1>
          <p className="lede">
            从推荐流发现，到数据硬筛和人工确认；每一步都能回看，也不会替你做决定。
          </p>
        </div>
        {canWrite ? (
          <button className="primary-action" onClick={onCreate} type="button">
            创建筛选任务
          </button>
        ) : null}
      </header>
      {canWrite ? (
        <section className="workflow-guide" aria-label="采集操作流程">
          <div className="workflow-heading">
            <h2>从这里开始找博主</h2>
            <span>硬筛数据 · 最终由人工确认</span>
          </div>
          <div className="workflow-steps">
            <button type="button" onClick={onOpenDevices}>
              <span className="step-number">01</span>
              <strong>配对采集设备</strong>
              <small>
                {deviceCount ? `${deviceCount} 台已授权 · 管理设备` : '连接你电脑上的采集助手'}
              </small>
            </button>
            <button type="button" onClick={onCreate}>
              <span className="step-number">02</span>
              <strong>配置筛选任务</strong>
              <small>
                {campaignCount
                  ? `${campaignCount} 个任务 · 创建新条件`
                  : '设置粉丝、爆款与停止条件'}
              </small>
            </button>
            <a href={COLLECTOR_URL} target="_blank" rel="noreferrer">
              <span className="step-number">03</span>
              <strong>本机人工开始</strong>
              <small>登录抖音，选择画像与运行 ↗</small>
            </a>
            <button type="button" onClick={() => onOpenCandidates('pending_review')}>
              <span className="step-number">04</span>
              <strong>复核与合作跟进</strong>
              <small>查看证据，确认并分配负责人</small>
            </button>
          </div>
        </section>
      ) : null}
      <section className="dashboard-grid" aria-label="运营待办概览">
        <DashboardCard
          label="运行中任务"
          value={dashboard.runningRuns}
          onClick={() => onOpenRuns('active')}
        />
        <DashboardCard
          label="待复核"
          value={dashboard.pendingReview}
          onClick={() => onOpenCandidates('pending_review')}
        />
        <DashboardCard
          label="待联系"
          value={dashboard.toContact}
          onClick={() => onOpenCandidates('to_contact')}
        />
        <DashboardCard
          label="我负责的"
          value={dashboard.myAssignments}
          onClick={() => onOpenCandidates('mine')}
        />
        <DashboardCard
          label="失败任务"
          value={dashboard.failedRuns}
          onClick={() => onOpenRuns('failed')}
        />
      </section>
      <section className="signal-board" aria-labelledby="pipeline-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">筛选链路</p>
            <h2 id="pipeline-title">两段证据轨道</h2>
          </div>
          <p>硬条件先判断，最终由运营人员确认。</p>
        </div>
        <ol className="stage-list">
          {stages.map((stage, index) => (
            <li className={`stage stage-${stage.tone}`} key={stage.label}>
              <span className="stage-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="stage-line" aria-hidden="true" />
              <div>
                <h3>{stage.label}</h3>
                <p>{stage.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      {Object.values(dashboard).every((count) => count === 0) ? (
        <section className="empty-state" aria-labelledby="empty-title">
          <p className="empty-label">当前没有待处理事项</p>
          <h2 id="empty-title">先把这次要找的人说明白。</h2>
          <p>
            {canWrite
              ? '创建任务后，在运营电脑上选择已经养好的抖音画像并手动开始采集。'
              : '你可以查看团队已经建立的任务和候选，编辑操作由运营成员完成。'}
          </p>
        </section>
      ) : null}
    </>
  );
}
