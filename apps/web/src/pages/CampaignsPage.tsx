import { useState } from 'react';
import type { FormEvent } from 'react';

import type { CampaignSummary } from '../types';
import { readResponse } from '../api/client';
import { COLLECTOR_URL } from '../constants';
import { EmptyPanel } from '../components/EmptyPanel';

export function CampaignsPage({
  campaigns,
  canWrite,
  csrfToken,
  onCreated,
  initialEditing,
  onOpenRuns,
}: {
  campaigns: CampaignSummary[];
  canWrite: boolean;
  csrfToken: string;
  onCreated: (campaign: CampaignSummary) => void;
  initialEditing: boolean;
  onOpenRuns: () => void;
}) {
  const [editing, setEditing] = useState(initialEditing);
  const [submitting, setSubmitting] = useState(false);
  const [creatingRunId, setCreatingRunId] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState('');
  const [lastSaved, setLastSaved] = useState<{
    name: string;
    followers: string;
    viral: string;
  } | null>(null);
  const [error, setError] = useState('');

  async function saveCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError('');
    const form = new FormData(event.currentTarget);
    const number = (name: string) => Number(form.get(name));
    if (number('followerMax') < number('followerMin')) {
      setError('上限不能小于下限，请检查粉丝数范围。');
      return;
    }
    const name = String(form.get('name'));
    const manualLabel = String(form.get('manualLabel') ?? '').trim();
    const rules = {
      schemaVersion: 2,
      hardRules: [
        {
          id: 'followers',
          kind: 'hard',
          type: 'follower-range',
          min: number('followerMin'),
          max: number('followerMax'),
        },
        {
          id: 'recent-viral-post',
          kind: 'hard',
          type: 'recent-post-likes',
          windowDays: number('windowDays'),
          minimumLikes: number('minimumLikes'),
          minimumMatchingPosts: 1,
        },
      ],
      manualChecks: manualLabel
        ? [{ id: 'manual-review', kind: 'manual', type: 'review-check', label: manualLabel }]
        : [],
      stopConditions: {
        maxFeedItems: number('maxFeedItems'),
        maxDurationMinutes: number('maxDurationMinutes'),
        targetCandidates: number('targetCandidates'),
      },
      pacing: { minimumDelayMs: 1500, maximumDelayMs: 3000 },
    };
    const recommendationProfileDescription = String(
      form.get('recommendationProfileDescription') ?? '',
    );
    setSubmitting(true);
    try {
      const response = await fetch('/campaigns', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name, recommendationProfileDescription, rules }),
      });
      if (!response.ok) {
        setError('保存失败。请检查数值范围和必填内容。');
        return;
      }
      const created = (await response.json()) as { id: string; version: number };
      onCreated({
        id: created.id,
        name,
        recommendation_profile_description: recommendationProfileDescription,
        status: 'active',
        version: created.version,
      });
      setLastSaved({
        name,
        followers: `${number('followerMin')}–${number('followerMax')}`,
        viral: `${number('windowDays')} 天 / ${number('minimumLikes')} 赞`,
      });
      setEditing(false);
    } catch {
      setError('网络连接失败，任务尚未确认保存。请重试。');
    } finally {
      setSubmitting(false);
    }
  }

  async function createRun(campaign: CampaignSummary) {
    if (creatingRunId) return;
    setCreatingRunId(campaign.id);
    setError('');
    setRunMessage('');
    try {
      await fetch(`/campaigns/${encodeURIComponent(campaign.id)}/runs`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-csrf-token': csrfToken },
      }).then(readResponse<{ id: string }>);
      setRunMessage(
        `「${campaign.name}」运行已创建。请打开本机采集助手，选择画像并点击“人工开始”。`,
      );
    } catch {
      setError('创建运行失败，请检查登录状态和网络，再刷新运行监控确认是否已创建。');
    } finally {
      setCreatingRunId(null);
    }
  }

  return (
    <section>
      <header className="section-page-header">
        <div>
          <p className="eyebrow">CAMPAIGNS / RULES</p>
          <h1>筛选任务</h1>
          <p className="lede">每次运行都会冻结一份规则快照。以后修改条件，也不会改变旧结论。</p>
        </div>
        {canWrite ? (
          <button
            className="primary-action"
            onClick={() => setEditing((value) => !value)}
            type="button"
          >
            {editing ? '收起编辑' : '新建筛选任务'}
          </button>
        ) : null}
      </header>
      <div className="workflow-callout">
        <div>
          <strong>任务保存条件，运行才会进入采集队列。</strong>
          <p>保存后点击「创建运行」，再到本机助手开始。网页不会远程操作你的抖音账号。</p>
        </div>
        <a href={COLLECTOR_URL} target="_blank" rel="noreferrer" className="secondary-action">
          打开本机助手 ↗
        </a>
      </div>
      {runMessage ? (
        <div className="success-banner" role="status">
          {runMessage}
          <button className="text-button dark-text-button" onClick={onOpenRuns} type="button">
            查看运行监控 →
          </button>
        </div>
      ) : null}
      {error && !editing ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {editing ? (
        <form className="campaign-editor" onSubmit={saveCampaign}>
          <div className="editor-heading">
            <div>
              <span>硬筛</span>
              <strong>先用明确数据判断</strong>
            </div>
            <p>空值会进入“未知”，不会按 0 处理。</p>
          </div>
          <div className="editor-grid editor-grid-wide">
            <label>
              任务名称
              <input defaultValue="校园素人爆款" name="name" required />
            </label>
            <label className="wide-field">
              推荐画像说明
              <textarea
                defaultValue="校园日常、宿舍生活、年轻情侣或朋友互动"
                name="recommendationProfileDescription"
              />
            </label>
            <label>
              粉丝下限
              <input defaultValue="0" min="0" name="followerMin" required type="number" />
            </label>
            <label>
              粉丝上限
              <input defaultValue="5000" min="0" name="followerMax" required type="number" />
            </label>
            <label>
              观察天数
              <input defaultValue="15" min="1" name="windowDays" required type="number" />
            </label>
            <label>
              点赞门槛
              <input defaultValue="10000" min="0" name="minimumLikes" required type="number" />
            </label>
          </div>

          <div className="editor-heading human-heading">
            <div>
              <span>人工与停止条件</span>
              <strong>把最终决定留给运营</strong>
            </div>
          </div>
          <div className="editor-grid">
            <label>
              最多浏览作品
              <input defaultValue="100" min="1" name="maxFeedItems" required type="number" />
            </label>
            <label>
              最长运行分钟
              <input defaultValue="60" min="1" name="maxDurationMinutes" required type="number" />
            </label>
            <label>
              目标候选数
              <input defaultValue="30" min="1" name="targetCandidates" required type="number" />
            </label>
            <label className="wide-field">
              人工复核项（可选）
              <input name="manualLabel" placeholder="例如：主页内容是否适合品牌" />
            </label>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="editor-actions">
            <button
              className="text-button dark-text-button"
              onClick={() => setEditing(false)}
              type="button"
            >
              取消
            </button>
            <button className="primary-action" disabled={submitting} type="submit">
              {submitting ? '正在保存…' : '保存筛选任务'}
            </button>
          </div>
        </form>
      ) : null}

      {lastSaved ? (
        <aside className="saved-summary" aria-live="polite">
          <span>已保存</span>
          <strong>{lastSaved.name}</strong>
          <p>
            粉丝 {lastSaved.followers} · 爆款 {lastSaved.viral}
          </p>
        </aside>
      ) : null}

      <div className="campaign-list">
        {campaigns.length ? (
          campaigns.map((campaign) => (
            <article className="campaign-card" key={campaign.id}>
              <span className="campaign-rule-mark" aria-hidden="true" />
              <div>
                <strong>{campaign.name}</strong>
                <p>{campaign.recommendation_profile_description || '未填写推荐画像说明'}</p>
              </div>
              <span
                className={`role-chip ${campaign.status === 'active' ? 'role-operator' : 'role-readonly'}`}
              >
                {campaign.status === 'active' ? '可创建运行' : '已归档'}
              </span>
              {canWrite && campaign.status === 'active' ? (
                <button
                  className="secondary-action"
                  disabled={Boolean(creatingRunId)}
                  onClick={() => void createRun(campaign)}
                  type="button"
                >
                  {creatingRunId === campaign.id ? '正在创建…' : '创建运行'}
                </button>
              ) : null}
            </article>
          ))
        ) : (
          <div className="data-panel">
            <EmptyPanel text="还没有筛选任务。先新建一个，把这次想找的人说明白。" />
          </div>
        )}
      </div>
    </section>
  );
}
