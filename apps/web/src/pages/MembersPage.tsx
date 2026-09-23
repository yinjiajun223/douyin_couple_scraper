import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import type { Member, PendingInvitation } from '../types';
import { ApiError, readResponse } from '../api/client';
import { memberRoleOptions } from '../constants';
import { formatRunTime, roleLabel } from '../lib/format';
import { FilterSelect, FormSelect } from '../components/FilterSelect';
import { EmptyPanel } from '../components/EmptyPanel';

type PendingAction =
  | { kind: 'disable'; memberId: string }
  | { kind: 'revoke'; invitationId: string }
  | { kind: 'role'; memberId: string; role: Member['role'] }
  | null;

export function MembersPage({
  members,
  csrfToken,
  currentUserId,
  onChanged,
}: {
  members: Member[];
  csrfToken: string;
  currentUserId: string;
  onChanged: () => void;
}) {
  const [showInvite, setShowInvite] = useState(false);
  const [inviteToken, setInviteToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [invitationsError, setInvitationsError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  // 二次确认只允许挂在一个目标上：同时展开两条确认条容易点错人。
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, Member['role']>>({});

  const activeAdminCount = members.filter(
    (member) => member.role === 'admin' && member.status === 'active',
  ).length;

  const loadInvitations = useCallback(async () => {
    try {
      const response = await fetch('/invitations', { credentials: 'include' });
      setInvitations(
        (await readResponse<{ invitations: PendingInvitation[] }>(response)).invitations,
      );
      setInvitationsError('');
    } catch (error) {
      setInvitationsError(
        error instanceof ApiError ? error.message : '邀请列表加载失败，请稍后重试。',
      );
    }
  }, []);

  useEffect(() => {
    void loadInvitations();
  }, [loadInvitations]);

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
      await loadInvitations();
    } catch (error) {
      setInviteError(
        error instanceof ApiError
          ? error.message
          : '邀请生成失败，请检查邮箱是否已加入团队、登录状态和网络。',
      );
    } finally {
      setSubmitting(false);
    }
  }

  /** 成员操作统一走这里：失败时把服务端给的原因原样显示在列表旁边。 */
  async function runMemberAction(
    path: string,
    body: Record<string, unknown> | null,
    successMessage: string,
    method = 'POST',
  ) {
    if (submitting) return;
    setSubmitting(true);
    setActionMessage('');
    setActionError('');
    try {
      const response = await fetch(path, {
        credentials: 'include',
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          'x-csrf-token': csrfToken,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        method,
      });
      await readResponse<unknown>(response);
      setActionMessage(successMessage);
      setPendingAction(null);
      onChanged();
      await loadInvitations();
    } catch (error) {
      setActionError(
        error instanceof ApiError ? error.message : '网络失败，本次操作未确认，请刷新后重试。',
      );
    } finally {
      setSubmitting(false);
    }
  }

  function requestMemberAction(member: Member, kind: 'disable' | 'role') {
    setActionMessage('');
    setActionError('');
    if (kind === 'disable') {
      setPendingAction({ kind: 'disable', memberId: member.id });
      return;
    }
    const nextRole = roleDrafts[member.id] ?? member.role;
    if (nextRole === member.role) return;
    // 只有「从管理员降下来」需要二次确认：那会移除管理员身份，和停用同级。
    if (member.role === 'admin') {
      setPendingAction({ kind: 'role', memberId: member.id, role: nextRole });
      return;
    }
    void runMemberAction(
      `/members/${member.id}/role`,
      { role: nextRole },
      `已把「${member.displayName}」的角色改为${roleLabel(nextRole)}，对方无需重新登录即刻生效。`,
      'PUT',
    );
  }

  function guardReason(member: Member): string {
    if (member.id === currentUserId) return '不能停用当前登录的自己，请让另一名管理员操作。';
    if (member.role === 'admin' && member.status === 'active' && activeAdminCount <= 1)
      return '工作区必须保留至少一名启用状态的管理员，请先提升另一名管理员。';
    return '';
  }

  /**
   * 降级走的是另一条护栏：停用挡的是「不能停用自己」，降级挡的是「不能撤掉最后一名管理员」。
   * 两者都可能落在同一个人身上（我就是唯一管理员），所以说明文案按需并列显示。
   * 服务端同样会拒绝并返回 409，这里只是让运营在点下去之前就知道原因。
   */
  function roleGuardReason(member: Member): string {
    if (member.role === 'admin' && member.status === 'active' && activeAdminCount <= 1)
      return '工作区必须保留至少一名启用状态的管理员，请先提升另一名管理员。';
    return '';
  }

  function guardNotes(member: Member): string {
    const disableGuard = guardReason(member);
    const roleGuard = roleGuardReason(member);
    if (!disableGuard) return roleGuard;
    if (!roleGuard) return disableGuard;
    // 同一个人同时撞上两条护栏（我就是唯一启用管理员）时合并成一句，免得读两遍近似文案。
    return `不能停用或降级当前登录的自己：${roleGuard}`;
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

      {actionMessage ? (
        <p className="workflow-current" role="status">
          {actionMessage}
        </p>
      ) : null}
      {actionError ? (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="data-panel">
        <div className="table-heading">
          <span>成员</span>
          <span>{members.length} 人</span>
        </div>
        {members.length ? (
          members.map((member) => {
            const guard = guardReason(member);
            const roleGuard = roleGuardReason(member);
            const notes = guardNotes(member);
            const isSelf = member.id === currentUserId;
            const roleDraft = roleDrafts[member.id] ?? member.role;
            const disableConfirm =
              pendingAction?.kind === 'disable' && pendingAction.memberId === member.id;
            const roleConfirm =
              pendingAction?.kind === 'role' && pendingAction.memberId === member.id
                ? pendingAction.role
                : null;
            return (
              <div className="member-entry" key={member.id}>
                <article className="member-row">
                  <span className="user-avatar light-avatar">{member.displayName.slice(0, 1)}</span>
                  <div>
                    <strong>
                      {member.displayName}
                      {isSelf ? '（你）' : ''}
                    </strong>
                    <span>{member.email}</span>
                  </div>
                  <span className={`role-chip role-${member.role}`}>{roleLabel(member.role)}</span>
                  <span className="row-status">
                    {member.status === 'active' ? '使用中' : '已停用'}
                  </span>
                  <div className="campaign-card-actions">
                    <FilterSelect
                      disabled={submitting || Boolean(roleGuard)}
                      label="角色"
                      onChange={(value) =>
                        setRoleDrafts((current) => ({
                          ...current,
                          [member.id]: value as Member['role'],
                        }))
                      }
                      options={memberRoleOptions}
                      value={roleDraft}
                    />
                    <button
                      disabled={submitting || roleDraft === member.role || Boolean(roleGuard)}
                      onClick={() => requestMemberAction(member, 'role')}
                      title={roleGuard || undefined}
                      type="button"
                    >
                      保存角色
                    </button>
                    {member.status === 'active' ? (
                      <button
                        className="secondary-action"
                        disabled={submitting || Boolean(guard)}
                        onClick={() => requestMemberAction(member, 'disable')}
                        title={guard || undefined}
                        type="button"
                      >
                        停用
                      </button>
                    ) : (
                      <button
                        className="secondary-action"
                        disabled={submitting}
                        onClick={() =>
                          void runMemberAction(
                            `/members/${member.id}/enable`,
                            null,
                            `已启用「${member.displayName}」。其名下设备保持已撤销，需要本人在本机重新配对。`,
                          )
                        }
                        type="button"
                      >
                        启用
                      </button>
                    )}
                  </div>
                  {notes ? <small className="member-guard-note">{notes}</small> : null}
                </article>
                {disableConfirm ? (
                  <div className="campaign-confirm-strip">
                    <span>
                      停用「{member.displayName}」？其登录会话与名下采集设备会立即失效，
                      已入库的候选与证据不受影响；之后可以随时启用，但设备需要本人重新配对。
                    </span>
                    <div className="campaign-confirm-actions">
                      <button
                        className="secondary-action"
                        disabled={submitting}
                        onClick={() =>
                          void runMemberAction(
                            `/members/${member.id}/disable`,
                            null,
                            `已停用「${member.displayName}」，其会话与设备已撤销。`,
                          )
                        }
                        type="button"
                      >
                        {submitting ? '正在停用…' : '确认停用'}
                      </button>
                      <button
                        disabled={submitting}
                        onClick={() => setPendingAction(null)}
                        type="button"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}
                {roleConfirm ? (
                  <div className="campaign-confirm-strip">
                    <span>
                      把「{member.displayName}」从管理员降为{roleLabel(roleConfirm)}？
                      降级后对方立即失去管理权限（无需重新登录），且不能再管理成员与筛选模板。
                    </span>
                    <div className="campaign-confirm-actions">
                      <button
                        className="secondary-action"
                        disabled={submitting}
                        onClick={() =>
                          void runMemberAction(
                            `/members/${member.id}/role`,
                            { role: roleConfirm },
                            `已把「${member.displayName}」的角色改为${roleLabel(roleConfirm)}。`,
                            'PUT',
                          )
                        }
                        type="button"
                      >
                        {submitting ? '正在变更…' : '确认降级'}
                      </button>
                      <button
                        disabled={submitting}
                        onClick={() => setPendingAction(null)}
                        type="button"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        ) : (
          <EmptyPanel text="暂无成员数据。创建首位管理员后会显示在这里。" />
        )}
      </div>

      <div className="data-panel">
        <div className="table-heading">
          <span>待处理邀请</span>
          <span>{invitations.length} 条</span>
        </div>
        {invitationsError ? (
          <p className="form-error" role="alert">
            {invitationsError}
          </p>
        ) : null}
        {invitations.length ? (
          invitations.map((invitation) => {
            const revokeConfirm =
              pendingAction?.kind === 'revoke' && pendingAction.invitationId === invitation.id;
            return (
              <div className="member-entry" key={invitation.id}>
                <article className="member-row">
                  <span className="user-avatar light-avatar">邀</span>
                  <div>
                    <strong>{invitation.email}</strong>
                    <span>
                      {formatRunTime(invitation.invitedAt)} 发出 ·{' '}
                      {formatRunTime(invitation.expiresAt)} 过期
                      {invitation.invitedByDisplayName
                        ? ` · ${invitation.invitedByDisplayName}`
                        : ''}
                    </span>
                  </div>
                  <span className={`role-chip role-${invitation.role}`}>
                    {roleLabel(invitation.role)}
                  </span>
                  <div className="campaign-card-actions">
                    <button
                      className="secondary-action"
                      disabled={submitting}
                      onClick={() => {
                        setActionMessage('');
                        setActionError('');
                        setPendingAction({ kind: 'revoke', invitationId: invitation.id });
                      }}
                      type="button"
                    >
                      撤销邀请
                    </button>
                  </div>
                </article>
                {revokeConfirm ? (
                  <div className="campaign-confirm-strip">
                    <span>
                      撤销发给 {invitation.email} 的邀请？撤销后这条链接立即失效，
                      对方无法再用它创建账户；如仍需邀请，需要重新发出一条。
                    </span>
                    <div className="campaign-confirm-actions">
                      <button
                        className="secondary-action"
                        disabled={submitting}
                        onClick={() =>
                          void runMemberAction(
                            `/invitations/${invitation.id}/revoke`,
                            null,
                            `已撤销发给 ${invitation.email} 的邀请。`,
                          )
                        }
                        type="button"
                      >
                        {submitting ? '正在撤销…' : '确认撤销'}
                      </button>
                      <button
                        disabled={submitting}
                        onClick={() => setPendingAction(null)}
                        type="button"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        ) : (
          <EmptyPanel text="没有待处理的邀请。已被接受、已撤销或已过期的邀请不会出现在这里。" />
        )}
      </div>
    </section>
  );
}
