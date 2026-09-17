import { describe, expect, it } from 'vitest';

import { retryDelayMs } from './job-queue.js';

describe('background job retry policy', () => {
  it('uses exponential backoff with a bounded maximum', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(retryDelayMs(20)).toBe(15 * 60_000);
  });
});
