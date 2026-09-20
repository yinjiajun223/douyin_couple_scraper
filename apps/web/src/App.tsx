import { useEffect, useState } from 'react';

import type { CurrentUser } from './types';
import { OperationsDesk } from './OperationsDesk';
import { LoadingScreen } from './pages/auth/LoadingScreen';
import { LoginScreen } from './pages/auth/LoginScreen';
import { InvitationAcceptance } from './pages/auth/InvitationAcceptance';

export function App() {
  const inviteToken = new URLSearchParams(window.location.search).get('invite');
  const [auth, setAuth] = useState<'loading' | 'anonymous' | 'authenticated'>('loading');
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [csrfToken, setCsrfToken] = useState(() => sessionStorage.getItem('douyin_csrf') ?? '');

  useEffect(() => {
    if (inviteToken) return;
    const controller = new AbortController();
    void fetch('/auth/me', { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('unauthenticated');
        return (await response.json()) as { user: CurrentUser; csrfToken?: string };
      })
      .then((result) => {
        if (result.csrfToken) {
          sessionStorage.setItem('douyin_csrf', result.csrfToken);
          setCsrfToken(result.csrfToken);
        }
        setUser(result.user);
        setAuth('authenticated');
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setAuth('anonymous');
      });
    return () => controller.abort();
  }, [inviteToken]);

  if (inviteToken) return <InvitationAcceptance token={inviteToken} />;
  if (auth === 'loading') return <LoadingScreen />;
  if (!user || auth === 'anonymous') {
    return (
      <LoginScreen
        onLoggedIn={(loggedInUser, token) => {
          sessionStorage.setItem('douyin_csrf', token);
          setCsrfToken(token);
          setUser(loggedInUser);
          setAuth('authenticated');
        }}
      />
    );
  }

  return (
    <OperationsDesk
      csrfToken={csrfToken}
      user={user}
      onLogout={() => {
        sessionStorage.removeItem('douyin_csrf');
        setUser(null);
        setAuth('anonymous');
      }}
    />
  );
}
