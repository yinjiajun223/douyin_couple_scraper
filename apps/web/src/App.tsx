import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, WheelEvent } from 'react';

type Role = 'admin' | 'operator' | 'readonly';
type View =
  | 'today'
  | 'campaigns'
  | 'runs'
  | 'candidates'
  | 'members'
  | 'devices'
  | 'ai'
  | 'templates'
  | 'audit';

interface CurrentUser {
  id: string;
  workspaceId: string;
  email: string;
  displayName: string;
  role: Role;
}

interface Member {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: 'active' | 'disabled';
}

interface Device {
  id: string;
  name: string;
  ownerDisplayName: string;
  status: 'active' | 'revoked';
  collectorVersion: string | null;
  lastSeenAt: string | null;
}

interface CampaignSummary {
  id: string;
  name: string;
  recommendation_profile_description: string | null;
  status: 'active' | 'archived';
  version: number;
}

interface RunSummary {
  id: string;
  campaignId: string;
  campaignName: string;
  ruleVersion: number;
  status: 'ready' | 'claimed' | 'running' | 'paused' | 'completed' | 'failed' | 'terminated';
  stopReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  progress: {
    feedItemsSeen: number;
    creatorProfilesSeen: number;
    candidatesFound: number;
    elapsedSeconds: number;
  };
  device: { id: string; name: string } | null;
  claimedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CandidateSummary {
  id: string;
  campaignName: string;
  nickname: string;
  biography: string | null;
  profileUrl: string;
  followerCount: number | null;
  firstVisibleAt: string;
  observedAt: string;
  hardFilterStatus: 'pass' | 'fail' | 'unknown';
  manualDecision: 'pending' | 'approved' | 'rejected';
  pipelineStatus: string;
  tags: string[];
  ownerUserId?: string | null;
}

interface DashboardSummary {
  failedRuns: number;
  myAssignments: number;
  pendingReview: number;
  runningRuns: number;
  toContact: number;
}

interface CandidateDetailData {
  candidate: {
    id: string;
    campaignName: string;
    hardFilterStatus: 'pass' | 'fail' | 'unknown';
    pipelineStatus: string;
    version?: number;
  };
  observations: Array<{
    id: string;
    nickname: string;
    biography: string | null;
    profileUrl: string;
    followerCount: number | null;
    followerCountRaw: string | null;
    observedAt: string;
    device: { id: string; name: string };
  }>;
  sources: Array<{
    runId: string;
    campaignName: string;
    device: { id: string; name: string };
    observationCount: number;
    lastObservedAt: string;
  }>;
  evaluations: Array<{
    id: string;
    ruleVersion: number;
    ruleKey: string;
    outcome: 'pass' | 'fail' | 'unknown';
    evidence: Record<string, unknown>;
    matchedPost: {
      observationId: string;
      url: string;
      likeCount: number | null;
      likeCountRaw: string | null;
      publishedAt: string | null;
    } | null;
    evaluatedAt: string;
  }>;
  aiAnalyses?: Array<{
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'unavailable' | 'failed';
    providerLabel: string | null;
    model: string | null;
    promptVersion: string;
    result: {
      estimatedAge?:
        | { status: 'estimated'; minimum: number; maximum: number; confidence: number }
        | { status: 'unknown'; reason: string; confidence: 0 };
      amateurStatus?: { value: string; confidence: number };
      suitability?: { value: string; confidence: number };
      riskFlags?: Array<{ code: string; severity: string; explanation: string }>;
      summary?: string;
    } | null;
    error: { code: string | null; message: string | null } | null;
    createdAt: string;
  }>;
  media?: Array<{
    id: string;
    purpose: 'profile_screenshot' | 'post_screenshot';
    mimeType: string;
    createdAt: string;
  }>;
  workflow?: {
    candidateVersion: number;
    pipelineStatus: string;
    reviews: Array<{
      id: string;
      decision: 'pending' | 'approved' | 'rejected';
      reason: string | null;
      reviewerDisplayName: string;
      createdAt: string;
    }>;
    outreach: {
      ownerUserId: string | null;
      ownerDisplayName: string | null;
      contactChannel: string | null;
      contactValue: string | null;
      quotedAmount: number | null;
      currency: string | null;
      nextFollowUpAt: string | null;
      nextAction: string | null;
      version: number;
    } | null;
    notes: Array<{
      id: string;
      body: string;
      authorDisplayName: string;
      createdAt: string;
    }>;
    events: Array<{
      id: string;
      eventType: string;
      previousStatus: string | null;
      nextStatus: string | null;
      actorDisplayName: string | null;
      createdAt: string;
    }>;
  };
}

interface AiConnectionSummary {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  credential: 'configured';
  status: 'disabled' | 'testing' | 'enabled' | 'failed';
  capabilities: { images: boolean; jsonSchema: boolean };
  lastTestResult: {
    overall?: 'passed' | 'partial' | 'failed';
    text?: { status: string };
    images?: { status: string };
    jsonSchema?: { status: string };
  } | null;
}

interface CampaignTemplateSummary {
  id: string;
  name: string;
  description: string | null;
  version: number;
}

interface AuditEventSummary {
  id: string;
  action: string;
  subjectType: string;
  actorUserId: string | null;
  createdAt: string;
}

const DEFAULT_WORKSPACE_ID =
  import.meta.env.VITE_WORKSPACE_ID ?? '00000000-0000-4000-8000-000000000001';

const COLLECTOR_URL = 'http://127.0.0.1:43127';

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok)
    throw new Error(
      response.status === 401 ? '登录已过期，请重新登录。' : '请求失败，请检查网络后重试。',
    );
  return (await response.json()) as T;
}

const stages = [
  { label: '硬筛数据', detail: '粉丝与近 15 天作品', tone: 'verified' },
  { label: 'AI 辅助', detail: '年龄、素人属性与内容', tone: 'assisted' },
  { label: '人工确认', detail: '运营人员保留最终判断', tone: 'human' },
] as const;

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

function LoadingScreen() {
  return (
    <main className="auth-layout" aria-busy="true">
      <section className="auth-card loading-card">
        <span className="brand-mark" aria-hidden="true">
          星
        </span>
        <p className="eyebrow">正在确认工作台权限</p>
        <div className="loading-rule" aria-hidden="true" />
      </section>
    </main>
  );
}

function LoginScreen({
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

function InvitationAcceptance({ token }: { token: string }) {
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

function OperationsDesk({
  user,
  csrfToken,
  onLogout,
}: {
  user: CurrentUser;
  csrfToken: string;
  onLogout: () => void;
}) {
  const [view, setView] = useState<View>('today');
  const [refreshKey, setRefreshKey] = useState(0);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [createRequested, setCreateRequested] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [aiConnections, setAiConnections] = useState<AiConnectionSummary[]>([]);
  const [dashboard, setDashboard] = useState<DashboardSummary>({
    failedRuns: 0,
    myAssignments: 0,
    pendingReview: 0,
    runningRuns: 0,
    toContact: 0,
  });
  const [candidatePreset, setCandidatePreset] = useState<
    'pending_review' | 'to_contact' | 'mine' | null
  >(null);
  const [runPreset, setRunPreset] = useState<'active' | 'failed' | null>(null);
  const [workspaceLoadError, setWorkspaceLoadError] = useState(false);
  const [templates, setTemplates] = useState<CampaignTemplateSummary[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEventSummary[]>([]);
  const canManageMembers = user.role === 'admin';
  const canManageDevices = user.role !== 'readonly';
  const canWriteCampaigns = user.role !== 'readonly';

  useEffect(() => {
    const controller = new AbortController();
    setWorkspaceLoading(true);
    const membersRequest = canManageMembers
      ? fetch('/members', { credentials: 'include', signal: controller.signal })
          .then(readResponse<{ members: Member[] }>)
          .then((result: { members: Member[] }) => result.members)
      : Promise.resolve([] as Member[]);
    const devicesRequest = canManageDevices
      ? fetch('/devices', { credentials: 'include', signal: controller.signal })
          .then(readResponse<{ devices: Device[] }>)
          .then((result: { devices: Device[] }) => result.devices)
      : Promise.resolve([] as Device[]);
    const campaignsRequest = fetch('/campaigns', {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(readResponse<{ campaigns: CampaignSummary[] }>)
      .then((result: { campaigns: CampaignSummary[] }) => result.campaigns);
    const runsRequest = fetch('/runs', { credentials: 'include', signal: controller.signal })
      .then(readResponse<{ runs: RunSummary[] }>)
      .then((result: { runs: RunSummary[] }) => result.runs);
    const aiConnectionsRequest = canManageMembers
      ? fetch('/ai-connections', { credentials: 'include', signal: controller.signal })
          .then(readResponse<{ connections: AiConnectionSummary[] }>)
          .then((result: { connections: AiConnectionSummary[] }) => result.connections)
      : Promise.resolve([] as AiConnectionSummary[]);
    const dashboardRequest = fetch('/dashboard', {
      credentials: 'include',
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error('dashboard unavailable');
      return (await response.json()) as DashboardSummary;
    });
    const templatesRequest = canManageMembers
      ? fetch('/campaign-templates', { credentials: 'include', signal: controller.signal })
          .then(readResponse<{ templates: CampaignTemplateSummary[] }>)
          .then((result: { templates: CampaignTemplateSummary[] }) => result.templates)
      : Promise.resolve([] as CampaignTemplateSummary[]);
    const auditRequest = canManageMembers
      ? fetch('/audit-events', { credentials: 'include', signal: controller.signal })
          .then(readResponse<{ events: AuditEventSummary[] }>)
          .then((result: { events: AuditEventSummary[] }) => result.events)
      : Promise.resolve([] as AuditEventSummary[]);
    void Promise.all([
      membersRequest,
      devicesRequest,
      campaignsRequest,
      runsRequest,
      aiConnectionsRequest,
      dashboardRequest,
      templatesRequest,
      auditRequest,
    ])
      .then(
        ([
          nextMembers,
          nextDevices,
          nextCampaigns,
          nextRuns,
          nextAiConnections,
          nextDashboard,
          nextTemplates,
          nextAuditEvents,
        ]) => {
          setMembers(nextMembers);
          setDevices(nextDevices);
          setCampaigns(nextCampaigns);
          setRuns(nextRuns);
          setAiConnections(nextAiConnections);
          setDashboard(nextDashboard);
          setTemplates(nextTemplates);
          setAuditEvents(nextAuditEvents);
          setWorkspaceLoadError(false);
        },
      )
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setWorkspaceLoadError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setWorkspaceLoading(false);
      });
    return () => controller.abort();
  }, [canManageDevices, canManageMembers, refreshKey]);

  useEffect(() => {
    if (!['today', 'runs', 'devices'].includes(view)) return;
    const controller = new AbortController();
    let inFlight = false;
    const refresh = () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      const endpoint = {
        today: '/dashboard',
        runs: '/runs',
        devices: '/devices',
      }[view as 'today' | 'runs' | 'devices'];
      void fetch(endpoint, { credentials: 'include', signal: controller.signal })
        .then(
          readResponse<
            DashboardSummary & {
              runs: RunSummary[];
              devices: Device[];
            }
          >,
        )
        .then((result) => {
          if (view === 'runs') setRuns(result.runs);
          if (view === 'today') setDashboard(result);
          if (view === 'devices') setDevices(result.devices);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setWorkspaceLoadError(true);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 3_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [view]);

  async function logout() {
    try {
      const response = await fetch('/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-csrf-token': csrfToken },
      });
      if (!response.ok && response.status !== 401) throw new Error('logout failed');
      onLogout();
    } catch {
      setWorkspaceLoadError(true);
    }
  }

  return (
    <div className="app-shell">
      <aside className="side-rail">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">
            星
          </span>
          <div>
            <p className="brand-name">星探台</p>
            <p className="brand-caption">达人运营工作台</p>
          </div>
        </div>
        <nav aria-label="主导航" className="primary-nav">
          <span className="nav-section-label">工作流</span>
          <NavButton active={view === 'today'} label="今日工作" onClick={() => setView('today')} />
          <NavButton
            active={view === 'campaigns'}
            label="筛选任务"
            onClick={() => {
              setCreateRequested(false);
              setView('campaigns');
            }}
          />
          <NavButton
            active={view === 'runs'}
            label="运行监控"
            onClick={() => {
              setRunPreset(null);
              setView('runs');
            }}
          />
          <NavButton
            active={view === 'candidates'}
            label="达人库"
            onClick={() => {
              setCandidatePreset(null);
              setView('candidates');
            }}
          />
          {canManageMembers || canManageDevices ? (
            <span className="nav-section-label">管理与设置</span>
          ) : null}
          {canManageMembers ? (
            <NavButton
              active={view === 'members'}
              label="成员与邀请"
              onClick={() => setView('members')}
            />
          ) : null}
          {canManageMembers ? (
            <NavButton
              active={view === 'templates'}
              label="筛选模板"
              onClick={() => setView('templates')}
            />
          ) : null}
          {canManageMembers ? (
            <NavButton
              active={view === 'audit'}
              label="审计记录"
              onClick={() => setView('audit')}
            />
          ) : null}
          {canManageMembers ? (
            <NavButton active={view === 'ai'} label="AI 连接" onClick={() => setView('ai')} />
          ) : null}
          {canManageDevices ? (
            <NavButton
              active={view === 'devices'}
              label="采集设备"
              onClick={() => setView('devices')}
            />
          ) : null}
        </nav>
        <div className="rail-user">
          <span className="user-avatar">{user.displayName.slice(0, 1)}</span>
          <div>
            <strong>{user.displayName}</strong>
            <span>{roleLabel(user.role)}</span>
          </div>
          <button
            aria-label="退出登录"
            className="text-button"
            onClick={() => void logout()}
            type="button"
          >
            退出
          </button>
        </div>
        <div className="rail-note">
          <span className="status-dot" aria-hidden="true" />
          <p>采集浏览器只在运营电脑运行</p>
        </div>
      </aside>

      <main className="workspace">
        <div className="workspace-toolbar">
          <span className="workspace-breadcrumb">
            团队工作台 <span aria-hidden="true">/</span> 抖音
          </span>
          <button
            className="workspace-refresh"
            disabled={workspaceLoading}
            onClick={() => setRefreshKey((key) => key + 1)}
            type="button"
          >
            <span aria-hidden="true">↻</span>
            {workspaceLoading ? '正在刷新…' : '刷新数据'}
          </button>
        </div>
        {workspaceLoadError ? (
          <div className="network-banner" role="alert">
            网络连接失败或会话已过期，当前数据可能不是最新。请重试刷新；如仍失败，请重新登录。
          </div>
        ) : null}
        {view === 'today' ? (
          <TodayPage
            canWrite={canWriteCampaigns}
            dashboard={dashboard}
            onCreate={() => {
              setCreateRequested(true);
              setView('campaigns');
            }}
            onOpenDevices={() => setView('devices')}
            deviceCount={devices.filter((device) => device.status === 'active').length}
            campaignCount={campaigns.length}
            onOpenCandidates={(preset) => {
              setCandidatePreset(preset);
              setView('candidates');
            }}
            onOpenRuns={(preset) => {
              setRunPreset(preset);
              setView('runs');
            }}
          />
        ) : null}
        {view === 'campaigns' ? (
          <CampaignsPage
            campaigns={campaigns}
            canWrite={canWriteCampaigns}
            csrfToken={csrfToken}
            initialEditing={createRequested}
            onOpenRuns={() => {
              setRunPreset(null);
              setView('runs');
            }}
            onCreated={(campaign) => setCampaigns((current) => [campaign, ...current])}
          />
        ) : null}
        {view === 'runs' ? <RunsPage preset={runPreset} runs={runs} /> : null}
        {view === 'candidates' ? (
          <CandidatesPage
            canWrite={user.role !== 'readonly'}
            csrfToken={csrfToken}
            currentUserId={user.id}
            members={members}
            preset={candidatePreset}
            role={user.role}
          />
        ) : null}
        {view === 'members' && canManageMembers ? (
          <MembersPage csrfToken={csrfToken} members={members} />
        ) : null}
        {view === 'devices' && canManageDevices ? (
          <DevicesPage
            csrfToken={csrfToken}
            devices={devices}
            onChanged={() => setRefreshKey((key) => key + 1)}
          />
        ) : null}
        {view === 'ai' && canManageMembers ? (
          <AiConnectionsPage
            connections={aiConnections}
            csrfToken={csrfToken}
            onCreated={(connection) => setAiConnections((current) => [connection, ...current])}
            onUpdated={(connection) =>
              setAiConnections((current) =>
                current.map((item) => (item.id === connection.id ? connection : item)),
              )
            }
          />
        ) : null}
        {view === 'templates' && canManageMembers ? <TemplatesPage templates={templates} /> : null}
        {view === 'audit' && canManageMembers ? <AuditPage events={auditEvents} /> : null}
      </main>
    </div>
  );
}

function NavButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={`nav-item ${active ? 'nav-item-active' : ''}`}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function TodayPage({
  canWrite,
  dashboard,
  onCreate,
  onOpenCandidates,
  onOpenRuns,
  onOpenDevices,
  deviceCount,
  campaignCount,
}: {
  canWrite: boolean;
  dashboard: DashboardSummary;
  onCreate: () => void;
  onOpenCandidates: (preset: 'pending_review' | 'to_contact' | 'mine') => void;
  onOpenRuns: (preset: 'active' | 'failed') => void;
  onOpenDevices: () => void;
  deviceCount: number;
  campaignCount: number;
}) {
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">DOUYIN / TEAM DESK</p>
          <h1>
            把值得联系的人，
            <br />
            交给团队一起跟进。
          </h1>
          <p className="lede">
            从推荐流发现，到数据硬筛、AI 提示和人工确认；每一步都能回看，也不会替你做决定。
          </p>
        </div>
        {canWrite ? (
          <button className="primary-action" onClick={onCreate} type="button">
            创建筛选任务
          </button>
        ) : null}
      </header>
      {canWrite ? (
        <section className="workflow-guide" aria-label="采集操作流程">
          <div className="workflow-heading">
            <h2>从这里开始找博主</h2>
            <span>AI 可选 · 最终由人工确认</span>
          </div>
          <div className="workflow-steps">
            <button type="button" onClick={onOpenDevices}>
              <span className="step-number">01</span>
              <strong>配对采集设备</strong>
              <small>
                {deviceCount ? `${deviceCount} 台已授权 · 管理设备` : '连接你电脑上的采集助手'}
              </small>
            </button>
            <button type="button" onClick={onCreate}>
              <span className="step-number">02</span>
              <strong>配置筛选任务</strong>
              <small>
                {campaignCount
                  ? `${campaignCount} 个任务 · 创建新条件`
                  : '设置粉丝、爆款与停止条件'}
              </small>
            </button>
            <a href={COLLECTOR_URL} target="_blank" rel="noreferrer">
              <span className="step-number">03</span>
              <strong>本机人工开始</strong>
              <small>登录抖音，选择画像与运行 ↗</small>
            </a>
            <button type="button" onClick={() => onOpenCandidates('pending_review')}>
              <span className="step-number">04</span>
              <strong>复核与合作跟进</strong>
              <small>查看证据，确认并分配负责人</small>
            </button>
          </div>
        </section>
      ) : null}
      <section className="dashboard-grid" aria-label="运营待办概览">
        <DashboardCard
          label="运行中任务"
          value={dashboard.runningRuns}
          onClick={() => onOpenRuns('active')}
        />
        <DashboardCard
          label="待复核"
          value={dashboard.pendingReview}
          onClick={() => onOpenCandidates('pending_review')}
        />
        <DashboardCard
          label="待联系"
          value={dashboard.toContact}
          onClick={() => onOpenCandidates('to_contact')}
        />
        <DashboardCard
          label="我负责的"
          value={dashboard.myAssignments}
          onClick={() => onOpenCandidates('mine')}
        />
        <DashboardCard
          label="失败任务"
          value={dashboard.failedRuns}
          onClick={() => onOpenRuns('failed')}
        />
      </section>
      <section className="signal-board" aria-labelledby="pipeline-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">筛选链路</p>
            <h2 id="pipeline-title">三段证据轨道</h2>
          </div>
          <p>硬条件先判断，AI 只做辅助，最终由运营人员确认。</p>
        </div>
        <ol className="stage-list">
          {stages.map((stage, index) => (
            <li className={`stage stage-${stage.tone}`} key={stage.label}>
              <span className="stage-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="stage-line" aria-hidden="true" />
              <div>
                <h3>{stage.label}</h3>
                <p>{stage.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      {Object.values(dashboard).every((count) => count === 0) ? (
        <section className="empty-state" aria-labelledby="empty-title">
          <p className="empty-label">当前没有待处理事项</p>
          <h2 id="empty-title">先把这次要找的人说明白。</h2>
          <p>
            {canWrite
              ? '创建任务后，在运营电脑上选择已经养好的抖音画像并手动开始采集。'
              : '你可以查看团队已经建立的任务和候选，编辑操作由运营成员完成。'}
          </p>
        </section>
      ) : null}
    </>
  );
}

function DashboardCard({
  label,
  onClick,
  value,
}: {
  label: string;
  onClick: () => void;
  value: number;
}) {
  return (
    <button className="dashboard-card" onClick={onClick} type="button">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>查看对应记录 →</small>
    </button>
  );
}

function RunsPage({ runs, preset }: { runs: RunSummary[]; preset: 'active' | 'failed' | null }) {
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

const candidateDateOptions = [
  { label: '今天', value: 'today' },
  { label: '昨天', value: 'yesterday' },
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' },
  { label: '自定义', value: 'custom' },
  { label: '全部日期', value: 'all' },
] as const;

const reviewDecisionOptions = [
  { label: '人工通过', value: 'approved' },
  { label: '不符合', value: 'rejected' },
  { label: '待定', value: 'pending' },
] as const;

const pipelineStatusOptions = [
  { label: '待复核', value: 'pending_review' },
  { label: '不符合', value: 'unsuitable' },
  { label: '待联系', value: 'to_contact' },
  { label: '已联系', value: 'contacted' },
  { label: '沟通中', value: 'communicating' },
  { label: '已合作', value: 'partnered' },
  { label: '不合作', value: 'declined' },
] as const;

const memberRoleOptions = [
  { label: '运营', value: 'operator' },
  { label: '只读', value: 'readonly' },
  { label: '管理员', value: 'admin' },
] as const;

function FilterSelect({
  disabled = false,
  label,
  name,
  onChange,
  options,
  value,
}: {
  disabled?: boolean;
  label: string;
  name?: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ label: string; value: string }>;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const valueId = useId();
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selectedOption = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const animationFrame = window.requestAnimationFrame(() => {
      optionRefs.current[selectedIndex]?.focus();
    });
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [open, selectedIndex]);

  function moveOptionFocus(index: number, direction: 1 | -1) {
    const nextIndex = (index + direction + options.length) % options.length;
    optionRefs.current[nextIndex]?.focus();
  }

  function handleOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveOptionFocus(index, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      optionRefs.current[event.key === 'Home' ? 0 : options.length - 1]?.focus();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div className="candidate-filter-field filter-select" ref={rootRef}>
      <span className="candidate-filter-label" id={labelId}>
        {label}
      </span>
      <button
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-labelledby={`${labelId} ${valueId}`}
        className="filter-select-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          setOpen(true);
        }}
        ref={triggerRef}
        type="button"
      >
        <span id={valueId}>{selectedOption?.label ?? '请选择'}</span>
        <span aria-hidden="true" className="filter-select-chevron" />
      </button>
      {name ? <input disabled={disabled} name={name} type="hidden" value={value} /> : null}
      {open ? (
        <div className="filter-select-popover" id={listboxId} role="listbox">
          {options.map((option, index) => (
            <button
              aria-selected={option.value === value}
              className="filter-select-option"
              key={option.value || 'all'}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                triggerRef.current?.focus();
              }}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              role="option"
              type="button"
            >
              <span>{option.label}</span>
              <span aria-hidden="true" className="filter-select-check">
                {option.value === value ? '✓' : ''}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FormSelect({
  defaultValue,
  disabled = false,
  label,
  name,
  options,
}: {
  defaultValue: string;
  disabled?: boolean;
  label: string;
  name: string;
  options: ReadonlyArray<{ label: string; value: string }>;
}) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => setValue(defaultValue), [defaultValue]);

  return (
    <FilterSelect
      disabled={disabled}
      label={label}
      name={name}
      onChange={setValue}
      options={options}
      value={value}
    />
  );
}

function CandidatesPage({
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
  const [candidateSection, setCandidateSection] = useState<'qualified' | 'needs_evidence'>(
    'qualified',
  );
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
  const detailRequest = useRef(0);

  function buildCandidateQuery(cursor?: string) {
    const query = new URLSearchParams({
      hardFilterStatus: candidateSection === 'qualified' ? 'pass' : 'unknown',
      limit: '50',
    });
    if (preset === 'mine') query.set('ownerUserId', currentUserId);
    else if (preset) query.set('pipelineStatus', preset);
    if (role === 'admin' && memberUserId) query.set('memberUserId', memberUserId);
    const range = candidateDateRange(datePreset, customFrom, customTo);
    if (range.from) query.set('discoveredFrom', range.from);
    if (range.to) query.set('discoveredTo', range.to);
    if (cursor) query.set('cursor', cursor);
    return query;
  }

  useEffect(() => {
    if (datePreset === 'custom' && (!customFrom || !customTo)) return;
    const controller = new AbortController();
    setLibraryLoading(true);
    setLibraryError('');
    setSelectedCandidateId(null);
    setDetail(null);
    void fetch(`/candidates?${buildCandidateQuery()}`, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(readResponse<{ candidates: CandidateSummary[]; nextCursor: string | null }>)
      .then((result) => {
        setVisibleCandidates(
          result.candidates.filter((candidate) =>
            candidateMatchesLibraryView(candidate, candidateSection, preset, currentUserId),
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
  }, [candidateSection, customFrom, customTo, datePreset, memberUserId, preset]);

  async function loadMoreCandidates() {
    if (!nextCursor || libraryLoading) return;
    setLibraryLoading(true);
    setLibraryError('');
    try {
      const result = await fetch(`/candidates?${buildCandidateQuery(nextCursor)}`, {
        credentials: 'include',
      }).then(readResponse<{ candidates: CandidateSummary[]; nextCursor: string | null }>);
      setVisibleCandidates((current) => {
        const byId = new Map(current.map((candidate) => [candidate.id, candidate]));
        for (const candidate of result.candidates) {
          if (candidateMatchesLibraryView(candidate, candidateSection, preset, currentUserId)) {
            byId.set(candidate.id, candidate);
          }
        }
        return [...byId.values()];
      });
      setNextCursor(result.nextCursor ?? null);
    } catch {
      setLibraryError('下一页加载失败，请重试。');
    } finally {
      setLibraryLoading(false);
    }
  }

  const groupedCandidates = groupCandidatesByDate(visibleCandidates);

  function showCandidateSection(nextSection: 'qualified' | 'needs_evidence') {
    if (nextSection === candidateSection) return;
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

  return (
    <section>
      <header className="section-page-header">
        <div>
          <p className="eyebrow">CREATORS / EVIDENCE</p>
          <h1>达人库</h1>
          <p className="lede">运营仅查看自己采集或被分配的达人；管理员可查看全团队数据。</p>
        </div>
        <span className="library-count">
          {candidateSection === 'qualified'
            ? `${visibleCandidates.length} 位符合条件`
            : `${visibleCandidates.length} 位待补证据`}
        </span>
      </header>

      <div aria-label="达人库分区" className="candidate-library-switcher" role="group">
        <button
          aria-pressed={candidateSection === 'qualified'}
          onClick={() => showCandidateSection('qualified')}
          type="button"
        >
          符合条件
        </button>
        <button
          aria-pressed={candidateSection === 'needs_evidence'}
          onClick={() => showCandidateSection('needs_evidence')}
          type="button"
        >
          待补证据
        </button>
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

      {visibleCandidates.length ? (
        <div className="candidate-workspace">
          <div
            className="candidate-list"
            aria-label={candidateSection === 'qualified' ? '符合条件达人列表' : '待补证据达人列表'}
          >
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
                    <b className={`evidence-outcome evidence-${candidate.hardFilterStatus}`}>
                      {hardFilterLabel(candidate.hardFilterStatus)}
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
            {loading ? <EmptyPanel text="正在调取历史证据…" /> : null}
            {!loading && !detail ? (
              <EmptyPanel text="选择一位达人，查看历次观察、任务来源和当时使用的规则证据。" />
            ) : null}
            {!loading && detail ? (
              <CandidateDetailView
                key={detail.candidate.id}
                canWrite={canWrite}
                csrfToken={csrfToken}
                detail={detail}
                onQueued={() => void openCandidate(detail.candidate.id)}
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
          <EmptyPanel
            text={
              candidateSection === 'qualified'
                ? '还没有硬筛通过的达人。采集同步并满足全部硬筛条件后会进入这里。'
                : '暂时没有待补证据的达人。硬筛数据无法确认时会进入这里。'
            }
          />
        </div>
      )}
    </section>
  );
}

function CandidateDetailView({
  detail,
  canWrite,
  csrfToken,
  onQueued,
}: {
  detail: CandidateDetailData;
  canWrite: boolean;
  csrfToken: string;
  onQueued: () => void;
}) {
  const latest = detail.observations[0];
  const [queueingAi, setQueueingAi] = useState(false);
  const [workflowMessage, setWorkflowMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [previewImage, setPreviewImage] = useState<{ alt: string; src: string } | null>(null);
  const [assignees, setAssignees] = useState<Array<{ id: string; displayName: string }>>([]);
  const [assigneesLoaded, setAssigneesLoaded] = useState(false);
  const [ownerUserId, setOwnerUserId] = useState(detail.workflow?.outreach?.ownerUserId ?? '');
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

  async function queueAnalysis() {
    if (queueingAi) return;
    setQueueingAi(true);
    try {
      const response = await fetch(`/candidates/${detail.candidate.id}/ai-analyses`, {
        credentials: 'include',
        headers: { 'x-csrf-token': csrfToken },
        method: 'POST',
      });
      if (!response.ok) throw new Error('ai unavailable');
      onQueued();
    } catch {
      setWorkflowMessage('AI 分析未能提交，请检查 AI 配置或稍后重试。人工复核仍可继续。');
    } finally {
      setQueueingAi(false);
    }
  }

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
      if (response.status === 409) {
        setWorkflowMessage('这条记录已被同事更新，请重新打开达人后再提交。');
        return false;
      }
      if (!response.ok) {
        setWorkflowMessage('保存失败，请检查必填内容和当前阶段。');
        return false;
      }
      onQueued();
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
      const response = await fetch(`/media/${mediaId}/access`, { credentials: 'include' });
      if (!response.ok) throw new Error('media unavailable');
      const result = (await response.json()) as { downloadUrl?: unknown };
      const downloadUrl = result.downloadUrl;
      if (typeof downloadUrl !== 'string' || !downloadUrl.trim()) {
        throw new Error('media URL unavailable');
      }
      setMediaUrls((current) => ({ ...current, [mediaId]: downloadUrl }));
    } catch {
      setWorkflowMessage('截图加载失败，请稍后重试或检查 OSS 配置。');
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
                  ) : (
                    <button onClick={() => void loadPrivateImage(media.id)} type="button">
                      查看{media.purpose === 'profile_screenshot' ? '主页' : '作品'}截图
                    </button>
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

      <section className="candidate-detail-section" aria-labelledby="ai-analysis-title">
        <div className="detail-section-heading">
          <div>
            <h3 id="ai-analysis-title">AI 辅助建议</h3>
            <small>只作辅助，失败也不影响人工复核</small>
          </div>
          {canWrite ? (
            <button disabled={queueingAi} onClick={() => void queueAnalysis()} type="button">
              {queueingAi ? '正在加入队列…' : '重新分析'}
            </button>
          ) : null}
        </div>
        <div className="ai-analysis-list">
          {(detail.aiAnalyses ?? []).length ? (
            (detail.aiAnalyses ?? []).map((analysis) => (
              <article
                className={`ai-analysis-card ai-analysis-${analysis.status}`}
                key={analysis.id}
              >
                <header>
                  <strong>{aiAnalysisStatusLabel(analysis.status)}</strong>
                  <span>
                    {analysis.providerLabel ?? 'AI 服务'} · {analysis.model ?? '等待分配模型'}
                  </span>
                </header>
                {analysis.result ? (
                  <>
                    <p>{analysis.result.summary ?? '模型未提供摘要'}</p>
                    <dl>
                      <div>
                        <dt>疑似年龄</dt>
                        <dd>{formatAiAge(analysis.result.estimatedAge)}</dd>
                      </div>
                      <div>
                        <dt>素人属性</dt>
                        <dd>{analysis.result.amateurStatus?.value ?? '未知'}</dd>
                      </div>
                      <div>
                        <dt>推广适配</dt>
                        <dd>{analysis.result.suitability?.value ?? '待人工判断'}</dd>
                      </div>
                    </dl>
                    {(analysis.result.riskFlags ?? []).map((risk) => (
                      <p className="ai-risk" key={`${analysis.id}-${risk.code}`}>
                        {risk.severity} · {risk.explanation}
                      </p>
                    ))}
                  </>
                ) : analysis.error ? (
                  <p role="alert">
                    分析失败：{analysis.error.message ?? analysis.error.code ?? '请稍后重试'}
                  </p>
                ) : (
                  <p>任务已进入后台队列，页面可以继续人工复核。</p>
                )}
                <small>
                  {analysis.promptVersion} · {formatRunTime(analysis.createdAt)}
                </small>
              </article>
            ))
          ) : (
            <p className="muted-copy">尚无 AI 分析，不影响继续人工判断。</p>
          )}
        </div>
      </section>

      <section className="candidate-detail-section" aria-labelledby="manual-review-title">
        <div className="detail-section-heading">
          <div>
            <h3 id="manual-review-title">人工复核与合作跟进</h3>
            <small>人工结论是最终业务判断，AI 原结论会继续保留</small>
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
              <label>
                理由
                <textarea name="reason" placeholder="不符合时必填，也可记录待定原因" />
              </label>
              <button disabled={saving} type="submit">
                保存人工结论
              </button>
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
              <label>
                说明
                <input name="note" placeholder="本次状态变更说明" />
              </label>
              <button disabled={saving} type="submit">
                更新阶段
              </button>
            </form>
            <form
              className="workflow-form workflow-form-wide contact-fields"
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
                  !assignees.some((member) => member.id === detail.workflow!.outreach!.ownerUserId)
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
              className="workflow-form workflow-form-wide"
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
        ) : null}
        {saving || workflowMessage ? (
          <p role="status">{saving ? '正在保存，请稍候…' : workflowMessage}</p>
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

const EVIDENCE_ZOOM_MIN = 1;
const EVIDENCE_ZOOM_MAX = 4;
const EVIDENCE_ZOOM_STEP = 0.25;

function PrivateImageLightbox({
  image,
  onClose,
}: {
  image: { alt: string; src: string };
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(EVIDENCE_ZOOM_MIN);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  function updateZoom(nextZoom: number) {
    setZoom(Math.min(EVIDENCE_ZOOM_MAX, Math.max(EVIDENCE_ZOOM_MIN, nextZoom)));
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    updateZoom(zoom + (event.deltaY < 0 ? EVIDENCE_ZOOM_STEP : -EVIDENCE_ZOOM_STEP));
  }

  return (
    <div
      aria-labelledby="private-image-preview-title"
      aria-modal="true"
      className="private-image-lightbox"
      onClick={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
      role="dialog"
    >
      <div className="private-image-lightbox-panel">
        <header>
          <div>
            <p className="eyebrow">私有证据截图</p>
            <h2 id="private-image-preview-title">{image.alt}预览</h2>
          </div>
          <div aria-label="图片缩放控制" className="private-image-lightbox-controls" role="group">
            <button
              aria-label="缩小截图"
              disabled={zoom <= EVIDENCE_ZOOM_MIN}
              onClick={() => updateZoom(zoom - EVIDENCE_ZOOM_STEP)}
              type="button"
            >
              −
            </button>
            <output aria-live="polite">{Math.round(zoom * 100)}%</output>
            <button
              aria-label="放大截图"
              disabled={zoom >= EVIDENCE_ZOOM_MAX}
              onClick={() => updateZoom(zoom + EVIDENCE_ZOOM_STEP)}
              type="button"
            >
              +
            </button>
            <button
              disabled={zoom === EVIDENCE_ZOOM_MIN}
              onClick={() => updateZoom(1)}
              type="button"
            >
              还原
            </button>
            <button onClick={onClose} ref={closeButtonRef} type="button">
              关闭
            </button>
          </div>
        </header>
        <div
          aria-label="截图预览区域，滚轮可缩放"
          className="private-image-lightbox-stage"
          onWheel={handleWheel}
        >
          <img alt={image.alt} src={image.src} style={{ transform: `scale(${zoom})` }} />
        </div>
      </div>
    </div>
  );
}

function manualDecisionLabel(decision: 'pending' | 'approved' | 'rejected') {
  return { approved: '通过', pending: '待定', rejected: '不符合' }[decision];
}

function pipelineStatusLabel(status: string) {
  return (
    {
      pending_review: '待复核',
      unsuitable: '不符合',
      to_contact: '待联系',
      contacted: '已联系',
      communicating: '沟通中',
      partnered: '已合作',
      declined: '不合作',
    }[status] ?? status
  );
}

function aiAnalysisStatusLabel(
  status: NonNullable<CandidateDetailData['aiAnalyses']>[number]['status'],
) {
  return {
    failed: '分析失败',
    queued: '等待分析',
    running: '分析中',
    succeeded: '分析完成',
    unavailable: '服务不可用',
  }[status];
}

function formatAiAge(
  age: NonNullable<
    NonNullable<CandidateDetailData['aiAnalyses']>[number]['result']
  >['estimatedAge'],
) {
  if (!age || age.status === 'unknown') return '证据不足';
  return `${age.minimum}–${age.maximum} 岁 · ${Math.round(age.confidence * 100)}%`;
}

function formatFollowerCount(value: number | null) {
  return value === null ? '未知' : new Intl.NumberFormat('zh-CN').format(value);
}

function hardFilterLabel(outcome: 'pass' | 'fail' | 'unknown') {
  return { pass: '通过', fail: '不通过', unknown: '未知' }[outcome];
}

function candidateDateRange(
  preset: 'today' | 'yesterday' | '7d' | '30d' | 'custom' | 'all',
  customFrom: string,
  customTo: string,
) {
  if (preset === 'all') return {};
  if (preset === 'custom') {
    if (!customFrom || !customTo) return {};
    return {
      from: `${customFrom}T00:00:00+08:00`,
      to: `${shiftDateKey(customTo, 1)}T00:00:00+08:00`,
    };
  }
  const today = businessDateKey(new Date());
  const from =
    preset === 'today'
      ? today
      : preset === 'yesterday'
        ? shiftDateKey(today, -1)
        : shiftDateKey(today, preset === '7d' ? -6 : -29);
  const to = preset === 'yesterday' ? today : shiftDateKey(today, 1);
  return { from: `${from}T00:00:00+08:00`, to: `${to}T00:00:00+08:00` };
}

function candidateMatchesLibraryView(
  candidate: CandidateSummary,
  section: 'qualified' | 'needs_evidence',
  preset: 'pending_review' | 'to_contact' | 'mine' | null,
  currentUserId: string,
) {
  if (candidate.hardFilterStatus !== (section === 'qualified' ? 'pass' : 'unknown')) return false;
  if (preset === 'mine') return candidate.ownerUserId === currentUserId;
  return preset ? candidate.pipelineStatus === preset : true;
}

function groupCandidatesByDate(candidates: CandidateSummary[]) {
  const today = businessDateKey(new Date());
  const yesterday = shiftDateKey(today, -1);
  const groups = new Map<string, CandidateSummary[]>();
  for (const candidate of candidates) {
    const key = businessDateKey(new Date(candidate.firstVisibleAt || candidate.observedAt));
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => ({
    candidates: group,
    key,
    label: key === today ? '今天' : key === yesterday ? '昨天' : key,
  }));
}

function businessDateKey(date: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  }).format(date);
}

function shiftDateKey(key: string, days: number) {
  const date = new Date(`${key}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function ruleLabel(ruleKey: string) {
  return { followers: '粉丝范围', 'recent-viral-post': '近期爆款作品' }[ruleKey] ?? ruleKey;
}

function formatEvidenceThreshold(evidence: Record<string, unknown>) {
  if (typeof evidence.minimumLikes === 'number') return `门槛 ${evidence.minimumLikes} 赞`;
  if (typeof evidence.minimum === 'number' && typeof evidence.maximum === 'number') {
    return `范围 ${evidence.minimum}–${evidence.maximum}`;
  }
  return '保留当时观察值与阈值';
}

function RunMetric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
}) {
  return (
    <div className={accent ? 'run-metric run-metric-accent' : 'run-metric'}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function runStatusLabel(status: RunSummary['status']) {
  return {
    ready: '待领取',
    claimed: '已领取',
    running: '采集中',
    paused: '已暂停',
    completed: '已完成',
    failed: '异常',
    terminated: '已终止',
  }[status];
}

function runStopReasonLabel(reason: string) {
  return (
    {
      target_candidates: '目标候选数已达到',
      max_feed_items: '最多浏览作品数已达到',
      max_creator_profiles: '最多核验主页数已达到',
      max_duration_minutes: '最长运行时间已达到',
      manual_termination: '运营人员手动终止',
    }[reason] ?? reason
  );
}

function formatRunTime(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function CampaignsPage({
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
    ai: string;
  } | null>(null);
  const [error, setError] = useState('');

  async function saveCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError('');
    const form = new FormData(event.currentTarget);
    const number = (name: string) => Number(form.get(name));
    if (
      number('followerMax') < number('followerMin') ||
      number('maximumAge') < number('minimumAge')
    ) {
      setError('上限不能小于下限，请检查粉丝数和年龄范围。');
      return;
    }
    const name = String(form.get('name'));
    const contentPrompt = String(form.get('contentPrompt') ?? '').trim();
    const manualLabel = String(form.get('manualLabel') ?? '').trim();
    const rules = {
      schemaVersion: 1,
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
      aiRules: [
        {
          id: 'estimated-age',
          kind: 'ai',
          type: 'estimated-age-band',
          minAge: number('minimumAge'),
          maxAge: number('maximumAge'),
        },
        { id: 'amateur-status', kind: 'ai', type: 'amateur-status' },
        ...(contentPrompt
          ? [{ id: 'content-fit', kind: 'ai', type: 'content-fit', prompt: contentPrompt }]
          : []),
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
      aiLimits: { maximumCandidates: number('aiMaximumCandidates'), concurrency: 1 },
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
        ai: `${number('minimumAge')}–${number('maximumAge')} 岁，最多 ${number('aiMaximumCandidates')} 人`,
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

          <div className="editor-heading amber-heading">
            <div>
              <span>AI 辅助</span>
              <strong>只给提示，不自动淘汰</strong>
            </div>
          </div>
          <div className="editor-grid">
            <label>
              疑似年龄下限
              <input defaultValue="18" min="13" name="minimumAge" required type="number" />
            </label>
            <label>
              疑似年龄上限
              <input defaultValue="24" min="13" name="maximumAge" required type="number" />
            </label>
            <label>
              AI 最多分析人数
              <input defaultValue="30" min="0" name="aiMaximumCandidates" required type="number" />
            </label>
            <label className="wide-field">
              内容偏好（可选）
              <input name="contentPrompt" placeholder="留空代表内容类型不限" />
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
            粉丝 {lastSaved.followers} · 爆款 {lastSaved.viral} · AI {lastSaved.ai}
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

function AiConnectionsPage({
  connections,
  csrfToken,
  onCreated,
  onUpdated,
}: {
  connections: AiConnectionSummary[];
  csrfToken: string;
  onCreated: (connection: AiConnectionSummary) => void;
  onUpdated: (connection: AiConnectionSummary) => void;
}) {
  const [message, setMessage] = useState('');
  const [saveFailed, setSaveFailed] = useState(false);
  const [testMessages, setTestMessages] = useState<
    Record<string, { text: string; failed: boolean }>
  >({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [savingConnection, setSavingConnection] = useState(false);

  async function createConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingConnection) return;
    setMessage('');
    setSaveFailed(false);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSavingConnection(true);
    try {
      const response = await fetch('/ai-connections', {
        body: JSON.stringify({
          apiKey: form.get('apiKey'),
          baseUrl: form.get('baseUrl'),
          label: form.get('label'),
          model: form.get('model'),
          supportsImages: form.get('supportsImages') === 'on',
          supportsJsonSchema: form.get('supportsJsonSchema') === 'on',
        }),
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        method: 'POST',
      });
      if (!response.ok) {
        setSaveFailed(true);
        setMessage('连接保存失败，请检查地址、模型和密钥。');
        return;
      }
      onCreated((await response.json()) as AiConnectionSummary);
      formElement.reset();
      setMessage('连接已加密保存。密钥不会再次显示。');
    } catch {
      setSaveFailed(true);
      setMessage('网络连接失败，连接尚未确认保存，请稍后重试。');
    } finally {
      setSavingConnection(false);
    }
  }

  async function testConnection(connection: AiConnectionSummary) {
    if (testingId) return;
    setTestingId(connection.id);
    setTestMessages((current) => ({
      ...current,
      [connection.id]: { text: '正在测试，请稍候…', failed: false },
    }));
    try {
      const response = await fetch(`/ai-connections/${connection.id}/test`, {
        credentials: 'include',
        headers: { 'x-csrf-token': csrfToken },
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error('Connection test request failed');
      }
      const result = (await response.json()) as NonNullable<AiConnectionSummary['lastTestResult']>;
      onUpdated({
        ...connection,
        lastTestResult: result,
        status: result.overall === 'passed' ? 'enabled' : 'failed',
      });
      setTestMessages((current) => ({
        ...current,
        [connection.id]: {
          text:
            result.overall === 'passed'
              ? '测试通过，连接已启用。'
              : '部分能力未通过，连接尚未启用。请核对服务地址、模型和勾选的能力后重试。',
          failed: result.overall !== 'passed',
        },
      }));
    } catch {
      setTestMessages((current) => ({
        ...current,
        [connection.id]: {
          text: '连接测试请求失败，请检查网络后重试。',
          failed: true,
        },
      }));
    } finally {
      setTestingId(null);
    }
  }

  return (
    <section>
      <header className="section-page-header">
        <div>
          <p className="eyebrow">AI / CONNECTIONS</p>
          <h1>AI 连接</h1>
          <p className="lede">支持 OpenAI-compatible 网关和公司包层地址；密钥只会加密保存。</p>
        </div>
      </header>
      <div className="ai-settings-layout">
        <form
          className="data-panel stack-form ai-connection-form"
          aria-busy={savingConnection}
          onSubmit={createConnection}
        >
          <h2>添加连接</h2>
          <p className="connection-help">
            填写服务商提供的连接信息，保存后再测试能力。保存不代表已启用。
          </p>
          <fieldset className="connection-fields" disabled={savingConnection}>
            <label>
              连接名称
              <input name="label" placeholder="例如：公司模型网关" required />
            </label>
            <label>
              Base URL
              <input
                name="baseUrl"
                placeholder="https://gateway.example/v1"
                required
                type="url"
                aria-describedby="ai-base-url-hint"
              />
              <small id="ai-base-url-hint" className="connection-help">
                填写 API 根地址，不是聊天网页地址。
              </small>
            </label>
            <label>
              模型名称
              <input name="model" placeholder="填写服务商提供的模型 ID" required />
            </label>
            <label>
              API Key
              <input autoComplete="new-password" name="apiKey" required type="password" />
            </label>
            <fieldset className="connection-capabilities">
              <legend>模型能力</legend>
              <p className="connection-help">按服务商文档勾选，保存后可测试验证。</p>
              <label className="checkbox-line">
                <input name="supportsImages" type="checkbox" /> 支持图片输入
              </label>
              <label className="checkbox-line">
                <input name="supportsJsonSchema" type="checkbox" /> 支持结构化 JSON
              </label>
            </fieldset>
            <button
              className="primary-action wide-action"
              disabled={savingConnection}
              type="submit"
            >
              {savingConnection ? '正在加密保存…' : '加密保存连接'}
            </button>
          </fieldset>
          {message ? (
            <p
              className={saveFailed ? 'connection-feedback form-error' : 'connection-feedback'}
              role={saveFailed ? 'alert' : 'status'}
            >
              {message}
            </p>
          ) : null}
        </form>
        <div className="connection-list">
          {connections.length ? (
            connections.map((connection) => (
              <article className="data-panel connection-card" key={connection.id}>
                <header>
                  <div>
                    <h2>{connection.label}</h2>
                    <p>{connection.model}</p>
                  </div>
                  <span className={`row-status status-${connection.status}`}>
                    {
                      {
                        disabled: '未启用',
                        testing: '测试中',
                        enabled: '已启用',
                        failed: '需处理',
                      }[connection.status]
                    }
                  </span>
                </header>
                <code>{connection.baseUrl}</code>
                <p>凭据：已配置（不可读取）</p>
                {connection.status === 'disabled' ? (
                  <p className="connection-help">下一步：测试连接能力。测试通过后才会启用。</p>
                ) : null}
                {connection.lastTestResult ? (
                  <dl className="capability-grid">
                    <div>
                      <dt>文字</dt>
                      <dd>{connectionCapabilityLabel(connection.lastTestResult.text?.status)}</dd>
                    </div>
                    <div>
                      <dt>图片</dt>
                      <dd>{connectionCapabilityLabel(connection.lastTestResult.images?.status)}</dd>
                    </div>
                    <div>
                      <dt>JSON</dt>
                      <dd>
                        {connectionCapabilityLabel(connection.lastTestResult.jsonSchema?.status)}
                      </dd>
                    </div>
                  </dl>
                ) : null}
                <button
                  disabled={Boolean(testingId)}
                  onClick={() => void testConnection(connection)}
                  type="button"
                >
                  {testingId === connection.id ? '正在分别测试能力…' : '测试连接能力'}
                </button>
                {testMessages[connection.id] ? (
                  <p
                    className={
                      testMessages[connection.id]!.failed
                        ? 'connection-feedback form-error'
                        : 'connection-feedback'
                    }
                    role={testMessages[connection.id]!.failed ? 'alert' : 'status'}
                  >
                    {testMessages[connection.id]!.text}
                  </p>
                ) : null}
              </article>
            ))
          ) : (
            <div className="data-panel">
              <EmptyPanel text="尚未配置 AI 连接，人工复核仍可正常使用。" />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function connectionCapabilityLabel(status?: string): string {
  if (status === 'passed') return '通过';
  if (status === 'failed') return '失败';
  if (status === 'unsupported' || status === 'skipped') return '未测试 / 不支持';
  return '未测试';
}

function TemplatesPage({ templates }: { templates: CampaignTemplateSummary[] }) {
  return (
    <section>
      <header className="section-page-header">
        <div>
          <p className="eyebrow">SETTINGS / TEMPLATES</p>
          <h1>筛选模板</h1>
          <p className="lede">管理员维护团队共用的规则起点，运行时仍会冻结独立快照。</p>
        </div>
      </header>
      <div className="data-panel">
        {templates.length ? (
          templates.map((template) => (
            <article className="member-row" key={template.id}>
              <span className="candidate-avatar">模</span>
              <div>
                <strong>{template.name}</strong>
                <p>{template.description ?? '暂无说明'}</p>
              </div>
              <span className="role-chip">v{template.version}</span>
            </article>
          ))
        ) : (
          <EmptyPanel text="还没有团队筛选模板。" />
        )}
      </div>
    </section>
  );
}

function AuditPage({ events }: { events: AuditEventSummary[] }) {
  return (
    <section>
      <header className="section-page-header">
        <div>
          <p className="eyebrow">SETTINGS / AUDIT</p>
          <h1>审计记录</h1>
          <p className="lede">关键设置、设备、复核、联系状态与导出操作都会留痕。</p>
        </div>
      </header>
      <div className="data-panel">
        {events.length ? (
          events.map((event) => (
            <article className="member-row" key={event.id}>
              <span className="candidate-avatar">审</span>
              <div>
                <strong>{event.action}</strong>
                <p>{event.subjectType}</p>
              </div>
              <time>{formatRunTime(event.createdAt)}</time>
            </article>
          ))
        ) : (
          <EmptyPanel text="暂无审计记录。" />
        )}
      </div>
    </section>
  );
}

function MembersPage({ members, csrfToken }: { members: Member[]; csrfToken: string }) {
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

function DevicesPage({
  devices,
  csrfToken,
  onChanged,
}: {
  devices: Device[];
  csrfToken: string;
  onChanged: () => void;
}) {
  const [pairingCode, setPairingCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmDevice, setConfirmDevice] = useState<string | null>(null);

  async function createPairingCode() {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/devices/pairing-codes', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ expiresInMinutes: 10 }),
      });
      const result = await readResponse<{ code: string }>(response);
      setPairingCode(result.code);
    } catch {
      setMessage('配对码生成失败，请检查登录状态和网络后重试。');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(deviceId: string) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/devices/${encodeURIComponent(deviceId)}/revoke`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-csrf-token': csrfToken },
      });
      if (!response.ok) throw new Error('revoke failed');
      setConfirmDevice(null);
      setMessage('授权已撤销，该设备不能继续同步。');
      onChanged();
    } catch {
      setMessage('撤销失败。请确认你有权管理该设备，并检查网络。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <header className="section-page-header">
        <div>
          <p className="eyebrow">LOCAL / COLLECTOR</p>
          <h1>采集设备</h1>
          <p className="lede">每台运营电脑使用独立令牌，抖音 Cookie 和养号画像始终留在本机。</p>
        </div>
        <button
          className="primary-action"
          disabled={busy}
          onClick={() => void createPairingCode()}
          type="button"
        >
          {busy ? '正在处理…' : '生成配对码'}
        </button>
      </header>
      <div className="workflow-callout">
        <div>
          <strong>首次连接，只需配对一次。</strong>
          <p>
            生成配对码 → 打开本机助手 →
            填写设备名称和配对码。配对成功后，设备列表会自动更新。助手打不开时，请先运行 npm run
            dev:local。
          </p>
        </div>
        <a className="secondary-action" href={COLLECTOR_URL} target="_blank" rel="noreferrer">
          打开本机助手 ↗
        </a>
      </div>
      {message ? (
        <p className="notice-banner" role="status">
          {message}
        </p>
      ) : null}
      {pairingCode ? (
        <div className="pairing-strip">
          <span>10 分钟内在采集助手输入</span>
          <strong>{pairingCode}</strong>
          <small>使用后立即失效</small>
          <button
            className="secondary-action"
            type="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(pairingCode)
                .then(() => setMessage('配对码已复制。'))
                .catch(() => setMessage('浏览器不允许自动复制，请手动选择配对码复制。'))
            }
          >
            复制配对码
          </button>
        </div>
      ) : null}
      <div className="data-panel">
        <div className="table-heading">
          <span>已授权设备</span>
          <span>{devices.length} 台</span>
        </div>
        {devices.length ? (
          devices.map((device) => (
            <article className="device-row" key={device.id}>
              <span className={`device-light ${device.status}`} aria-hidden="true" />
              <div>
                <strong>{device.name}</strong>
                <span>
                  {device.ownerDisplayName} · Collector {device.collectorVersion ?? '未知'}
                </span>
              </div>
              <span>
                {device.status === 'revoked'
                  ? '已撤销'
                  : device.lastSeenAt
                    ? `最近连接 ${formatRunTime(device.lastSeenAt)}`
                    : '尚未上线'}
              </span>
              {device.status === 'active' ? (
                <div className="device-actions">
                  {confirmDevice === device.id ? (
                    <>
                      <span>确认撤销这台设备？</span>
                      <button
                        className="text-button dark-text-button"
                        disabled={busy}
                        onClick={() => void revoke(device.id)}
                        type="button"
                      >
                        确认撤销
                      </button>
                      <button
                        className="text-button dark-text-button"
                        onClick={() => setConfirmDevice(null)}
                        type="button"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      className="text-button dark-text-button"
                      onClick={() => setConfirmDevice(device.id)}
                      type="button"
                    >
                      撤销授权
                    </button>
                  )}
                </div>
              ) : null}
            </article>
          ))
        ) : (
          <EmptyPanel text="还没有配对设备。生成配对码后，在同事电脑的采集助手中输入。" />
        )}
      </div>
    </section>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <div className="panel-empty">
      <span aria-hidden="true" className="empty-radar" />
      <p>{text}</p>
    </div>
  );
}

function roleLabel(role: Role) {
  return { admin: '管理员', operator: '运营', readonly: '只读' }[role];
}
