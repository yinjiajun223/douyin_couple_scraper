import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import type { CampaignSummary, CampaignTemplateSummary } from '../types';
import { readResponse } from '../api/client';
import {
  buildRuleSet,
  describeRuleSet,
  findViralRule,
  readRuleForm,
  ruleFieldDefaults,
} from '../lib/campaign-rules';
import { EmptyPanel } from '../components/EmptyPanel';
import { HardRuleInputs, StopConditionInputs } from '../components/RuleFieldInputs';

type EditorState = { mode: 'create'; templateId: string } | { mode: 'edit'; campaignId: string };
type PendingAction = { campaignId: string; kind: 'archive' | 'copy' };

export function CampaignsPage({
  campaigns,
  canWrite,
  csrfToken,
  templates,
  initialEditing,
  onChanged,
  onOpenRuns,
}: {
  campaigns: CampaignSummary[];
  canWrite: boolean;
  csrfToken: string;
  templates: CampaignTemplateSummary[];
  initialEditing: boolean;
  onChanged: () => void;
  onOpenRuns: () => void;
}) {
  const [editor, setEditor] = useState<EditorState | null>(
    initialEditing ? { mode: 'create', templateId: '' } : null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [creatingRunId, setCreatingRunId] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState('');
  const [lastSaved, setLastSaved] = useState<{ name: string; summary: string } | null>(null);
  const [error, setError] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [copyName, setCopyName] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    if (initialEditing) setEditor({ mode: 'create', templateId: '' });
  }, [initialEditing]);

  const editingCampaign =
    editor?.mode === 'edit'
      ? (campaigns.find((campaign) => campaign.id === editor.campaignId) ?? null)
      : null;
  const selectedTemplate =
    editor?.mode === 'create' && editor.templateId
      ? (templates.find((template) => template.id === editor.templateId) ?? null)
      : null;
  const baseRules = editingCampaign?.rules_json ?? selectedTemplate?.rules_json ?? null;
  const defaults = ruleFieldDefaults(baseRules);
  const showViral = !baseRules || findViralRule(baseRules) !== null;
  const formKey = editingCampaign?.id ?? selectedTemplate?.id ?? 'new';
  const pendingCampaign = pendingAction
    ? (campaigns.find((campaign) => campaign.id === pendingAction.campaignId) ?? null)
    : null;

  useEffect(() => {
    if (editor?.mode === 'edit' && !editingCampaign) setEditor(null);
  }, [editor, editingCampaign]);

  async function saveCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError('');
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const recommendationProfileDescription = String(
      form.get('recommendationProfileDescription') ?? '',
    );
    const values = readRuleForm(form);
    if (values.followerMax < values.followerMin) {
      setError('上限不能小于下限，请检查粉丝数范围。');
      return;
    }
    const rules = buildRuleSet(baseRules, values);
    if (!rules) {
      setError('保存失败。请检查数值范围和必填内容。');
      return;
    }
    const isEdit = editor?.mode === 'edit' && editingCampaign !== null;
    setSubmitting(true);
    try {
      const response = await fetch(
        isEdit ? `/campaigns/${encodeURIComponent(editingCampaign.id)}` : '/campaigns',
        {
          method: isEdit ? 'PATCH' : 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify(
            isEdit
              ? {
                  name,
                  recommendationProfileDescription,
                  rules,
                  expectedVersion: editingCampaign.version,
                }
              : {
                  name,
                  recommendationProfileDescription,
                  rules,
                  ...(selectedTemplate ? { templateId: selectedTemplate.id } : {}),
                },
          ),
        },
      );
      // 版本冲突说明同事已经改过这条任务：刷新到最新条件，不做静默合并。
      if (response.status === 409) {
        setError('这条任务已被同事修改，已为你刷新最新条件。请重新打开编辑后再保存。');
        setEditor(null);
        onChanged();
        return;
      }
      if (!response.ok) {
        setError('保存失败。请检查数值范围和必填内容。');
        return;
      }
      setLastSaved({ name, summary: describeRuleSet(rules) });
      setRunMessage(
        isEdit
          ? `「${name}」条件已更新。每次运行开始时都会冻结独立快照，本次修改只影响新的运行。`
          : `「${name}」已保存。点击「创建运行」，再到本机助手人工开始。`,
      );
      setEditor(null);
      onChanged();
    } catch {
      setError('网络连接失败，任务尚未确认保存。请重试。');
    } finally {
      setSubmitting(false);
    }
  }

  async function runPendingAction() {
    if (!pendingAction || !pendingCampaign || actionBusy) return;
    const { campaignId, kind } = pendingAction;
    if (kind === 'copy' && copyName.trim().length < 2) {
      setError('请填写新任务名称（至少 2 个字）。');
      return;
    }
    setActionBusy(true);
    setError('');
    try {
      const response = await fetch(
        kind === 'copy'
          ? `/campaigns/${encodeURIComponent(campaignId)}/copy`
          : `/campaigns/${encodeURIComponent(campaignId)}/archive`,
        {
          method: 'POST',
          credentials: 'include',
          // 归档没有请求体，带上 content-type 会让 Fastify 报「JSON body 为空」。
          headers:
            kind === 'copy'
              ? { 'content-type': 'application/json', 'x-csrf-token': csrfToken }
              : { 'x-csrf-token': csrfToken },
          body: kind === 'copy' ? JSON.stringify({ name: copyName.trim() }) : null,
        },
      );
      if (!response.ok) {
        setError(
          kind === 'copy'
            ? '复制失败。请检查名称是否重复，并确认登录状态。'
            : '归档失败。请刷新后重试。',
        );
        return;
      }
      setRunMessage(
        kind === 'copy'
          ? `已复制为「${copyName.trim()}」，可以在新任务上继续调整条件。`
          : `「${pendingCampaign.name}」已归档，不能再创建运行；历史运行与候选不受影响。`,
      );
      setPendingAction(null);
      setCopyName('');
      onChanged();
    } catch {
      setError('网络连接失败，操作尚未确认。请重试。');
    } finally {
      setActionBusy(false);
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
            onClick={() =>
              setEditor((current) =>
                current && current.mode === 'create' ? null : { mode: 'create', templateId: '' },
              )
            }
            type="button"
          >
            {editor?.mode === 'create' ? '收起编辑' : '新建筛选任务'}
          </button>
        ) : null}
      </header>
      <div className="workflow-callout">
        <div>
          <strong>任务保存条件，运行才会进入采集队列。</strong>
          <p>保存后点击「创建运行」，再到本机助手开始。网页不会远程操作你的抖音账号。</p>
        </div>
      </div>
      {runMessage ? (
        <div className="success-banner" role="status">
          {runMessage}
          <button className="text-button dark-text-button" onClick={onOpenRuns} type="button">
            查看运行监控 →
          </button>
        </div>
      ) : null}
      {error && !editor ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {editor ? (
        <form className="campaign-editor" key={formKey} onSubmit={saveCampaign}>
          <div className="editor-heading">
            <div>
              <span>硬筛</span>
              <strong>{editingCampaign ? '修改这条任务的条件' : '先用明确数据判断'}</strong>
            </div>
            <p>空值会进入“未知”，不会按 0 处理。</p>
          </div>
          <div className="editor-grid editor-grid-wide">
            {editor.mode === 'create' && templates.length ? (
              <label className="wide-field">
                从模板开始（可选）
                <select
                  onChange={(event) =>
                    setEditor({ mode: 'create', templateId: event.currentTarget.value })
                  }
                  value={editor.templateId}
                >
                  <option value="">不用模板，手动填写条件</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              任务名称
              <input defaultValue={editingCampaign?.name ?? '校园素人爆款'} name="name" required />
            </label>
            <label className="wide-field">
              推荐画像说明
              <textarea
                defaultValue={
                  editingCampaign
                    ? (editingCampaign.recommendation_profile_description ?? '')
                    : '校园日常、宿舍生活、年轻情侣或朋友互动'
                }
                name="recommendationProfileDescription"
              />
            </label>
            <HardRuleInputs defaults={defaults} showViral={showViral} />
          </div>

          <div className="editor-heading human-heading">
            <div>
              <span>人工与停止条件</span>
              <strong>把最终决定留给运营</strong>
            </div>
            {editingCampaign ? <p>留空的停止条件保持未设置，不会被填成默认值。</p> : null}
          </div>
          <div className="editor-grid">
            <StopConditionInputs defaults={defaults} />
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="editor-actions">
            <button
              className="text-button dark-text-button"
              onClick={() => setEditor(null)}
              type="button"
            >
              取消
            </button>
            <button className="primary-action" disabled={submitting} type="submit">
              {submitting ? '正在保存…' : editingCampaign ? '保存修改' : '保存筛选任务'}
            </button>
          </div>
        </form>
      ) : null}

      {lastSaved ? (
        <aside className="saved-summary" aria-live="polite">
          <span>已保存</span>
          <strong>{lastSaved.name}</strong>
          <p>{lastSaved.summary}</p>
        </aside>
      ) : null}

      {pendingCampaign && pendingAction ? (
        <div className="campaign-confirm-strip">
          {pendingAction.kind === 'copy' ? (
            <>
              <span>复制「{pendingCampaign.name}」为新任务</span>
              <input
                autoFocus
                onChange={(event) => setCopyName(event.currentTarget.value)}
                placeholder="新任务名称"
                value={copyName}
              />
            </>
          ) : (
            <span>
              归档「{pendingCampaign.name}
              」？归档后不能再创建运行，历史运行与候选不受影响，且当前无法在网页恢复。
            </span>
          )}
          <div className="campaign-confirm-actions">
            <button
              className="text-button dark-text-button"
              disabled={actionBusy}
              onClick={() => void runPendingAction()}
              type="button"
            >
              {actionBusy ? '正在处理…' : pendingAction.kind === 'copy' ? '确认复制' : '确认归档'}
            </button>
            <button
              className="text-button dark-text-button"
              onClick={() => {
                setPendingAction(null);
                setCopyName('');
              }}
              type="button"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      <div className="campaign-list">
        {campaigns.length ? (
          campaigns.map((campaign) => (
            <article className="campaign-card" key={campaign.id}>
              <span className="campaign-rule-mark" aria-hidden="true" />
              <div>
                <strong>{campaign.name}</strong>
                <p>{campaign.recommendation_profile_description || '未填写推荐画像说明'}</p>
                <p className="campaign-rule-summary">
                  v{campaign.version} · {describeRuleSet(campaign.rules_json)}
                </p>
              </div>
              <span
                className={`role-chip ${campaign.status === 'active' ? 'role-operator' : 'role-readonly'}`}
              >
                {campaign.status === 'active' ? '可创建运行' : '已归档'}
              </span>
              {canWrite ? (
                <div className="campaign-card-actions">
                  {campaign.status === 'active' && campaign.rules_json ? (
                    <button
                      className="text-button dark-text-button"
                      onClick={() => {
                        setError('');
                        setRunMessage('');
                        setEditor({ mode: 'edit', campaignId: campaign.id });
                      }}
                      type="button"
                    >
                      编辑
                    </button>
                  ) : null}
                  <button
                    className="text-button dark-text-button"
                    onClick={() => {
                      setError('');
                      setRunMessage('');
                      setCopyName(`${campaign.name} 副本`);
                      setPendingAction({ campaignId: campaign.id, kind: 'copy' });
                    }}
                    type="button"
                  >
                    复制
                  </button>
                  {campaign.status === 'active' ? (
                    <button
                      className="text-button dark-text-button"
                      onClick={() => {
                        setError('');
                        setRunMessage('');
                        setPendingAction({ campaignId: campaign.id, kind: 'archive' });
                      }}
                      type="button"
                    >
                      归档
                    </button>
                  ) : null}
                  {campaign.status === 'active' ? (
                    <button
                      className="secondary-action"
                      disabled={Boolean(creatingRunId)}
                      onClick={() => void createRun(campaign)}
                      type="button"
                    >
                      {creatingRunId === campaign.id ? '正在创建…' : '创建运行'}
                    </button>
                  ) : null}
                </div>
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
