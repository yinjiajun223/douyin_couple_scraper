import { useEffect, useState } from 'react';

import type { RunSummary } from '../types';
import { formatRunTime, runStatusLabel, runStopReasonLabel } from '../lib/format';
import { RunMetric } from '../components/RunMetric';
import { EmptyPanel } from '../components/EmptyPanel';

export function RunsPage({
  runs,
  preset,
}: {
  runs: RunSummary[];
  preset: 'active' | 'failed' | null;
}) {
  const visibleRuns =
    preset === 'failed'
      ? runs.filter((run) => run.status === 'failed')
      : preset === 'active'
        ? runs.filter((run) => ['claimed', 'running', 'paused'].includes(run.status))
        : runs;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(visibleRuns[0]?.id ?? null);
  useEffect(() => {
    if (!visibleRuns.length) {
      setSelectedRunId(null);
      return;
    }
    if (!selectedRunId || !visibleRuns.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(visibleRuns[0]!.id);
    }
  }, [visibleRuns, selectedRunId]);
  const selectedRun = visibleRuns.find((run) => run.id === selectedRunId);

  return (
    <section>
      <header className="section-page-header">
        <div>
          <p className="eyebrow">RUNS / LIVE</p>
          <h1>运行监控</h1>
          <p className="lede">领取不等于开始。只有运营在本地采集助手确认后，运行才会进入采集中。</p>
        </div>
        <span className="live-sync">
          <span aria-hidden="true" />每 3 秒同步
        </span>
      </header>

      {visibleRuns.length ? (
        <div className="run-monitor-layout">
          <aside aria-label="运行列表" className="run-list-panel">
            {visibleRuns.map((run) => (
              <button
                aria-pressed={run.id === selectedRunId}
                className={`run-list-item ${run.id === selectedRunId ? 'run-list-item-active' : ''}`}
                key={run.id}
                onClick={() => setSelectedRunId(run.id)}
                type="button"
              >
                <span className={`run-status-dot run-status-${run.status}`} aria-hidden="true" />
                <span>
                  <strong>{run.campaignName}</strong>
                  <small>
                    规则 v{run.ruleVersion} · {runStatusLabel(run.status)}
                  </small>
                </span>
                <b>{run.progress.candidatesFound}</b>
              </button>
            ))}
          </aside>

          {selectedRun ? (
            <article className="run-detail-panel" aria-labelledby="run-detail-title">
              <div className="run-detail-heading">
                <div>
                  <p className="eyebrow">当前运行</p>
                  <h2 id="run-detail-title">{selectedRun.campaignName}</h2>
                </div>
                <span className={`run-status-chip run-status-chip-${selectedRun.status}`}>
                  {runStatusLabel(selectedRun.status)}
                </span>
              </div>

              <dl className="run-facts">
                <div>
                  <dt>领取设备</dt>
                  <dd>{selectedRun.device?.name ?? '尚未领取'}</dd>
                </div>
                <div>
                  <dt>规则快照</dt>
                  <dd>版本 {selectedRun.ruleVersion}</dd>
                </div>
                <div>
                  <dt>开始时间</dt>
                  <dd>{formatRunTime(selectedRun.startedAt)}</dd>
                </div>
                <div>
                  <dt>最后同步</dt>
                  <dd>{formatRunTime(selectedRun.updatedAt)}</dd>
                </div>
              </dl>

              <div className="run-progress-grid">
                <RunMetric label="已浏览作品" value={selectedRun.progress.feedItemsSeen} />
                <RunMetric label="已核验主页" value={selectedRun.progress.creatorProfilesSeen} />
                <RunMetric label="发现候选" value={selectedRun.progress.candidatesFound} accent />
                <RunMetric
                  label="运行时长"
                  value={`${Math.floor(selectedRun.progress.elapsedSeconds / 60)} 分`}
                />
              </div>

              {selectedRun.stopReason ? (
                <div className="run-notice run-stop-notice">
                  <span>停止原因</span>
                  <strong>{runStopReasonLabel(selectedRun.stopReason)}</strong>
                </div>
              ) : null}
              {selectedRun.status === 'paused' ? (
                <div className="run-notice" role="status">
                  <span>采集已暂停</span>
                  <strong>请回到运营电脑处理验证码、登录或页面异常后再继续。</strong>
                </div>
              ) : null}
              {selectedRun.errorCode || selectedRun.errorMessage ? (
                <div className="run-notice run-error-notice" role="alert">
                  <span>采集异常 · {selectedRun.errorCode ?? 'UNKNOWN'}</span>
                  <strong>
                    {selectedRun.errorMessage ?? '本次运行异常结束，请在运营电脑检查。'}
                  </strong>
                </div>
              ) : null}
            </article>
          ) : null}
        </div>
      ) : (
        <div className="data-panel">
          <EmptyPanel text="还没有运行记录。请先在筛选任务中创建一次运行。" />
        </div>
      )}
    </section>
  );
}
