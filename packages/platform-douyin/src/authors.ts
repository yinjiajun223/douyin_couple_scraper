import { load } from 'cheerio';

import { extractDouyinFollowerCount, parseDouyinCompactCount } from './counts.js';
import {
  InvalidDouyinUrlError,
  normalizeDouyinPostUrl,
  normalizeDouyinProfileUrl,
} from './urls.js';

export interface DouyinAuthorProfile {
  biography: string | null;
  followerCount: number | null;
  followerCountRaw: string;
  nickname: string | null;
  parserConfidence: number;
  platformCreatorId: string | null;
  profileUrl: string | null;
}

export interface DouyinAuthorCard {
  cardText: string;
  followerCount: number | null;
  followerCountRaw: string;
  nickname: string | null;
  platformCreatorId: string;
  profileUrl: string;
}

export interface DouyinProfilePostEvidence {
  caption: string | null;
  likeCount: number | null;
  likeCountRaw: string;
  platformPostId: string;
  postUrl: string;
  publishedAt: string | null;
}

const nicknameSelectors = [
  '[data-e2e="user-title"]',
  '[data-e2e="user-name"]',
  '[data-testid="user-name"]',
  'h1',
] as const;

const biographySelectors = [
  '[data-e2e="user-desc"]',
  '[data-testid="user-description"]',
  '.user-desc',
] as const;

export function extractDouyinAuthorProfileFromHtml(
  html: string,
  sourceUrl?: string,
): DouyinAuthorProfile {
  const $ = load(html);
  const bodyText = $('body').text().replace(/\s+/gu, ' ').trim();
  const documentTitle = $('title').first().text().trim();
  const profileUrl = findProfileUrl($, sourceUrl);
  const profileFollower = extractDouyinFollowerCount(
    $('[data-e2e="user-info-fans"]').first().text(),
  );
  const follower =
    profileFollower.value === null ? extractDouyinFollowerCount(bodyText) : profileFollower;
  const nickname =
    firstNonEmpty(nicknameSelectors.map((selector) => $(selector).first().text())) ??
    normalizeNickname($('meta[property="og:title"]').attr('content')) ??
    normalizeNickname(documentTitle);
  const biography =
    firstNonEmpty(biographySelectors.map((selector) => $(selector).first().text())) ?? null;
  const platformCreatorId = profileUrl
    ? new URL(profileUrl).pathname.split('/').at(-1) || null
    : null;

  return {
    biography,
    followerCount: follower.value,
    followerCountRaw: follower.raw,
    nickname,
    parserConfidence: calculateProfileConfidence({
      biography,
      followerCount: follower.value,
      nickname,
      profileUrl,
    }),
    platformCreatorId,
    profileUrl,
  };
}

export function extractDouyinAuthorCardsFromHtml(html: string): DouyinAuthorCard[] {
  const $ = load(html);
  const cards = new Map<string, DouyinAuthorCard>();

  $('a[href*="/user/"]').each((_index, anchor) => {
    const rawHref = $(anchor).attr('href');
    if (!rawHref) return;
    const profileUrl = normalizePossibleProfileUrl(rawHref);
    if (!profileUrl || cards.has(profileUrl)) return;

    let container = $(anchor);
    let cardText = container.text().trim();
    for (let depth = 0; depth < 6; depth += 1) {
      const parent = container.parent();
      if (parent.length === 0) break;
      container = parent;
      const parentText = container.text().replace(/\s+/gu, ' ').trim();
      if (parentText.length >= cardText.length && parentText.length <= 900) cardText = parentText;
      if (/粉丝/u.test(parentText) && parentText.length <= 900) break;
    }
    const follower = extractDouyinFollowerCount(cardText);
    const platformCreatorId = new URL(profileUrl).pathname.split('/').at(-1)!;
    const anchorName = $(anchor).text().trim();
    cards.set(profileUrl, {
      cardText,
      followerCount: follower.value,
      followerCountRaw: follower.raw,
      nickname: anchorName || null,
      platformCreatorId,
      profileUrl,
    });
  });

  return [...cards.values()];
}

export function extractDouyinProfilePostsFromHtml(html: string): DouyinProfilePostEvidence[] {
  const $ = load(html);
  const posts = new Map<string, DouyinProfilePostEvidence>();
  $('a[href*="/video/"], a[href*="/note/"]').each((_index, anchor) => {
    const postUrl = normalizePossiblePostUrl($(anchor).attr('href'));
    if (!postUrl || posts.has(postUrl)) return;
    const closestPost = $(anchor)
      .closest('article, [data-e2e="user-post-item"], [data-testid="profile-post"]')
      .first();
    const card = closestPost.length > 0 ? closestPost : $(anchor);
    const rawLikeCount =
      firstNonEmpty([
        card.find('[data-e2e="video-like-count"]').first().text(),
        card.find('[data-testid="like-count"]').first().text(),
      ]) ?? '';
    const time = card.find('time').first();
    const publishedAt = parsePublishedAt(
      time.attr('datetime') ?? card.attr('data-publish-time') ?? time.text(),
    );
    posts.set(postUrl, {
      caption: firstNonEmpty([
        card.find('[data-e2e="video-desc"]').first().text(),
        card.find('[data-testid="video-caption"]').first().text(),
        $(anchor).attr('aria-label'),
      ]),
      likeCount: parseDouyinCompactCount(rawLikeCount),
      likeCountRaw: rawLikeCount.replace(/\s+/gu, '').trim(),
      platformPostId: new URL(postUrl).pathname.split('/').at(-1)!,
      postUrl,
      publishedAt,
    });
  });
  return [...posts.values()];
}

export function extractDouyinProfilePostsFromApi(payload: unknown): DouyinProfilePostEvidence[] {
  const root = asRecord(payload);
  if (!root || root.status_code !== 0 || !Array.isArray(root.aweme_list)) return [];

  const posts = new Map<string, DouyinProfilePostEvidence>();
  for (const rawAweme of root.aweme_list) {
    const aweme = asRecord(rawAweme);
    const platformPostId = readTrimmedString(aweme?.aweme_id);
    if (!aweme || !platformPostId || !/^\d+$/u.test(platformPostId)) continue;

    const shareInfo = asRecord(aweme.share_info);
    const postKind = readPostKindFromShareUrl(
      readTrimmedString(shareInfo?.share_url),
      platformPostId,
    );
    if (!postKind) continue;

    const statistics = asRecord(aweme.statistics);
    const likeCount = readNonNegativeInteger(statistics?.digg_count);
    const postUrl = normalizeDouyinPostUrl(`https://www.douyin.com/${postKind}/${platformPostId}`);
    posts.set(postUrl, {
      caption: firstNonEmpty([readTrimmedString(aweme.desc)]),
      likeCount,
      likeCountRaw: likeCount === null ? '' : String(likeCount),
      platformPostId,
      postUrl,
      publishedAt: parseApiPublishedAt(aweme.create_time),
    });
  }

  return [...posts.values()];
}

export function mergeDouyinProfilePostEvidence(
  domPosts: readonly DouyinProfilePostEvidence[],
  apiPosts: readonly DouyinProfilePostEvidence[],
): DouyinProfilePostEvidence[] {
  const posts = new Map<string, DouyinProfilePostEvidence>();
  for (const domPost of domPosts) posts.set(domPost.platformPostId, domPost);

  for (const apiPost of apiPosts) {
    const domPost = posts.get(apiPost.platformPostId);
    if (!domPost) {
      posts.set(apiPost.platformPostId, apiPost);
      continue;
    }
    posts.set(apiPost.platformPostId, {
      caption: domPost.caption ?? apiPost.caption,
      likeCount: apiPost.likeCount ?? domPost.likeCount,
      likeCountRaw: apiPost.likeCount === null ? domPost.likeCountRaw : apiPost.likeCountRaw,
      platformPostId: apiPost.platformPostId,
      postUrl: apiPost.postUrl,
      publishedAt: apiPost.publishedAt ?? domPost.publishedAt,
    });
  }

  return [...posts.values()];
}

export function selectDouyinPostsForRollingWindow(
  posts: readonly DouyinProfilePostEvidence[],
  observedAt: Date,
  rollingDays: number,
): DouyinProfilePostEvidence[] {
  if (!Number.isInteger(rollingDays) || rollingDays < 1) {
    throw new RangeError('rollingDays must be a positive integer.');
  }
  const cutoff = observedAt.getTime() - rollingDays * 24 * 60 * 60 * 1_000;
  return posts.filter((post) => {
    if (!post.publishedAt) return true;
    const timestamp = Date.parse(post.publishedAt);
    return timestamp >= cutoff && timestamp <= observedAt.getTime();
  });
}

function findProfileUrl($: ReturnType<typeof load>, sourceUrl?: string): string | null {
  const candidates = [
    sourceUrl,
    $('link[rel="canonical"]').attr('href'),
    $('meta[property="og:url"]').attr('content'),
    $('a[href*="/user/"]').first().attr('href'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizePossibleProfileUrl(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function normalizePossibleProfileUrl(rawUrl: string): string | null {
  try {
    return normalizeDouyinProfileUrl(new URL(rawUrl, 'https://www.douyin.com').toString());
  } catch (error) {
    if (error instanceof InvalidDouyinUrlError) return null;
    throw error;
  }
}

function normalizePossiblePostUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return normalizeDouyinPostUrl(new URL(rawUrl, 'https://www.douyin.com').toString());
  } catch (error) {
    if (error instanceof InvalidDouyinUrlError) return null;
    throw error;
  }
}

function parsePublishedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const milliseconds = /^\d{10}$/u.test(trimmed)
    ? Number(trimmed) * 1_000
    : /^\d{13}$/u.test(trimmed)
      ? Number(trimmed)
      : Date.parse(trimmed);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function parseApiPublishedAt(value: unknown): string | null {
  const seconds = readNonNegativeInteger(value);
  if (seconds === null || seconds === 0) return null;
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = value?.replace(/\s+/gu, ' ').trim();
    if (normalized) return normalized;
  }
  return null;
}

function normalizeNickname(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .replace(/的抖音(?:主页)?(?:[-—_].*)?$/u, '')
    .replace(/[-—_]抖音$/u, '')
    .trim();
  return normalized && normalized !== '抖音' ? normalized : null;
}

function calculateProfileConfidence(input: {
  biography: string | null;
  followerCount: number | null;
  nickname: string | null;
  profileUrl: string | null;
}): number {
  return Number(
    (
      (input.profileUrl ? 0.3 : 0) +
      (input.nickname ? 0.3 : 0) +
      (input.followerCount === null ? 0 : 0.3) +
      (input.biography ? 0.1 : 0)
    ).toFixed(2),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readPostKindFromShareUrl(
  rawShareUrl: string | null,
  expectedPostId: string,
): 'note' | 'video' | null {
  if (!rawShareUrl) return null;
  try {
    const url = new URL(rawShareUrl);
    if (url.protocol !== 'https:' || !/(^|\.)(?:douyin|iesdouyin)\.com$/iu.test(url.hostname)) {
      return null;
    }
    const match = url.pathname.match(/^\/(?:share\/)?(note|video)\/(\d+)\/?$/u);
    if (!match || match[2] !== expectedPostId) return null;
    return match[1] as 'note' | 'video';
  } catch {
    return null;
  }
}
