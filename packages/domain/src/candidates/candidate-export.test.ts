import { describe, expect, it } from 'vitest';

import { CANDIDATE_EXPORT_HEADERS, toCsvCell } from './candidate-export.js';

describe('candidate CSV export', () => {
  it('uses a fixed business-field whitelist and escapes formulas, quotes, and newlines', () => {
    expect(CANDIDATE_EXPORT_HEADERS).not.toContain('Cookie' as never);
    expect(CANDIDATE_EXPORT_HEADERS).not.toContain('设备令牌' as never);
    expect(CANDIDATE_EXPORT_HEADERS).not.toContain('AI密钥' as never);
    expect(CANDIDATE_EXPORT_HEADERS).not.toContain('OSS密钥' as never);
    expect(toCsvCell('=HYPERLINK("bad")')).toBe('"\'=HYPERLINK(""bad"")"');
    expect(toCsvCell('两行\n备注')).toBe('"两行\n备注"');
  });
});
