import { useEffect, useRef, useState } from 'react';

import type { ObservedCreatorVerdict, RunSummary } from '../types';
import { readResponse } from '../api/client';
import {
  formatEvidenceThreshold,
  formatFollowerCount,
  formatPostEvidence,
  formatRunTime,
  hardFilterLabel,
  pipelineStatusLabel,
  ruleLabel,
  runStatusLabel,
  runStopReasonLabel,
} from '../lib/format';
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

  // 运行列表每 3 秒同步一次，用已核验主页数当作刷新令牌，让判定依据面板跟上进行中的运行。
  const observedToken = selectedRun
    ? `${selectedRun.id}:${selectedRun.progress.creatorProfilesSeen}`
    : null;
  const [observedCreators, setObservedCreators] = useState<ObservedCreatorVerdict[]>([]);
  const [observedLoading, setObservedLoading] = useState(false);
  const [observedError, setObservedError] = useState('');
  const observedRequest = useRef(0);
  const observedRunId = useRef<string | null>(null);

  useEffect(() => {
    const requestId = ++observedRequest.current;
    // 切换运行时先清空，否则新运行的详情会短暂显示上一个运行观察到的达人。
    // 同一次运行的进度刷新不清空，避免每 3 秒闪一次空态。
    if (observedRunId.current !== selectedRunId) {
      observedRunId.current = selectedRunId;
      setObservedCreators([]);
    }
    if (!selectedRunId || !observedToken) {
      setObservedLoading(false);
      return;
    }
    const controller = new AbortController();
    setObservedLoading(true);
    setObservedError('');
    fetch(`/runs/${selectedRunId}/observed-creators`, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(readResponse<{ creators: ObservedCreatorVerdict[] }>)
      .then((result) => {
        if (requestId === observedRequest.current) setObservedCreators(result.creators);
      })
      .catch((error: unknown) => {
        if (requestId !== observedRequest.current) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setObservedCreators([]);
        setObservedError('判定依据加载失败，请重新选择该运行后重试。');
      })
      .finally(() => {
        if (requestId === observedRequest.current) setObservedLoading(false);
      });
    return () => controller.abort();
  }, [selectedRunId, observedToken]);

  const admittedCount = observedCreators.filter((creator) => creator.admitted).length;

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

              <section
                className="candidate-detail-section"
                aria-labelledby="observed-creators-title"
              >
                <div className="detail-section-heading">
                  <div>
                    <h3 id="observed-creators-title">本次运行观察到的达人</h3>
                    <small>未入库的达人同样列出，结论由采集事实与该运行的规则快照重新推导</small>
                  </div>
                  <span>
                    共 {observedCreators.length} 位 · 已入库 {admittedCount} 位
                  </span>
                </div>
                {observedError ? (
                  <p className="form-error" role="alert">
                    {observedError}
                  </p>
                ) : null}
                {observedLoading && !observedCreators.length ? (
                  <EmptyPanel text="正在重新推导判定依据…" />
                ) : null}
                {!observedLoading && !observedCreators.length && !observedError ? (
                  <EmptyPanel text="本次运行还没有核验任何达人主页。" />
                ) : null}
                {observedCreators.length ? (
                  <div className="evaluation-list">
                    {observedCreators.map((creator) => (
                      <div className="evaluation-card" key={creator.observationId}>
                        <div>
                          <span>
                            {creator.admitted && creator.pipelineStatus
                              ? `已入库 · ${pipelineStatusLabel(creator.pipelineStatus)}`
                              : '未入库 · 不进入复核队列'}
                          </span>
                          <strong>{creator.nickname}</strong>
                          <small>
                            粉丝 {formatFollowerCount(creator.followerCount)}
                            {creator.followerCountRaw
                              ? `（${creator.followerCountRaw}）`
                              : ''} · {formatRunTime(creator.observedAt)} 观察
                          </small>
                          {creator.evaluations.map((evaluation) => (
                            <small key={evaluation.ruleId}>
                              {ruleLabel(evaluation.ruleId)} · {hardFilterLabel(evaluation.outcome)}{' '}
                              · {formatEvidenceThreshold(evaluation.evidence)}
                              {evaluation.ruleType === 'recent-post-likes'
                                ? ` · ${formatPostEvidence(evaluation.evidence)}`
                                : ''}
                            </small>
                          ))}
                        </div>
                        <b className={`evidence-outcome evidence-${creator.outcome}`}>
                          {hardFilterLabel(creator.outcome)}
                        </b>
                        <a href={creator.profileUrl} rel="noreferrer" target="_blank">
                          抖音主页
                        </a>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
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
