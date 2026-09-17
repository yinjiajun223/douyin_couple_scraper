const countPattern = /(?<value>\d+(?:\.\d+)?)\s*(?<unit>亿|万|[kwm])?/iu;

const multipliers: Readonly<Record<string, number>> = {
  '': 1,
  k: 1_000,
  w: 10_000,
  万: 10_000,
  m: 1_000_000,
  亿: 100_000_000,
};

export function parseDouyinCompactCount(rawValue: string | null | undefined): number | null {
  if (!rawValue) return null;
  const normalized = rawValue.trim().replaceAll(',', '');
  const match = countPattern.exec(normalized);
  if (!match?.groups) return null;
  const value = Number(match.groups.value);
  const unit = (match.groups.unit ?? '').toLowerCase();
  const multiplier = multipliers[unit];
  if (!Number.isFinite(value) || multiplier === undefined) return null;
  const parsed = Math.round(value * multiplier);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export interface ExtractedDouyinCount {
  raw: string;
  value: number | null;
}

export function extractDouyinFollowerCount(text: string | null | undefined): ExtractedDouyinCount {
  if (!text) return { raw: '', value: null };
  const normalized = text.replaceAll('\u00a0', ' ');
  const patterns = [
    /粉丝\s*[:：]?\s*([0-9][0-9,.]*(?:\.[0-9]+)?\s*(?:万|亿|[wWkKmM])?)/u,
    /([0-9][0-9,.]*(?:\.[0-9]+)?\s*(?:万|亿|[wWkKmM])?)\s*粉丝/u,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match?.[1]) continue;
    const raw = match[1].replaceAll(' ', '');
    return { raw, value: parseDouyinCompactCount(raw) };
  }
  return { raw: '', value: null };
}
