import { useState } from 'react';
import type { FormEvent } from 'react';

import type { CampaignTemplateSummary } from '../types';
import {
  buildRuleSet,
  describeRuleSet,
  findViralRule,
  readRuleForm,
  ruleFieldDefaults,
} from '../lib/campaign-rules';
import { EmptyPanel } from '../components/EmptyPanel';
import { HardRuleInputs, StopConditionInputs } from '../components/RuleFieldInputs';

type EditorState = { mode: 'create' } | { mode: 'edit'; templateId: string };

export function TemplatesPage({
  templates,
  csrfToken,
  onChanged,
}: {
  templates: CampaignTemplateSummary[];
  csrfToken: string;
  onChanged: () => void;
}) {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pendingArchiveId, setPendingArchiveId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const editingTemplate =
    editor?.mode === 'edit'
      ? (templates.find((template) => template.id === editor.templateId) ?? null)
      : null;
  const baseRules = editingTemplate?.rules_json ?? null;
  const defaults = ruleFieldDefaults(baseRules);
  const showViral = !baseRules || findViralRule(baseRules) !== null;
  const formKey = editingTemplate?.id ?? 'new';
  const pendingArchive = pendingArchiveId
    ? (templates.find((template) => template.id === pendingArchiveId) ?? null)
    : null;

  async function saveTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError('');
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const description = String(form.get('description') ?? '');
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
    setSubmitting(true);
    try {
      const response = await fetch(
        editingTemplate
          ? `/campaign-templates/${encodeURIComponent(editingTemplate.id)}`
          : '/campaign-templates',
        {
          method: editingTemplate ? 'PATCH' : 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify(
            editingTemplate
              ? { name, description, rules, expectedVersion: editingTemplate.version }
              : { name, description, rules },
          ),
        },
      );
      // 版本冲突说明别的成员已经改过这个模板：刷新到最新条件，不做静默合并。
      if (response.status === 409) {
        setError('这个模板已被其他成员修改，已为你刷新最新内容。请重新打开编辑后再保存。');
        setEditor(null);
        onChanged();
        return;
      }
      if (!response.ok) {
        setError('保存失败。请检查数值范围和必填内容。');
        return;
      }
      setMessage(
        editingTemplate
          ? `模板「${name}」已更新。已存在的筛选任务与运行不会跟着变化。`
          : `模板「${name}」已保存。新建筛选任务时可以直接选用。`,
      );
      setEditor(null);
      onChanged();
    } catch {
      setError('网络连接失败，模板尚未确认保存。请重试。');
    } finally {
      setSubmitting(false);
    }
  }

  async function archiveTemplate() {
    if (!pendingArchive || actionBusy) return;
    setActionBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/campaign-templates/${encodeURIComponent(pendingArchive.id)}/archive`,
        {
          method: 'POST',
          credentials: 'include',
          // 归档没有请求体，带上 content-type 会让 Fastify 报「JSON body 为空」。
          headers: { 'x-csrf-token': csrfToken },
        },
      );
      if (!response.ok) {
        setError('归档失败。请刷新后重试。');
        return;
      }
      setMessage(
        `模板「${pendingArchive.name}」已归档，不再出现在新建任务的下拉里；已引用它的任务不受影响。`,
      );
      setPendingArchiveId(null);
      onChanged();
    } catch {
      setError('网络连接失败，操作尚未确认。请重试。');
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <section>
      <header className="section-page-header">
        <div>
          <p className="eyebrow">SETTINGS / TEMPLATES</p>
          <h1>筛选模板</h1>
          <p className="lede">管理员维护团队共用的规则起点，运行时仍会冻结独立快照。</p>
        </div>
        <button
          className="primary-action"
          onClick={() =>
            setEditor((current) =>
              current && current.mode === 'create' ? null : { mode: 'create' },
            )
          }
          type="button"
        >
          {editor?.mode === 'create' ? '收起编辑' : '新建模板'}
        </button>
      </header>

      {message ? (
        <div className="success-banner" role="status">
          {message}
        </div>
      ) : null}
      {error && !editor ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {editor ? (
        <form className="campaign-editor" key={formKey} onSubmit={saveTemplate}>
          <div className="editor-heading">
            <div>
              <span>模板规则</span>
              <strong>{editingTemplate ? '修改这个模板的条件' : '把团队常用的条件存成起点'}</strong>
            </div>
            <p>模板只是起点，任务保存后可以继续改。</p>
          </div>
          <div className="editor-grid editor-grid-wide">
            <label>
              模板名称
              <input defaultValue={editingTemplate?.name ?? ''} name="name" required />
            </label>
            <label className="wide-field">
              说明
              <textarea defaultValue={editingTemplate?.description ?? ''} name="description" />
            </label>
            <HardRuleInputs defaults={defaults} showViral={showViral} />
          </div>

          <div className="editor-heading human-heading">
            <div>
              <span>人工与停止条件</span>
              <strong>把最终决定留给运营</strong>
            </div>
            {editingTemplate ? <p>留空的停止条件保持未设置，不会被填成默认值。</p> : null}
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
              {submitting ? '正在保存…' : editingTemplate ? '保存修改' : '保存模板'}
            </button>
          </div>
        </form>
      ) : null}

      {pendingArchive ? (
        <div className="campaign-confirm-strip">
          <span>
            归档「{pendingArchive.name}」？归档后不再出现在新建任务的下拉里，且当前无法在网页恢复。
          </span>
          <div className="campaign-confirm-actions">
            <button
              className="text-button dark-text-button"
              disabled={actionBusy}
              onClick={() => void archiveTemplate()}
              type="button"
            >
              {actionBusy ? '正在处理…' : '确认归档'}
            </button>
            <button
              className="text-button dark-text-button"
              onClick={() => setPendingArchiveId(null)}
              type="button"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      <div className="data-panel">
        {templates.length ? (
          templates.map((template) => (
            <article className="member-row" key={template.id}>
              <span className="candidate-avatar">模</span>
              <div>
                <strong>{template.name}</strong>
                <p>{template.description ?? '暂无说明'}</p>
                <p className="campaign-rule-summary">
                  v{template.version} · {describeRuleSet(template.rules_json)}
                </p>
              </div>
              <div className="campaign-card-actions">
                <button
                  className="text-button dark-text-button"
                  onClick={() => {
                    setError('');
                    setMessage('');
                    setEditor({ mode: 'edit', templateId: template.id });
                  }}
                  type="button"
                >
                  编辑
                </button>
                <button
                  className="text-button dark-text-button"
                  onClick={() => {
                    setError('');
                    setMessage('');
                    setPendingArchiveId(template.id);
                  }}
                  type="button"
                >
                  归档
                </button>
              </div>
            </article>
          ))
        ) : (
          <EmptyPanel text="还没有团队筛选模板。" />
        )}
      </div>
    </section>
  );
}
