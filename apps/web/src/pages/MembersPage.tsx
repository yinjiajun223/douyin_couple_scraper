import { useState } from 'react';
import type { FormEvent } from 'react';

import type { Member } from '../types';
import { readResponse } from '../api/client';
import { memberRoleOptions } from '../constants';
import { roleLabel } from '../lib/format';
import { FormSelect } from '../components/FilterSelect';
import { EmptyPanel } from '../components/EmptyPanel';

export function MembersPage({ members, csrfToken }: { members: Member[]; csrfToken: string }) {
  const [showInvite, setShowInvite] = useState(false);
  const [inviteToken, setInviteToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [inviteError, setInviteError] = useState('');

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (submitting) return;
    setSubmitting(true);
    setInviteError('');
    setInviteToken('');
    try {
      const response = await fetch('/invitations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({
          email: form.get('email'),
          role: form.get('role'),
          expiresInHours: 24,
        }),
      });
      setInviteToken((await readResponse<{ token: string }>(response)).token);
    } catch {
      setInviteError('邀请生成失败，请检查邮箱是否已加入团队、登录状态和网络。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <header className="section-page-header">
        <div>
          <p className="eyebrow">ACCESS / TEAM</p>
          <h1>成员与邀请</h1>
          <p className="lede">账号只通过管理员邀请加入。邀请链接一次有效，过期自动失效。</p>
        </div>
        <button
          className="primary-action"
          onClick={() => setShowInvite((open) => !open)}
          type="button"
        >
          邀请成员
        </button>
      </header>
      {showInvite ? (
        <form className="inline-form" onSubmit={invite}>
          <label>
            工作邮箱
            <input name="email" required type="email" />
          </label>
          <FormSelect
            defaultValue="operator"
            label="角色"
            name="role"
            options={memberRoleOptions}
          />
          <button className="secondary-action" disabled={submitting} type="submit">
            {submitting ? '正在生成…' : '生成邀请链接'}
          </button>
          {inviteError ? (
            <p className="form-error" role="alert">
              {inviteError}
            </p>
          ) : null}
          {inviteToken ? (
            <output className="token-output">
              {window.location.origin}/?invite={encodeURIComponent(inviteToken)}
            </output>
          ) : null}
        </form>
      ) : null}
      <div className="data-panel">
        <div className="table-heading">
          <span>成员</span>
          <span>{members.length} 人</span>
        </div>
        {members.length ? (
          members.map((member) => (
            <article className="member-row" key={member.id}>
              <span className="user-avatar light-avatar">{member.displayName.slice(0, 1)}</span>
              <div>
                <strong>{member.displayName}</strong>
                <span>{member.email}</span>
              </div>
              <span className={`role-chip role-${member.role}`}>{roleLabel(member.role)}</span>
              <span className="row-status">{member.status === 'active' ? '使用中' : '已停用'}</span>
            </article>
          ))
        ) : (
          <EmptyPanel text="暂无成员数据。创建首位管理员后会显示在这里。" />
        )}
      </div>
    </section>
  );
}
