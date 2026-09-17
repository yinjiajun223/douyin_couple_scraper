import { extractDouyinFeedItemsFromHtml } from '@douyin/platform-douyin';
import type { DouyinFeedItem } from '@douyin/platform-douyin';

export interface RecommendationFeedPage {
  content(): Promise<string>;
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
  waitForTimeout(milliseconds: number): Promise<void>;
}

export interface RecommendationFeedOptions {
  maxFeedItems: number;
  maxScrolls: number;
  maxWaitMs?: number;
  minWaitMs?: number;
  random?: () => number;
}

export interface RecommendationFeedResult {
  items: DouyinFeedItem[];
  scrollCount: number;
}

export async function collectVisibleRecommendationFeed(
  page: RecommendationFeedPage,
  options: RecommendationFeedOptions,
): Promise<RecommendationFeedResult> {
  const minWaitMs = options.minWaitMs ?? 1_400;
  const maxWaitMs = options.maxWaitMs ?? 2_400;
  if (!Number.isInteger(options.maxFeedItems) || options.maxFeedItems < 1) {
    throw new RangeError('maxFeedItems must be a positive integer.');
  }
  if (!Number.isInteger(options.maxScrolls) || options.maxScrolls < 0) {
    throw new RangeError('maxScrolls must be a non-negative integer.');
  }
  if (minWaitMs < 1_000 || maxWaitMs < minWaitMs) {
    throw new RangeError('Recommendation feed pacing must wait at least one second per scroll.');
  }

  const random = options.random ?? Math.random;
  const items = new Map<string, DouyinFeedItem>();
  let scrollCount = 0;
  for (let pass = 0; pass <= options.maxScrolls; pass += 1) {
    for (const item of extractDouyinFeedItemsFromHtml(await page.content())) {
      items.set(item.postUrl, item);
      if (items.size >= options.maxFeedItems) break;
    }
    if (items.size >= options.maxFeedItems || pass === options.maxScrolls) break;

    const scrollPixels = 650 + Math.floor(random() * 300);
    await page.mouse.wheel(0, scrollPixels);
    scrollCount += 1;
    await page.waitForTimeout(minWaitMs + Math.floor(random() * (maxWaitMs - minWaitMs + 1)));
  }

  return { items: [...items.values()].slice(0, options.maxFeedItems), scrollCount };
}
