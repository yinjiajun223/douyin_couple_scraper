import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  extractDouyinAuthorCardsFromHtml,
  extractDouyinAuthorProfileFromHtml,
  extractDouyinProfilePostsFromHtml,
  selectDouyinPostsForRollingWindow,
} from './authors.js';

const profileFixture = readFileSync(
  new URL('./fixtures/legacy-profile.html', import.meta.url),
  'utf8',
);
const searchFixture = readFileSync(
  new URL('./fixtures/legacy-search.html', import.meta.url),
  'utf8',
);
const profilePostsFixture = readFileSync(
  new URL('./fixtures/profile-with-posts.html', import.meta.url),
  'utf8',
);
const profileWithAccountMenuFixture = readFileSync(
  new URL('./fixtures/profile-with-account-menu.html', import.meta.url),
  'utf8',
);

describe('抖音作者 DOM 解析', () => {
  it('从旧版主页样例提取标准化作者资料', () => {
    expect(extractDouyinAuthorProfileFromHtml(profileFixture)).toEqual({
      biography: '校园日常｜记录生活',
      followerCount: 12_000,
      followerCountRaw: '1.2万',
      nickname: '小满同学',
      parserConfidence: 1,
      platformCreatorId: 'MS4wLjABAAAAopaque',
      profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAopaque',
    });
  });

  it('从旧版搜索卡片去重并拒绝站外伪造主页', () => {
    expect(extractDouyinAuthorCardsFromHtml(searchFixture)).toEqual([
      expect.objectContaining({
        followerCount: 4_982,
        followerCountRaw: '4,982',
        nickname: '阿柚',
        platformCreatorId: 'MS4wLjABAAAAfirst',
        profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAfirst',
      }),
      expect.objectContaining({
        followerCount: 860,
        followerCountRaw: '860',
        nickname: '小川',
        platformCreatorId: 'MS4wLjABAAAAsecond',
        profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAsecond',
      }),
    ]);
  });

  it('字段缺失时保留 unknown，而不是把粉丝数写成 0', () => {
    const profile = extractDouyinAuthorProfileFromHtml(
      '<html><head><title>无数据账号的抖音主页</title></head><body>暂未展示</body></html>',
      'https://www.douyin.com/user/unknown-author',
    );

    expect(profile).toMatchObject({
      followerCount: null,
      followerCountRaw: '',
      nickname: '无数据账号',
      platformCreatorId: 'unknown-author',
    });
    expect(profile.parserConfidence).toBeLessThan(1);
  });

  it('优先读取主页粉丝节点，不把登录账号菜单中的粉丝数当成目标达人数据', () => {
    expect(extractDouyinAuthorProfileFromHtml(profileWithAccountMenuFixture)).toMatchObject({
      followerCount: 23_259_000,
      followerCountRaw: '2325.9万',
      nickname: '鲤鱼Ace',
    });
  });

  it('滚动窗口包含精确边界和未知时间，并排除边界前 1 毫秒', () => {
    const posts = extractDouyinProfilePostsFromHtml(profilePostsFixture);
    const selected = selectDouyinPostsForRollingWindow(
      posts,
      new Date('2026-09-15T00:00:00.000Z'),
      15,
    );

    expect(selected.map((post) => post.platformPostId)).toEqual([
      '7600000000000000001',
      '7600000000000000002',
      '7600000000000000004',
    ]);
    expect(selected[0]).toMatchObject({
      likeCount: 10_000,
      publishedAt: '2026-08-31T00:00:00.000Z',
    });
    expect(selected[2]).toMatchObject({ likeCount: 15_000, publishedAt: null });
  });
});
