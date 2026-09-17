import { describe, expect, it } from 'vitest';

import { parseLegacyExport } from './legacy-import.js';

describe('legacy export parser', () => {
  it('keeps missing values unknown when parsing JSON', () => {
    expect(
      parseLegacyExport(
        JSON.stringify([
          {
            collectedAt: '2026-09-09T08:38:40.247Z',
            followerCount: null,
            nickname: '样例账号',
            profileUrl: 'https://www.douyin.com/user/sample-id',
          },
        ]),
        '.json',
      ),
    ).toEqual([
      {
        collectedAt: '2026-09-09T08:38:40.247Z',
        followerCount: null,
        followerCountRaw: null,
        nickname: '样例账号',
        profileUrl: 'https://www.douyin.com/user/sample-id',
        screenshotPath: null,
      },
    ]);
  });

  it('parses quoted CSV fields containing commas and newlines', () => {
    const records = parseLegacyExport(
      '"昵称","粉丝数","粉丝数原文","主页链接","主页截图","采集时间"\r\n' +
        '"账号,甲","2300","2.3K\n","https://www.douyin.com/user/csv-id","screenshots/a.png","2026-09-09T08:38:40.247Z"\r\n',
      '.csv',
    );
    expect(records).toEqual([
      expect.objectContaining({
        followerCount: 2_300,
        followerCountRaw: '2.3K',
        nickname: '账号,甲',
        screenshotPath: 'screenshots/a.png',
      }),
    ]);
  });
});
