import { describe, expect, it } from 'vitest';

import { extractDouyinFollowerCount, parseDouyinCompactCount } from './counts.js';

describe('抖音紧凑计数解析', () => {
  it.each([
    ['1.2万', 12_000],
    ['10k', 10_000],
    ['1.5W 获赞', 15_000],
    ['2m', 2_000_000],
    ['1,234', 1_234],
    ['点赞 9999', 9_999],
  ])('将 %s 解析为 %i', (rawValue, expected) => {
    expect(parseDouyinCompactCount(rawValue)).toBe(expected);
  });

  it.each(['', '--', '暂未展示'])(`无法识别 %s 时返回 null`, (rawValue) => {
    expect(parseDouyinCompactCount(rawValue)).toBeNull();
  });
});

describe('旧脚本粉丝文字提取', () => {
  it.each([
    ['粉丝：1.2万', { raw: '1.2万', value: 12_000 }],
    ['4,982 粉丝', { raw: '4,982', value: 4_982 }],
    ['关注 12 获赞 8万', { raw: '', value: null }],
  ])('从 %s 提取粉丝计数', (text, expected) => {
    expect(extractDouyinFollowerCount(text)).toEqual(expected);
  });
});
