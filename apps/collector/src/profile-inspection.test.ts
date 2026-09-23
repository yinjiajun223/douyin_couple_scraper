import { readFileSync } from 'node:fs';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';
import { evaluateHardFilters } from '@douyin/domain/collector';
import { describe, expect, it, vi } from 'vitest';

import { DouyinProfileSafetyError, inspectDouyinCreatorProfile } from './profile-inspection.js';

const profileFixture = readFileSync(
  new URL(
    '../../../packages/platform-douyin/src/fixtures/profile-with-posts.html',
    import.meta.url,
  ),
  'utf8',
);
const profilePostsApiFixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../packages/platform-douyin/src/fixtures/profile-posts-api.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as unknown;

describe('潜在命中作者主页核验', () => {
  it('正常主页的隐藏验证脚本不应误报为需要人工验证码', async () => {
    const profileUrl = 'https://www.douyin.com/user/boundary-author';
    const page = {
      bringToFront: vi.fn(),
      content: vi
        .fn()
        .mockResolvedValue(
          profileFixture.replace(
            '</body>',
            '<script src="/verifycenter/client.js"></script><div hidden>请完成安全验证</div></body>',
          ),
        ),
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      locator: vi.fn().mockReturnValue({
        innerText: vi.fn().mockResolvedValue('边界作者 粉丝 4,999 作品'),
      }),
      off: vi.fn(),
      on: vi.fn(),
      title: vi.fn().mockResolvedValue('边界作者的抖音主页'),
      url: vi.fn().mockReturnValue(profileUrl),
      waitForTimeout: vi.fn(),
    };

    await expect(
      inspectDouyinCreatorProfile(page, { profileUrl, rollingDays: 15 }),
    ).resolves.toMatchObject({ profile: { followerCount: 4_999 } });
  });

  it('采集粉丝和窗口内作品证据，未知时间保持 null', async () => {
    const profileUrl = 'https://www.douyin.com/user/boundary-author';
    const page = {
      bringToFront: vi.fn(),
      content: vi.fn().mockResolvedValue(profileFixture),
      goto: vi.fn(),
      locator: vi.fn().mockReturnValue({
        innerText: vi.fn().mockResolvedValue('边界作者 粉丝 4,999 作品'),
      }),
      off: vi.fn(),
      on: vi.fn(),
      title: vi.fn().mockResolvedValue('边界作者的抖音主页'),
      url: vi.fn().mockReturnValue(profileUrl),
      waitForTimeout: vi.fn(),
    };
    const result = await inspectDouyinCreatorProfile(page, {
      observedAt: new Date('2026-09-15T00:00:00.000Z'),
      profileUrl,
      rollingDays: 15,
      settleMs: 1_500,
    });

    expect(result.profile).toMatchObject({ followerCount: 4_999, followerCountRaw: '4,999' });
    expect(result.posts.map((post) => post.platformPostId)).toEqual([
      '7600000000000000001',
      '7600000000000000002',
      '7600000000000000004',
    ]);
    expect(result.posts.at(-1)).toMatchObject({ publishedAt: null });
    expect(page.goto).toHaveBeenCalledWith(profileUrl, {
      timeout: 90_000,
      waitUntil: 'domcontentloaded',
    });
    expect(page.bringToFront).toHaveBeenCalledOnce();
  });

  it('DOM 只有作品链接时用可信主页响应补齐点赞和发布时间并通过硬筛', async () => {
    const profileUrl =
      'https://www.douyin.com/user/MS4wLjABAAAAxjEH0JUe2kT9XgIV5Tu8HC37aC8zVZNh0zK3DW8U29G4fmbecCGev8KmFD-HhqLU';
    const profileHtml = `<!doctype html>
      <html lang="zh-CN">
        <head><title>Cora的抖音主页</title></head>
        <body>
          <h1 data-e2e="user-title">Cora</h1>
          <span data-e2e="user-info-fans">粉丝 3305</span>
          <a href="/video/7685628150793749862" aria-label="17岁最好的礼物">作品</a>
        </body>
      </html>`;
    type ResponseListener = (response: {
      json(): Promise<unknown>;
      status(): number;
      url(): string;
    }) => void;
    let responseListener: ResponseListener | undefined;
    const response = {
      json: vi.fn().mockResolvedValue(profilePostsApiFixture),
      status: vi.fn().mockReturnValue(200),
      url: vi
        .fn()
        .mockReturnValue('https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=creator'),
    };
    const page = {
      bringToFront: vi.fn(),
      content: vi.fn().mockResolvedValue(profileHtml),
      goto: vi.fn(async () => {
        responseListener?.(response);
        await Promise.resolve();
      }),
      locator: vi.fn().mockReturnValue({
        innerText: vi.fn().mockResolvedValue('Cora 粉丝 3305 作品'),
      }),
      off: vi.fn(),
      on: vi.fn((_event: 'response', listener: ResponseListener) => {
        responseListener = listener;
      }),
      title: vi.fn().mockResolvedValue('Cora的抖音主页'),
      url: vi.fn().mockReturnValue(profileUrl),
      waitForTimeout: vi.fn(),
    };

    const result = await inspectDouyinCreatorProfile(page, {
      observedAt: new Date('2026-09-16T00:00:00.000Z'),
      profileUrl,
      rollingDays: 15,
      settleMs: 1_500,
    });
    const viralPost = result.posts.find((post) => post.platformPostId === '7685628150793749862');
    const screening = evaluateHardFilters(createDefaultCampaignRuleSet(), {
      creatorObservationId: 'cora-observation',
      evaluatedAt: new Date('2026-09-16T00:00:00.000Z'),
      followerCount: result.profile.followerCount,
      followerCountRaw: result.profile.followerCountRaw,
      posts: result.posts.map((post) => ({
        likeCount: post.likeCount,
        likeCountRaw: post.likeCountRaw,
        observedAt: new Date('2026-09-16T00:00:00.000Z'),
        postId: post.platformPostId,
        postObservationId: `observation-${post.platformPostId}`,
        postUrl: post.postUrl,
        publishedAt: post.publishedAt,
      })),
      postsWindowComplete: false,
    });

    expect(viralPost).toMatchObject({
      likeCount: 694_000,
      publishedAt: '2026-09-10T00:00:00.000Z',
    });
    expect(screening.outcome).toBe('pass');
    expect(page.on).toHaveBeenCalledWith('response', expect.any(Function));
    expect(page.off).toHaveBeenCalledWith('response', expect.any(Function));
  });

  it('在解析前把主文档 503 归为暂时性故障且错误对象不泄露页面内容或主页地址', async () => {
    const profileUrl = 'https://www.douyin.com/user/private-profile-address';
    const sensitiveBody = '服务异常，重新刷新获取数据 私密页面正文标记';
    const page = {
      bringToFront: vi.fn(),
      content: vi.fn().mockResolvedValue(`<html><body>${sensitiveBody}</body></html>`),
      goto: vi.fn().mockResolvedValue({ status: () => 503 }),
      locator: vi.fn().mockReturnValue({ innerText: vi.fn().mockResolvedValue(sensitiveBody) }),
      off: vi.fn(),
      on: vi.fn(),
      title: vi.fn().mockResolvedValue('私密标题标记'),
      url: vi.fn().mockReturnValue(profileUrl),
      waitForTimeout: vi.fn(),
    };

    const error = await inspectDouyinCreatorProfile(page, {
      profileUrl,
      rollingDays: 15,
      settleMs: 1_500,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DouyinProfileSafetyError);
    expect(error).toMatchObject({
      issue: { code: 'transient_page_failure', statusCode: 503 },
    });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(sensitiveBody);
    expect(serialized).not.toContain('私密标题标记');
    expect(serialized).not.toContain(profileUrl);
  });

  it('导航超时归暂时性故障，验证码仍要求人工处理', async () => {
    const profileUrl = 'https://www.douyin.com/user/navigation-test';
    const timeout = Object.assign(new Error(`page.goto: Timeout 90000ms ${profileUrl}`), {
      name: 'TimeoutError',
    });
    const timeoutPage = {
      bringToFront: vi.fn(),
      content: vi.fn(),
      goto: vi.fn().mockRejectedValue(timeout),
      locator: vi.fn(),
      off: vi.fn(),
      on: vi.fn(),
      title: vi.fn(),
      url: vi.fn().mockReturnValue(profileUrl),
      waitForTimeout: vi.fn(),
    };
    const timeoutError = await inspectDouyinCreatorProfile(timeoutPage, {
      profileUrl,
      rollingDays: 15,
    }).catch((caught: unknown) => caught);
    expect(timeoutError).toMatchObject({
      issue: {
        code: 'transient_page_failure',
        navigationErrorCode: 'NAVIGATION_TIMEOUT',
      },
    });
    expect(JSON.stringify(timeoutError)).not.toContain(profileUrl);

    const captchaPage = {
      bringToFront: vi.fn(),
      content: vi.fn().mockResolvedValue('<html><body>请完成安全验证</body></html>'),
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      locator: vi.fn().mockReturnValue({
        innerText: vi.fn().mockResolvedValue('请完成安全验证'),
      }),
      off: vi.fn(),
      on: vi.fn(),
      title: vi.fn().mockResolvedValue('作者主页'),
      url: vi.fn().mockReturnValue(profileUrl),
      waitForTimeout: vi.fn(),
    };
    await expect(
      inspectDouyinCreatorProfile(captchaPage, { profileUrl, rollingDays: 15 }),
    ).rejects.toMatchObject({ issue: { code: 'captcha_required' } });
  });
});
