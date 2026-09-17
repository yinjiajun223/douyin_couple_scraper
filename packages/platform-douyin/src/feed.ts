import { load } from 'cheerio';

import { parseDouyinCompactCount } from './counts.js';
import {
  InvalidDouyinUrlError,
  normalizeDouyinPostUrl,
  normalizeDouyinProfileUrl,
} from './urls.js';

export interface DouyinFeedItem {
  authorNickname: string | null;
  authorProfileUrl: string | null;
  caption: string | null;
  likeCount: number | null;
  likeCountRaw: string;
  platformPostId: string;
  postUrl: string;
}

export const DOUYIN_FEED_CARD_SELECTORS = [
  'article',
  '[data-e2e="feed-item"]',
  '[data-testid="feed-item"]',
] as const;

export function extractDouyinFeedItemsFromHtml(html: string): DouyinFeedItem[] {
  const $ = load(html);
  const items = new Map<string, DouyinFeedItem>();

  $('a[href*="/video/"], a[href*="/note/"]').each((_index, anchor) => {
    const rawPostUrl = $(anchor).attr('href');
    const postUrl = rawPostUrl ? normalizePossibleUrl(rawPostUrl, 'post') : null;
    if (!postUrl || items.has(postUrl)) return;
    const closestCard = $(anchor).closest(DOUYIN_FEED_CARD_SELECTORS.join(',')).first();
    const card = closestCard.length > 0 ? closestCard : $(anchor);
    const authorLink = card.find('a[href*="/user/"]').first();
    const authorProfileUrl = normalizePossibleUrl(authorLink.attr('href'), 'profile');
    const likeText =
      firstNonEmpty([
        card.find('[data-e2e="video-like-count"]').first().text(),
        card.find('[data-testid="like-count"]').first().text(),
      ]) ?? '';
    const caption = firstNonEmpty([
      card.find('[data-e2e="video-desc"]').first().text(),
      card.find('[data-testid="video-caption"]').first().text(),
      $(anchor).attr('aria-label'),
    ]);
    items.set(postUrl, {
      authorNickname: firstNonEmpty([authorLink.text()]),
      authorProfileUrl,
      caption,
      likeCount: parseDouyinCompactCount(likeText),
      likeCountRaw: likeText.replace(/\s+/gu, '').trim(),
      platformPostId: new URL(postUrl).pathname.split('/').at(-1)!,
      postUrl,
    });
  });

  return [...items.values()];
}

export function extractDouyinFeedItemsFromModuleFeed(payload: unknown): DouyinFeedItem[] {
  const root = asRecord(payload);
  if (!root || root.status_code !== 0 || !Array.isArray(root.aweme_list)) return [];

  const items = new Map<string, DouyinFeedItem>();
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

    const author = asRecord(aweme.author);
    const authorSecUid = readTrimmedString(author?.sec_uid);
    if (!authorSecUid) continue;
    const authorProfileUrl = normalizePossibleUrl(
      `https://www.douyin.com/user/${encodeURIComponent(authorSecUid)}`,
      'profile',
    );
    if (!authorProfileUrl) continue;

    const statistics = asRecord(aweme.statistics);
    const likeCount = readNonNegativeInteger(statistics?.digg_count);
    const postUrl = normalizeDouyinPostUrl(`https://www.douyin.com/${postKind}/${platformPostId}`);
    items.set(postUrl, {
      authorNickname: firstNonEmpty([readTrimmedString(author?.nickname)]),
      authorProfileUrl,
      caption: firstNonEmpty([readTrimmedString(aweme.desc)]),
      likeCount,
      likeCountRaw: likeCount === null ? '' : String(likeCount),
      platformPostId,
      postUrl,
    });
  }

  return [...items.values()];
}

function normalizePossibleUrl(
  rawUrl: string | null | undefined,
  kind: 'post' | 'profile',
): string | null {
  if (!rawUrl) return null;
  try {
    const absolute = new URL(rawUrl, 'https://www.douyin.com').toString();
    return kind === 'post' ? normalizeDouyinPostUrl(absolute) : normalizeDouyinProfileUrl(absolute);
  } catch (error) {
    if (error instanceof InvalidDouyinUrlError) return null;
    throw error;
  }
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = value?.replace(/\s+/gu, ' ').trim();
    if (normalized) return normalized;
  }
  return null;
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
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readPostKindFromShareUrl(
  rawShareUrl: string | null,
  expectedPostId: string,
): 'note' | 'video' | null {
  if (!rawShareUrl) return null;
  try {
    const url = new URL(rawShareUrl);
    if (url.protocol !== 'https:' || !/(^|\.)(?:douyin|iesdouyin)\.com$/iu.test(url.hostname))
      return null;
    const match = url.pathname.match(/^\/(?:share\/)?(note|video)\/(\d+)\/?$/u);
    if (!match || match[2] !== expectedPostId) return null;
    return match[1] as 'note' | 'video';
  } catch {
    return null;
  }
}
