import { describe, expect, it } from 'vitest';

import {
  InvalidDouyinUrlError,
  normalizeDouyinPostUrl,
  normalizeDouyinProfileUrl,
} from './urls.js';

describe('抖音公开地址规范化', () => {
  it('移除跟踪参数、片段与尾斜杠', () => {
    expect(
      normalizeDouyinProfileUrl('https://www.douyin.com/user/creator-1/?from=feed#profile'),
    ).toBe('https://www.douyin.com/user/creator-1');
    expect(normalizeDouyinPostUrl('https://douyin.com/video/post-1?previous_page=web')).toBe(
      'https://www.douyin.com/video/post-1',
    );
  });

  it.each([
    'http://www.douyin.com/user/creator-1',
    'https://douyin.com.evil.example/user/creator-1',
    'https://www.douyin.com/search/creator-1',
  ])('拒绝非 HTTPS、伪造域名或错误路径：%s', (url) => {
    expect(() => normalizeDouyinProfileUrl(url)).toThrow(InvalidDouyinUrlError);
  });
});
