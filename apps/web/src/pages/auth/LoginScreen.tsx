import { useState } from 'react';
import type { FormEvent } from 'react';

import { DEFAULT_WORKSPACE_ID } from '../../constants';
import type { CurrentUser } from '../../types';

export function LoginScreen({
  onLoggedIn,
}: {
  onLoggedIn: (user: CurrentUser, csrfToken: string) => void;
}) {
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: DEFAULT_WORKSPACE_ID,
          email: form.get('email'),
          password: form.get('password'),
        }),
      });
      if (!response.ok) throw new Error('登录信息不正确，或账户已停用。');
      const result = (await response.json()) as { user: CurrentUser; csrfToken: string };
      onLoggedIn(result.user, result.csrfToken);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '登录失败，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-story" aria-labelledby="login-title">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">
            星
          </span>
          <div>
            <p className="brand-name">星探台</p>
            <p className="brand-caption">DOUYIN / TEAM DESK</p>
          </div>
        </div>
        <div>
          <p className="eyebrow">把发现变成团队资产</p>
          <h1 id="login-title">每一个判断，都能回到当时看到的证据。</h1>
          <p className="lede">登录后继续管理筛选任务、候选复核与合作进度。</p>
        </div>
        <p className="safety-note">抖音登录状态只保留在运营电脑，不会上传到服务器。</p>
      </section>

      <section className="auth-card">
        <p className="eyebrow">内部成员登录</p>
        <h2>回到工作台</h2>
        <form className="stack-form" onSubmit={submit}>
          <label>
            工作邮箱
            <input
              autoComplete="email"
              name="email"
              placeholder="name@company.com"
              required
              type="email"
            />
          </label>
          <label>
            密码
            <input autoComplete="current-password" name="password" required type="password" />
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="primary-action wide-action" disabled={submitting} type="submit">
            {submitting ? '正在登录…' : '登录工作台'}
          </button>
        </form>
        <p className="form-footnote">没有账号？请联系管理员发送一次性邀请链接。</p>
      </section>
    </main>
  );
}
