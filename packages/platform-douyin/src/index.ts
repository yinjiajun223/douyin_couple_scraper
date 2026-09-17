export const DOUYIN_PARSER_VERSION = '0.5.0';

export { extractDouyinFollowerCount, parseDouyinCompactCount } from './counts.js';
export type { ExtractedDouyinCount } from './counts.js';
export {
  extractDouyinAuthorCardsFromHtml,
  extractDouyinAuthorProfileFromHtml,
  extractDouyinProfilePostsFromApi,
  extractDouyinProfilePostsFromHtml,
  mergeDouyinProfilePostEvidence,
  selectDouyinPostsForRollingWindow,
} from './authors.js';
export type {
  DouyinAuthorCard,
  DouyinAuthorProfile,
  DouyinProfilePostEvidence,
} from './authors.js';
export {
  DOUYIN_FEED_CARD_SELECTORS,
  extractDouyinFeedItemsFromHtml,
  extractDouyinFeedItemsFromModuleFeed,
} from './feed.js';
export type { DouyinFeedItem } from './feed.js';
export {
  InvalidDouyinUrlError,
  normalizeDouyinPostUrl,
  normalizeDouyinProfileUrl,
} from './urls.js';
