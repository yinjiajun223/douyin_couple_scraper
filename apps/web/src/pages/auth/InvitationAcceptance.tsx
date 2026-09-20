import { useState } from 'react';
import type { FormEvent } from 'react';

export function InvitationAcceptance({ token }: { token: string }) {
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    if (submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch('/auth/invitations/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          displayName: form.get('displayName'),
          password: form.get('password'),
        }),
      });
      if (!response.ok) {
        setError('邀请已过期、已使用，或填写内容不符合要求。');
        return;
      }
      setCompleted(true);
    } catch {
      setError('网络连接失败，请检查网络后重新提交。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-layout invite-layout">
      <section className="invite-ticket">
        <span className="ticket-notch" aria-hidden="true" />
        <p className="eyebrow">一次性团队邀请</p>
        <h1>{completed ? '账号已经准备好。' : '加入星探台，接着把人找准。'}</h1>
        <p className="lede">
          {completed
            ? '返回登录页，使用刚刚设置的密码登录。'
            : '这条链接只能使用一次，并会在指定时间后失效。'}
        </p>
        {completed ? (
          <a className="primary-action inline-action" href="/">
            前往登录
          </a>
        ) : (
          <form className="stack-form" onSubmit={submit}>
            <label>
              你的称呼
              <input autoComplete="name" name="displayName" required />
            </label>
            <label>
              设置密码
              <input
                autoComplete="new-password"
                minLength={12}
                name="password"
                required
                type="password"
              />
            </label>
            <p className="field-hint">至少 12 位，包含大写字母、小写字母和数字。</p>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <button className="primary-action wide-action" disabled={submitting} type="submit">
              {submitting ? '正在创建…' : '接受邀请并创建账号'}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
