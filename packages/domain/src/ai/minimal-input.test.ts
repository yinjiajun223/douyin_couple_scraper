import { describe, expect, it } from 'vitest';

import { createDefaultCampaignRuleSet } from '@douyin/contracts';

import { buildMinimalAiInput } from './minimal-input.js';

describe('minimal AI input', () => {
  it('contains only configured rules, public copy, and selected HTTPS screenshots', () => {
    const source = {
      biography: '校园生活记录',
      nickname: '小影同学',
      posts: [{ caption: '宿舍的一天', sourceId: 'post-observation:1', fullVideo: 'binary' }],
      rules: createDefaultCampaignRuleSet(),
      selectedScreenshotUrls: [
        'https://private-oss.example/signed-selected-image',
        'file:///C:/cookies/profile.png',
      ],
      cookie: 'session-cookie-must-not-appear',
      deviceToken: 'device-token-must-not-appear',
      contactValue: 'wechat-secret',
      internalNotes: 'negotiation note',
      fullVideo: 'video-bytes-must-not-appear',
    };

    const input = buildMinimalAiInput(source);
    expect(input).toMatchInlineSnapshot(`
      {
        "publicProfile": {
          "biography": "校园生活记录",
          "nickname": "小影同学",
          "posts": [
            {
              "caption": "宿舍的一天",
              "sourceId": "post-observation:1",
            },
          ],
        },
        "rules": [
          {
            "id": "estimated-age",
            "kind": "ai",
            "maxAge": 24,
            "minAge": 18,
            "type": "estimated-age-band",
          },
          {
            "id": "amateur-status",
            "kind": "ai",
            "type": "amateur-status",
          },
        ],
        "selectedScreenshotUrls": [
          "https://private-oss.example/signed-selected-image",
        ],
      }
    `);
    const serialized = JSON.stringify(input);
    for (const forbidden of [
      source.cookie,
      source.deviceToken,
      source.contactValue,
      source.internalNotes,
      source.fullVideo,
      source.posts[0]!.fullVideo,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
