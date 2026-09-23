import {
  extractDouyinAuthorProfileFromHtml,
  extractDouyinProfilePostsFromApi,
  extractDouyinProfilePostsFromHtml,
  mergeDouyinProfilePostEvidence,
  normalizeDouyinProfileUrl,
  selectDouyinPostsForRollingWindow,
} from '@douyin/platform-douyin';
import type { DouyinAuthorProfile, DouyinProfilePostEvidence } from '@douyin/platform-douyin';

import { detectCollectionSafetyIssue } from './safety-gate.js';
import type { CollectionSafetyIssue } from './safety-gate.js';

export interface ProfileInspectionResponse {
  json(): Promise<unknown>;
  status(): number;
  url(): string;
}

export interface ProfileInspectionPage {
  bringToFront(): Promise<void>;
  content(): Promise<string>;
  goto(
    url: string,
    options: { timeout: number; waitUntil: 'domcontentloaded' },
  ): Promise<{ status(): number } | null | unknown>;
  locator(selector: string): { innerText(options: { timeout: number }): Promise<string> };
  off(event: 'response', listener: (response: ProfileInspectionResponse) => void): void;
  on(event: 'response', listener: (response: ProfileInspectionResponse) => void): void;
  title(): Promise<string>;
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

export class DouyinProfileSafetyError extends Error {
  public constructor(public readonly issue: CollectionSafetyIssue) {
    super(issue.humanMessage);
    this.name = 'DouyinProfileSafetyError';
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
    let navigationResponse: { status(): number } | null = null;
    try {
      const response = await page.goto(requestedProfileUrl, {
        timeout: 90_000,
        waitUntil: 'domcontentloaded',
      });
      if (hasStatus(response)) navigationResponse = response;
    } catch (error) {
      const issue = detectCollectionSafetyIssue({
        bodyText: '',
        navigationErrorCode: normalizeNavigationErrorCode(error),
        url: safePageUrl(page),
      });
      if (issue) throw new DouyinProfileSafetyError(issue);
      throw new DouyinProfileSafetyError({
        code: 'platform_restriction',
        humanMessage: '导航失败且无法可靠归类，采集已安全暂停，请人工检查浏览器。',
        navigationErrorCode: 'UNCLASSIFIED_NAVIGATION_ERROR',
      });
    }
    await page.bringToFront();
    await page.waitForTimeout(Math.max(1_500, input.settleMs ?? 2_200));
    await Promise.allSettled([...pendingResponses]);
    const html = await page.content();
    const statusCode = navigationResponse?.status();
    const issue = detectCollectionSafetyIssue({
      bodyText: await page.locator('body').innerText({ timeout: 5_000 }),
      ...(statusCode === undefined ? {} : { statusCode }),
      title: await page.title(),
      url: safePageUrl(page),
    });
    if (issue) throw new DouyinProfileSafetyError(issue);
    if (normalizeDouyinProfileUrl(page.url()) !== requestedProfileUrl) {
      throw new DouyinProfileIdentityMismatchError();
    }

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

function hasStatus(value: unknown): value is { status(): number } {
  return Boolean(
    value && typeof value === 'object' && 'status' in value && typeof value.status === 'function',
  );
}

function normalizeNavigationErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'NAVIGATION_TIMEOUT';
  const message = error instanceof Error ? error.message : '';
  for (const code of ['ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_RESET', 'ERR_TIMED_OUT'] as const) {
    if (message.includes(code)) return code;
  }
  return 'UNCLASSIFIED_NAVIGATION_ERROR';
}

function safePageUrl(page: ProfileInspectionPage): string {
  try {
    return page.url();
  } catch {
    return '';
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
