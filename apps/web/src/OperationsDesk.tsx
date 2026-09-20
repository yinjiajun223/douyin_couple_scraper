import { useEffect, useState } from 'react';

import type {
  AuditEventSummary,
  CampaignSummary,
  CampaignTemplateSummary,
  CurrentUser,
  DashboardSummary,
  Device,
  Member,
  RunSummary,
  View,
} from './types';
import { readResponse } from './api/client';
import { roleLabel } from './lib/format';
import { NavButton } from './components/NavButton';
import { TodayPage } from './pages/TodayPage';
import { RunsPage } from './pages/RunsPage';
import { CandidatesPage } from './pages/CandidatesPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { AuditPage } from './pages/AuditPage';
import { MembersPage } from './pages/MembersPage';
import { DevicesPage } from './pages/DevicesPage';

export function OperationsDesk({
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
          nextDashboard,
          nextTemplates,
          nextAuditEvents,
        ]) => {
          setMembers(nextMembers);
          setDevices(nextDevices);
          setCampaigns(nextCampaigns);
          setRuns(nextRuns);
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
        {view === 'templates' && canManageMembers ? <TemplatesPage templates={templates} /> : null}
        {view === 'audit' && canManageMembers ? <AuditPage events={auditEvents} /> : null}
      </main>
    </div>
  );
}
