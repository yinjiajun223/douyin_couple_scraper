import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { extractDouyinFeedItemsFromHtml, extractDouyinFeedItemsFromModuleFeed } from './feed.js';

const feedFixture = readFileSync(
  new URL('./fixtures/recommendation-feed.html', import.meta.url),
  'utf8',
);
const jingxuanFeedFixture = JSON.parse(
  readFileSync(new URL('./fixtures/jingxuan-module-feed.json', import.meta.url), 'utf8'),
) as unknown;

describe('抖音推荐流作品解析', () => {
  it('只读取作品和公开作者证据，并按标准化作品链接去重', () => {
    expect(extractDouyinFeedItemsFromHtml(feedFixture)).toEqual([
      {
        authorNickname: '阿鹿同学',
        authorProfileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAcampus',
        caption: '下课后的校园日常',
        likeCount: 14_000,
        likeCountRaw: '1.4万',
        platformPostId: '7500000000000000001',
        postUrl: 'https://www.douyin.com/video/7500000000000000001',
      },
      {
        authorNickname: '寝室小周',
        authorProfileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAdorm',
        caption: '周末随手拍',
        likeCount: 9_876,
        likeCountRaw: '9876',
        platformPostId: '7500000000000000002',
        postUrl: 'https://www.douyin.com/note/7500000000000000002',
      },
    ]);
  });

  it('从精选页 module feed 读取公开作品，并拒绝缺少作者或 ID 冲突的记录', () => {
    expect(extractDouyinFeedItemsFromModuleFeed(jingxuanFeedFixture)).toEqual([
      {
        authorNickname: '校园小林',
        authorProfileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAfixture-campus',
        caption: '放学后的校园日常',
        likeCount: 12_500,
        likeCountRaw: '12500',
        platformPostId: '7600000000000000001',
        postUrl: 'https://www.douyin.com/video/7600000000000000001',
      },
    ]);
  });
});
