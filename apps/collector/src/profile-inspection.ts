import {
  extractDouyinAuthorProfileFromHtml,
  extractDouyinProfilePostsFromApi,
  extractDouyinProfilePostsFromHtml,
  mergeDouyinProfilePostEvidence,
  normalizeDouyinProfileUrl,
  selectDouyinPostsForRollingWindow,
} from '@douyin/platform-douyin';
import type { DouyinAuthorProfile, DouyinProfilePostEvidence } from '@douyin/platform-douyin';

export interface ProfileInspectionResponse {
  json(): Promise<unknown>;
  status(): number;
  url(): string;
}

export interface ProfileInspectionPage {
  bringToFront(): Promise<void>;
  content(): Promise<string>;
  goto(url: string, options: { timeout: number; waitUntil: 'domcontentloaded' }): Promise<unknown>;
  off(event: 'response', listener: (response: ProfileInspectionResponse) => void): void;
  on(event: 'response', listener: (response: ProfileInspectionResponse) => void): void;
  url(): string;
  waitForTimeout(milliseconds: number): Promise<void>;
}

export interface DouyinProfileInspection {
  observedAt: string;
  posts: DouyinProfilePostEvidence[];
  profile: DouyinAuthorProfile;
}

export class DouyinProfileIdentityMismatchError extends Error {
  public constructor() {
    super('The loaded Douyin profile does not match the requested creator.');
    this.name = 'DouyinProfileIdentityMismatchError';
  }
}

export async function inspectDouyinCreatorProfile(
  page: ProfileInspectionPage,
  input: { profileUrl: string; rollingDays: number; observedAt?: Date; settleMs?: number },
): Promise<DouyinProfileInspection> {
  const requestedProfileUrl = normalizeDouyinProfileUrl(input.profileUrl);
  const observedAt = input.observedAt ?? new Date();
  const apiPosts = new Map<string, DouyinProfilePostEvidence>();
  const pendingResponses = new Set<Promise<void>>();
  const responseListener = (response: ProfileInspectionResponse) => {
    if (!isTrustedDouyinProfilePostsResponse(response)) return;
    const task = captureProfilePostsResponse(response, apiPosts).finally(() => {
      pendingResponses.delete(task);
    });
    pendingResponses.add(task);
  };
  page.on('response', responseListener);

  try {
    await page.goto(requestedProfileUrl, { timeout: 90_000, waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await page.waitForTimeout(Math.max(1_500, input.settleMs ?? 2_200));
    await Promise.allSettled([...pendingResponses]);
    if (normalizeDouyinProfileUrl(page.url()) !== requestedProfileUrl) {
      throw new DouyinProfileIdentityMismatchError();
    }

    const html = await page.content();
    const profile = extractDouyinAuthorProfileFromHtml(html, requestedProfileUrl);
    if (profile.profileUrl !== requestedProfileUrl || !profile.platformCreatorId) {
      throw new DouyinProfileIdentityMismatchError();
    }
    const posts = selectDouyinPostsForRollingWindow(
      mergeDouyinProfilePostEvidence(extractDouyinProfilePostsFromHtml(html), [
        ...apiPosts.values(),
      ]),
      observedAt,
      input.rollingDays,
    );
    return { observedAt: observedAt.toISOString(), posts, profile };
  } finally {
    page.off('response', responseListener);
  }
}

function isTrustedDouyinProfilePostsResponse(response: ProfileInspectionResponse): boolean {
  if (response.status() !== 200) return false;
  try {
    const url = new URL(response.url());
    return (
      url.protocol === 'https:' &&
      url.hostname === 'www.douyin.com' &&
      /^\/aweme\/v1\/web\/aweme\/post\/?$/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

async function captureProfilePostsResponse(
  response: ProfileInspectionResponse,
  posts: Map<string, DouyinProfilePostEvidence>,
): Promise<void> {
  try {
    const payload = await response.json();
    for (const post of extractDouyinProfilePostsFromApi(payload)) {
      posts.set(post.platformPostId, post);
    }
  } catch {
    // Response bodies can be unavailable after redirects or browser cancellation. DOM remains the fallback.
  }
}
