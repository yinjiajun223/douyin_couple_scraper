import { useEffect, useRef, useState } from 'react';

import type { CandidateDetailData, CandidateSummary, Member, Role } from '../types';
import { readResponse } from '../api/client';
import {
  candidateDateOptions,
  candidateSections,
  pipelineStatusOptions,
  reviewDecisionOptions,
} from '../constants';
import {
  candidateDateRange,
  candidateMatchesLibraryView,
  groupCandidatesByDate,
} from '../lib/date';
import {
  formatEvidenceThreshold,
  formatFollowerCount,
  formatRunTime,
  hardFilterLabel,
  manualDecisionLabel,
  pipelineStatusLabel,
  ruleLabel,
} from '../lib/format';
import { FilterSelect, FormSelect } from '../components/FilterSelect';
import { EmptyPanel } from '../components/EmptyPanel';
import { PrivateImageLightbox } from '../components/PrivateImageLightbox';

export function CandidatesPage({
  canWrite,
  csrfToken,
  currentUserId,
  members,
  preset,
  role,
}: {
  canWrite: boolean;
  csrfToken: string;
  currentUserId: string;
  members: Member[];
  preset: 'pending_review' | 'to_contact' | 'mine' | null;
  role: Role;
}) {
  // preset 与分区轴是同一维度（design.md D8）：待复核 / 待联系直接落到对应分区；
  // 「我负责的」不按阶段过滤，落到跨阶段的「全部」再叠加 ownerUserId，
  // 这样工作台计数器的数字才和分区列表对得上。
  const [candidateSection, setCandidateSection] = useState(
    candidateSections.find((section) => section.value === preset) ?? candidateSections[0],
  );
  const mineOnly = preset === 'mine';
  const [datePreset, setDatePreset] = useState<
    'today' | 'yesterday' | '7d' | '30d' | 'custom' | 'all'
  >('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [memberUserId, setMemberUserId] = useState('');
  const [visibleCandidates, setVisibleCandidates] = useState<CandidateSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CandidateDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [libraryToken, setLibraryToken] = useState(0);
  const detailRequest = useRef(0);
  const libraryRequest = useRef(0);
  const keepSelection = useRef(false);

  function buildCandidateQuery(cursor?: string) {
    const query = new URLSearchParams({
      limit: '50',
      pipelineStatuses: candidateSection.statuses.join(','),
    });
    if (mineOnly) query.set('ownerUserId', currentUserId);
    if (role === 'admin' && memberUserId) query.set('memberUserId', memberUserId);
    const range = candidateDateRange(datePreset, customFrom, customTo);
    if (range.from) query.set('discoveredFrom', range.from);
    if (range.to) query.set('discoveredTo', range.to);
    if (cursor) query.set('cursor', cursor);
    return query;
  }

  useEffect(() => {
    // 保存后重拉列表时不能清空当前选中的达人，否则详情面板会跟着一起消失。
    const preserveSelection = keepSelection.current;
    keepSelection.current = false;
    // 「加载更多」没有中断机制，筛选条件一变就作废在途请求，
    // 否则旧分区的 nextCursor 会覆盖新分区的，翻页随之重复或漏掉达人。
    libraryRequest.current += 1;
    if (datePreset === 'custom' && (!customFrom || !customTo)) return;
    const controller = new AbortController();
    setLibraryLoading(true);
    setLibraryError('');
    if (!preserveSelection) {
      setSelectedCandidateId(null);
      setDetail(null);
    }
    void fetch(`/candidates?${buildCandidateQuery()}`, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(readResponse<{ candidates: CandidateSummary[]; nextCursor: string | null }>)
      .then((result) => {
        setVisibleCandidates(
          result.candidates.filter((candidate) =>
            candidateMatchesLibraryView(candidate, candidateSection.value, mineOnly, currentUserId),
          ),
        );
        setNextCursor(result.nextCursor ?? null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLibraryError('达人库加载失败，请稍后重试。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLibraryLoading(false);
      });
    return () => controller.abort();
  }, [candidateSection, customFrom, customTo, datePreset, libraryToken, memberUserId, preset]);

  async function loadMoreCandidates() {
    if (!nextCursor || libraryLoading) return;
    const requestId = libraryRequest.current;
    setLibraryLoading(true);
    setLibraryError('');
    try {
      const result = await fetch(`/candidates?${buildCandidateQuery(nextCursor)}`, {
        credentials: 'include',
      }).then(readResponse<{ candidates: CandidateSummary[]; nextCursor: string | null }>);
      if (requestId !== libraryRequest.current) return;
      setVisibleCandidates((current) => {
        const byId = new Map(current.map((candidate) => [candidate.id, candidate]));
        for (const candidate of result.candidates) {
          if (
            candidateMatchesLibraryView(candidate, candidateSection.value, mineOnly, currentUserId)
          ) {
            byId.set(candidate.id, candidate);
          }
        }
        return [...byId.values()];
      });
      setNextCursor(result.nextCursor ?? null);
    } catch {
      if (requestId === libraryRequest.current) setLibraryError('下一页加载失败，请重试。');
    } finally {
      if (requestId === libraryRequest.current) setLibraryLoading(false);
    }
  }

  const groupedCandidates = groupCandidatesByDate(visibleCandidates);
  // 保存后重拉详情时不能卸载面板：折叠区展开状态与已取到的截图签名地址都是本地状态，
  // 卸载一次就会把运营正在填的联系资料重新收起、截图重新加载。切换达人时仍照常卸载。
  const keepDetailMounted = detail !== null && detail.candidate.id === selectedCandidateId;
  const emptyLibraryText =
    candidateSection.value === 'all'
      ? '还没有入库的达人。采集同步并满足全部硬筛条件后会进入这里。'
      : `暂时没有处于「${candidateSection.label}」阶段的达人。`;

  function showCandidateSection(nextSection: (typeof candidateSections)[number]) {
    if (nextSection.value === candidateSection.value) return;
    detailRequest.current += 1;
    setCandidateSection(nextSection);
    setSelectedCandidateId(null);
    setDetail(null);
    setLoading(false);
    setLoadError('');
  }

  async function openCandidate(candidateId: string) {
    setSelectedCandidateId(candidateId);
    setLoading(true);
    setLoadError('');
    const requestId = ++detailRequest.current;
    try {
      const result = await fetch(`/candidates/${candidateId}`, { credentials: 'include' }).then(
        readResponse<CandidateDetailData>,
      );
      if (requestId === detailRequest.current) setDetail(result);
    } catch {
      if (requestId === detailRequest.current) {
        setDetail(null);
        setLoadError('达人详情加载失败，请再次点击该达人重试。');
      }
    } finally {
      if (requestId === detailRequest.current) setLoading(false);
    }
  }

  // 复核会在服务端同一次请求里推进阶段并递增版本，提交后必须重拉详情与分区列表，
  // 否则详情面板会停留在过期的阶段和 candidateVersion，运营的下一次操作必然 409。
  function refreshAfterSave(candidateId: string) {
    keepSelection.current = true;
    setLibraryToken((current) => current + 1);
    void openCandidate(candidateId);
  }

  return (
    <section>
      <header className="section-page-header">
        <div>
          <p className="eyebrow">CREATORS / EVIDENCE</p>
          <h1>达人库</h1>
          <p className="lede">运营仅查看自己采集或被分配的达人；管理员可查看全团队数据。</p>
        </div>
        <span className="library-count">
          {candidateSection.value === 'all'
            ? `${visibleCandidates.length} 位达人`
            : `${visibleCandidates.length} 位${candidateSection.label}`}
        </span>
      </header>

      <div aria-label="达人库分区" className="candidate-library-switcher" role="group">
        {candidateSections.map((section) => (
          <button
            aria-pressed={section.value === candidateSection.value}
            key={section.value}
            onClick={() => showCandidateSection(section)}
            type="button"
          >
            {section.label}
          </button>
        ))}
      </div>

      <div className="candidate-library-filters" aria-label="达人库筛选">
        <div className="candidate-filter-intro">
          <span>VIEW / SCOPE</span>
          <strong>入库范围</strong>
          <small>按首次发现时间与归属查看</small>
        </div>
        <FilterSelect
          label="发现日期"
          onChange={(value) => setDatePreset(value as typeof datePreset)}
          options={candidateDateOptions}
          value={datePreset}
        />
        {datePreset === 'custom' ? (
          <>
            <label className="candidate-filter-field">
              <span className="candidate-filter-label">开始日期</span>
              <input
                aria-label="开始日期"
                onChange={(event) => setCustomFrom(event.target.value)}
                type="date"
                value={customFrom}
              />
            </label>
            <label className="candidate-filter-field">
              <span className="candidate-filter-label">结束日期</span>
              <input
                aria-label="结束日期"
                onChange={(event) => setCustomTo(event.target.value)}
                type="date"
                value={customTo}
              />
            </label>
          </>
        ) : null}
        {role === 'admin' ? (
          <FilterSelect
            label="运营成员"
            onChange={setMemberUserId}
            options={[
              { label: '全部成员', value: '' },
              ...members
                .filter((member) => member.status === 'active')
                .map((member) => ({ label: member.displayName, value: member.id })),
            ]}
            value={memberUserId}
          />
        ) : null}
      </div>

      {libraryError ? (
        <p className="form-error" role="alert">
          {libraryError}
        </p>
      ) : null}

      {/* 复核会把达人推出当前分区，分区因此被清空是常态；只要还选中着达人，
          两栏布局就必须留着，否则运营刚点完保存，确认文案会跟着详情面板一起消失。 */}
      {visibleCandidates.length || selectedCandidateId ? (
        <div className="candidate-workspace">
          <div className="candidate-list" aria-label={`${candidateSection.label}达人列表`}>
            {visibleCandidates.length ? null : <EmptyPanel text={emptyLibraryText} />}
            {groupedCandidates.map((group) => (
              <div className="candidate-date-group" key={group.key}>
                <div className="candidate-date-heading">
                  <strong>{group.label}</strong>
                  <span>{group.candidates.length} 位</span>
                </div>
                {group.candidates.map((candidate) => (
                  <button
                    aria-pressed={selectedCandidateId === candidate.id}
                    className={`candidate-list-item ${selectedCandidateId === candidate.id ? 'candidate-list-item-active' : ''}`}
                    key={candidate.id}
                    onClick={() => void openCandidate(candidate.id)}
                    type="button"
                  >
                    <span className="candidate-avatar">{candidate.nickname.slice(0, 1)}</span>
                    <span>
                      <strong>{candidate.nickname}</strong>
                      <small>
                        {candidate.campaignName} · {formatFollowerCount(candidate.followerCount)}{' '}
                        粉丝
                      </small>
                      <em>{candidate.tags.join(' · ') || '暂无标签'}</em>
                    </span>
                    <b className="candidate-stage">
                      {pipelineStatusLabel(candidate.pipelineStatus)}
                    </b>
                  </button>
                ))}
              </div>
            ))}
            {nextCursor ? (
              <button
                className="candidate-load-more"
                disabled={libraryLoading}
                onClick={() => void loadMoreCandidates()}
                type="button"
              >
                {libraryLoading ? '加载中…' : '加载更多'}
              </button>
            ) : null}
          </div>

          <div className="candidate-detail-shell">
            {loadError ? (
              <p className="form-error" role="alert">
                {loadError}
              </p>
            ) : null}
            {loading && !keepDetailMounted ? <EmptyPanel text="正在调取历史证据…" /> : null}
            {!loading && !detail ? (
              <EmptyPanel text="选择一位达人，查看历次观察、任务来源和当时使用的规则证据。" />
            ) : null}
            {detail && (!loading || keepDetailMounted) ? (
              <CandidateDetailView
                key={detail.candidate.id}
                canWrite={canWrite}
                csrfToken={csrfToken}
                detail={detail}
                onSaved={() => refreshAfterSave(detail.candidate.id)}
              />
            ) : null}
          </div>
        </div>
      ) : libraryLoading ? (
        <div className="data-panel">
          <EmptyPanel text="正在加载达人库…" />
        </div>
      ) : (
        <div className="data-panel">
          <EmptyPanel text={emptyLibraryText} />
        </div>
      )}
    </section>
  );
}

async function requestSignedMediaUrl(mediaId: string, signal?: AbortSignal) {
  const response = await fetch(`/media/${mediaId}/access`, {
    credentials: 'include',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error('media unavailable');
  const result = (await response.json()) as { downloadUrl?: unknown };
  const downloadUrl = result.downloadUrl;
  if (typeof downloadUrl !== 'string' || !downloadUrl.trim()) {
    throw new Error('media URL unavailable');
  }
  return downloadUrl;
}

async function describeWorkflowFailure(response: Response) {
  // 409 同时承载「版本冲突」和「阶段不允许流转」，只看状态码会把流转错误误报成同事抢改。
  const code = response.status === 409 ? await readErrorCode(response) : '';
  if (code === 'INVALID_PIPELINE_TRANSITION') {
    return '当前阶段不允许直接改到这个状态，请重新打开达人后选择相邻阶段。';
  }
  if (response.status === 409) return '这条记录已被同事更新，请重新打开达人后再提交。';
  if (response.status === 400) return '提交内容不完整或格式不正确，请重新打开达人后重试。';
  if (response.status === 403) return '当前角色没有修改权限。';
  if (response.status === 404) return '找不到这条达人记录，可能已被删除或不在你的可见范围内。';
  return '保存失败，请稍后重试。';
}

async function readErrorCode(response: Response) {
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    return typeof body.code === 'string' ? body.code : '';
  } catch {
    return '';
  }
}

export function CandidateDetailView({
  detail,
  canWrite,
  csrfToken,
  onSaved,
}: {
  detail: CandidateDetailData;
  canWrite: boolean;
  csrfToken: string;
  onSaved: () => void;
}) {
  const latest = detail.observations[0];
  const [workflowMessage, setWorkflowMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [mediaFailures, setMediaFailures] = useState<Record<string, true>>({});
  const [previewImage, setPreviewImage] = useState<{ alt: string; src: string } | null>(null);
  const [assignees, setAssignees] = useState<Array<{ id: string; displayName: string }>>([]);
  const [assigneesLoaded, setAssigneesLoaded] = useState(false);
  const [ownerUserId, setOwnerUserId] = useState(detail.workflow?.outreach?.ownerUserId ?? '');
  const mediaKey = (detail.media ?? []).map((media) => media.id).join(',');
  useEffect(() => {
    // 截图是复核的主要依据，打开详情就一次性预取全部签名地址，避免逐张点击等待。
    const mediaIds = mediaKey ? mediaKey.split(',') : [];
    if (!mediaIds.length) return;
    const controller = new AbortController();
    void Promise.all(
      mediaIds.map(async (mediaId) => {
        try {
          return { mediaId, url: await requestSignedMediaUrl(mediaId, controller.signal) };
        } catch {
          return { mediaId, url: null };
        }
      }),
    ).then((results) => {
      if (controller.signal.aborted) return;
      const urls: Record<string, string> = {};
      const failures: Record<string, true> = {};
      for (const result of results) {
        if (result.url) urls[result.mediaId] = result.url;
        else failures[result.mediaId] = true;
      }
      if (Object.keys(urls).length) setMediaUrls(urls);
      if (Object.keys(failures).length) setMediaFailures(failures);
    });
    return () => controller.abort();
  }, [mediaKey]);
  useEffect(() => {
    if (!canWrite) return;
    const controller = new AbortController();
    void fetch('/members/assignable', { credentials: 'include', signal: controller.signal })
      .then(readResponse<{ members: Array<{ id: string; displayName: string }> }>)
      .then((result) => {
        setAssignees(result.members);
        setAssigneesLoaded(true);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError'))
          setWorkflowMessage('负责人列表加载失败，请重新打开达人重试。');
      });
    return () => controller.abort();
  }, [canWrite]);

  async function submitWorkflowRequest(
    path: string,
    body: Record<string, unknown>,
    method = 'POST',
  ) {
    if (saving) return false;
    setSaving(true);
    setWorkflowMessage('');
    try {
      const response = await fetch(path, {
        body: JSON.stringify(body),
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        method,
      });
      if (!response.ok) {
        setWorkflowMessage(await describeWorkflowFailure(response));
        return false;
      }
      onSaved();
      return true;
    } catch {
      setWorkflowMessage('网络连接失败，尚未确认保存。请重新打开达人确认状态后重试。');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function loadPrivateImage(mediaId: string) {
    try {
      const downloadUrl = await requestSignedMediaUrl(mediaId);
      setMediaFailures((current) => {
        const next = { ...current };
        delete next[mediaId];
        return next;
      });
      setMediaUrls((current) => ({ ...current, [mediaId]: downloadUrl }));
    } catch {
      setMediaFailures((current) => ({ ...current, [mediaId]: true }));
    }
  }
  return (
    <article className="candidate-detail" aria-labelledby="candidate-detail-title">
      <header className="candidate-detail-header">
        <div>
          <p className="eyebrow">达人详情</p>
          <h2 id="candidate-detail-title">{latest?.nickname ?? detail.candidate.campaignName}</h2>
          <p>{latest?.biography || '未采集到简介'}</p>
        </div>
        {latest ? (
          <a href={latest.profileUrl} rel="noreferrer" target="_blank">
            打开抖音主页
          </a>
        ) : null}
      </header>

      {(detail.media ?? []).length ? (
        <section className="candidate-detail-section" aria-labelledby="private-media-title">
          <div className="detail-section-heading">
            <h3 id="private-media-title">私有证据截图</h3>
            <span>短时授权访问</span>
          </div>
          <div className="private-media-grid">
            {(detail.media ?? []).map((media) => {
              const imageUrl = mediaUrls[media.id];
              const imageAlt =
                media.purpose === 'profile_screenshot' ? '主页证据截图' : '作品证据截图';
              return (
                <figure key={media.id}>
                  {imageUrl ? (
                    <button
                      aria-label={`放大查看${imageAlt}`}
                      className="private-media-preview-trigger"
                      onClick={() => setPreviewImage({ alt: imageAlt, src: imageUrl })}
                      type="button"
                    >
                      <img alt={imageAlt} src={imageUrl} />
                      <span>点击放大</span>
                    </button>
                  ) : mediaFailures[media.id] ? (
                    <button onClick={() => void loadPrivateImage(media.id)} type="button">
                      截图加载失败，点击重试
                    </button>
                  ) : (
                    <p className="private-media-pending">截图加载中…</p>
                  )}
                  <figcaption>{formatRunTime(media.createdAt)}</figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      ) : null}

      {previewImage ? (
        <PrivateImageLightbox image={previewImage} onClose={() => setPreviewImage(null)} />
      ) : null}

      <section className="candidate-detail-section" aria-labelledby="history-title">
        <div className="detail-section-heading">
          <h3 id="history-title">观察时间线</h3>
          <span>{detail.observations.length} 次</span>
        </div>
        <ol className="observation-timeline">
          {detail.observations.map((observation) => (
            <li key={observation.id}>
              <span className="timeline-node" aria-hidden="true" />
              <time>{formatRunTime(observation.observedAt)}</time>
              <strong>{formatFollowerCount(observation.followerCount)} 粉丝</strong>
              <p>
                {observation.nickname} · {observation.device.name}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section className="candidate-detail-section" aria-labelledby="source-title">
        <div className="detail-section-heading">
          <h3 id="source-title">任务来源</h3>
          <span>{detail.sources.length} 条</span>
        </div>
        <div className="source-grid">
          {detail.sources.map((source) => (
            <div key={`${source.runId}-${source.device.id}`}>
              <strong>{source.campaignName}</strong>
              <p>
                {source.device.name} · 观察 {source.observationCount} 次
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="candidate-detail-section" aria-labelledby="evidence-title">
        <div className="detail-section-heading">
          <h3 id="evidence-title">规则与作品证据</h3>
          <span>历史不可覆盖</span>
        </div>
        <div className="evaluation-list">
          {detail.evaluations.map((evaluation) => (
            <div className="evaluation-card" key={evaluation.id}>
              <div>
                <span>规则 v{evaluation.ruleVersion}</span>
                <strong>{ruleLabel(evaluation.ruleKey)}</strong>
                <small>{formatEvidenceThreshold(evaluation.evidence)}</small>
              </div>
              <b className={`evidence-outcome evidence-${evaluation.outcome}`}>
                {hardFilterLabel(evaluation.outcome)}
              </b>
              {evaluation.matchedPost ? (
                <a href={evaluation.matchedPost.url} rel="noreferrer" target="_blank">
                  命中作品 · {formatFollowerCount(evaluation.matchedPost.likeCount)} 赞
                  {evaluation.matchedPost.likeCountRaw
                    ? `（${evaluation.matchedPost.likeCountRaw}）`
                    : ''}
                </a>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section className="candidate-detail-section" aria-labelledby="manual-review-title">
        <div className="detail-section-heading">
          <div>
            <h3 id="manual-review-title">人工复核与合作跟进</h3>
            <small>人工结论是最终业务判断</small>
          </div>
          <span>
            {pipelineStatusLabel(
              detail.workflow?.pipelineStatus ?? detail.candidate.pipelineStatus,
            )}
          </span>
        </div>
        {detail.workflow?.reviews[0] ? (
          <p className="workflow-current">
            最新人工结论：{manualDecisionLabel(detail.workflow.reviews[0].decision)} ·{' '}
            {detail.workflow.reviews[0].reviewerDisplayName}
            {detail.workflow.reviews[0].reason ? ` · ${detail.workflow.reviews[0].reason}` : ''}
          </p>
        ) : (
          <p className="muted-copy">尚未完成人工复核。</p>
        )}
        {detail.workflow?.outreach ? (
          <p className="workflow-current">
            当前负责人：{detail.workflow.outreach.ownerDisplayName ?? '未分配'} · 联系方式：
            {detail.workflow.outreach.contactValue ?? '未填写'} · 下一步：
            {detail.workflow.outreach.nextAction ?? '未填写'}
          </p>
        ) : null}
        {saving || workflowMessage ? (
          <p
            className={saving || !workflowMessage ? undefined : 'form-error'}
            role={saving ? 'status' : 'alert'}
          >
            {saving ? '正在保存，请稍候…' : workflowMessage}
          </p>
        ) : null}
        {canWrite && detail.workflow ? (
          <div className="workflow-editor-grid">
            <form
              className="workflow-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void submitWorkflowRequest(`/candidates/${detail.candidate.id}/reviews`, {
                  decision: form.get('decision'),
                  expectedVersion: detail.workflow!.candidateVersion,
                  reason: String(form.get('reason') ?? '').trim() || null,
                });
              }}
            >
              <h4>复核结论</h4>
              <FormSelect
                defaultValue="approved"
                label="结论"
                name="decision"
                options={reviewDecisionOptions}
              />
              <button disabled={saving} type="submit">
                保存人工结论
              </button>
              <details className="workflow-optional">
                <summary>补充理由（可选）</summary>
                <label>
                  理由
                  <textarea name="reason" placeholder="可留空；填写后会永久保留在复核历史里" />
                </label>
              </details>
            </form>
            <form
              className="workflow-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void submitWorkflowRequest(`/candidates/${detail.candidate.id}/pipeline`, {
                  expectedVersion: detail.workflow!.candidateVersion,
                  nextStatus: form.get('nextStatus'),
                  note: String(form.get('note') ?? '').trim() || undefined,
                });
              }}
            >
              <h4>合作阶段</h4>
              <FormSelect
                defaultValue={detail.workflow.pipelineStatus}
                label="下一阶段"
                name="nextStatus"
                options={pipelineStatusOptions}
              />
              <button disabled={saving} type="submit">
                更新阶段
              </button>
              <details className="workflow-optional">
                <summary>补充说明（可选）</summary>
                <label>
                  说明
                  <input name="note" placeholder="本次状态变更说明" />
                </label>
              </details>
            </form>
            <details className="workflow-more workflow-form-wide">
              <summary>联系资料与沟通记录（跟进阶段再填）</summary>
              <div className="workflow-more-grid">
                <form
                  className="workflow-form contact-fields"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    const quotedAmount = String(form.get('quotedAmount') ?? '').trim();
                    void submitWorkflowRequest(
                      `/candidates/${detail.candidate.id}/outreach`,
                      {
                        contactChannel: String(form.get('contactChannel') ?? '').trim() || null,
                        contactValue: String(form.get('contactValue') ?? '').trim() || null,
                        currency: quotedAmount ? 'CNY' : null,
                        expectedVersion: detail.workflow!.outreach?.version ?? 0,
                        nextAction: String(form.get('nextAction') ?? '').trim() || null,
                        ownerUserId: assigneesLoaded
                          ? String(form.get('ownerUserId') ?? '').trim() || null
                          : (detail.workflow!.outreach?.ownerUserId ?? null),
                        quotedAmount: quotedAmount ? Number(quotedAmount) : null,
                      },
                      'PUT',
                    );
                  }}
                >
                  <h4>联系资料</h4>
                  <FilterSelect
                    disabled={!assigneesLoaded}
                    label="负责人"
                    name="ownerUserId"
                    onChange={setOwnerUserId}
                    options={[
                      { label: assigneesLoaded ? '未分配' : '正在加载成员…', value: '' },
                      ...(detail.workflow.outreach?.ownerUserId &&
                      !assignees.some(
                        (member) => member.id === detail.workflow!.outreach!.ownerUserId,
                      )
                        ? [
                            {
                              label: detail.workflow.outreach.ownerDisplayName ?? '当前负责人',
                              value: detail.workflow.outreach.ownerUserId,
                            },
                          ]
                        : []),
                      ...assignees.map((member) => ({
                        label: member.displayName,
                        value: member.id,
                      })),
                    ]}
                    value={ownerUserId}
                  />
                  <label>
                    联系渠道
                    <input
                      defaultValue={detail.workflow.outreach?.contactChannel ?? ''}
                      name="contactChannel"
                    />
                  </label>
                  <label>
                    联系方式
                    <input
                      defaultValue={detail.workflow.outreach?.contactValue ?? ''}
                      name="contactValue"
                    />
                  </label>
                  <label>
                    报价（CNY）
                    <input
                      defaultValue={detail.workflow.outreach?.quotedAmount ?? ''}
                      min="0"
                      name="quotedAmount"
                      type="number"
                    />
                  </label>
                  <label>
                    下一步
                    <input
                      defaultValue={detail.workflow.outreach?.nextAction ?? ''}
                      name="nextAction"
                    />
                  </label>
                  <button disabled={saving} type="submit">
                    保存联系资料
                  </button>
                </form>
                <form
                  className="workflow-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const formElement = event.currentTarget;
                    const form = new FormData(formElement);
                    void submitWorkflowRequest(`/candidates/${detail.candidate.id}/notes`, {
                      body: form.get('body'),
                    }).then((saved) => {
                      if (saved) formElement.reset();
                    });
                  }}
                >
                  <h4>追加沟通记录</h4>
                  <textarea
                    aria-label="沟通记录"
                    name="body"
                    placeholder="新记录只追加，不覆盖旧记录"
                    required
                  />
                  <button disabled={saving} type="submit">
                    追加记录
                  </button>
                </form>
              </div>
            </details>
          </div>
        ) : null}
        {(detail.workflow?.notes ?? []).length ? (
          <ol className="workflow-history">
            {(detail.workflow?.notes ?? []).map((note) => (
              <li key={note.id}>
                <strong>{note.authorDisplayName}</strong>
                <time>{formatRunTime(note.createdAt)}</time>
                <p>{note.body}</p>
              </li>
            ))}
          </ol>
        ) : null}
        {(detail.workflow?.events ?? []).length ? (
          <ol className="workflow-history" aria-label="状态变更历史">
            {(detail.workflow?.events ?? []).map((event) => (
              <li key={event.id}>
                <strong>{event.actorDisplayName ?? '系统'}</strong>
                <time>{formatRunTime(event.createdAt)}</time>
                <p>
                  {event.eventType === 'pipeline_status_changed'
                    ? `${pipelineStatusLabel(event.previousStatus ?? '')} → ${pipelineStatusLabel(event.nextStatus ?? '')}`
                    : ({
                        manual_reviewed: '提交人工复核',
                        outreach_updated: '更新联系资料',
                        note_added: '追加沟通记录',
                      }[event.eventType] ?? event.eventType)}
                </p>
              </li>
            ))}
          </ol>
        ) : null}
      </section>
    </article>
  );
}
