import type { CandidateSummary } from '../types';

export function candidateDateRange(
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

export function candidateMatchesLibraryView(
  candidate: CandidateSummary,
  section: 'qualified' | 'needs_evidence',
  preset: 'pending_review' | 'to_contact' | 'mine' | null,
  currentUserId: string,
) {
  if (candidate.hardFilterStatus !== (section === 'qualified' ? 'pass' : 'unknown')) return false;
  if (preset === 'mine') return candidate.ownerUserId === currentUserId;
  return preset ? candidate.pipelineStatus === preset : true;
}

export function groupCandidatesByDate(candidates: CandidateSummary[]) {
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

export function businessDateKey(date: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  }).format(date);
}

export function shiftDateKey(key: string, days: number) {
  const date = new Date(`${key}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
