import { describe, expect, it } from 'vitest';

import { canTransitionPipeline, PIPELINE_STATUSES } from './candidate-workflow.js';

describe('candidate pipeline transition table', () => {
  it('allows only the explicitly defined business transitions', () => {
    const allowed = [
      ['pending_review', 'unsuitable'],
      ['pending_review', 'to_contact'],
      ['to_contact', 'contacted'],
      ['contacted', 'communicating'],
      ['communicating', 'partnered'],
      ['communicating', 'declined'],
      ['declined', 'to_contact'],
    ] as const;
    for (const [from, to] of allowed) expect(canTransitionPipeline(from, to)).toBe(true);
    for (const from of PIPELINE_STATUSES) {
      expect(canTransitionPipeline(from, from)).toBe(false);
    }
    expect(canTransitionPipeline('pending_review', 'partnered')).toBe(false);
    expect(canTransitionPipeline('partnered', 'pending_review')).toBe(false);
  });
});
