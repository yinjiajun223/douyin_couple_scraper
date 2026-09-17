import type { CampaignRuleSet } from '@douyin/contracts';
import { parseCampaignRuleSet } from '@douyin/contracts';

export interface MinimalAiInput {
  publicProfile: {
    biography: string | null;
    nickname: string;
    posts: Array<{ caption: string | null; sourceId: string }>;
  };
  rules: CampaignRuleSet['aiRules'];
  selectedScreenshotUrls: string[];
}

export function buildMinimalAiInput(source: {
  biography: string | null;
  nickname: string;
  posts: Array<{ caption: string | null; sourceId: string }>;
  rules: CampaignRuleSet;
  selectedScreenshotUrls: string[];
}): MinimalAiInput {
  const rules = parseCampaignRuleSet(source.rules);
  return {
    publicProfile: {
      biography: source.biography,
      nickname: source.nickname,
      posts: source.posts.map((post) => ({ caption: post.caption, sourceId: post.sourceId })),
    },
    rules: rules.aiRules,
    selectedScreenshotUrls: source.selectedScreenshotUrls.filter((url) => {
      const parsed = new URL(url);
      return parsed.protocol === 'https:';
    }),
  };
}
