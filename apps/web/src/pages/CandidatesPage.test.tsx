import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { CandidateDetailData } from '../types';
import { CandidateDetailView } from './CandidatesPage';

describe('达人详情快捷复核', () => {
  it('在详情顶部直接提供通过和不通过按钮并保留当前结论', () => {
    const detail = {
      candidate: {
        archivedAt: null,
        campaignName: '校园达人',
        id: 'candidate-1',
        pipelineStatus: 'pending_review',
        tags: [],
        version: 3,
      },
      evaluations: [],
      media: [],
      observations: [
        {
          biography: '校园内容创作者',
          device: { id: 'device-1', name: '运营电脑' },
          followerCount: 12_000,
          followerCountRaw: '1.2万',
          nickname: '测试达人',
          observedAt: '2026-09-29T00:00:00.000Z',
          profileUrl: 'https://www.douyin.com/user/test',
        },
      ],
      sources: [],
      workflow: {
        candidateVersion: 3,
        events: [],
        notes: [],
        outreach: null,
        pipelineStatus: 'pending_review',
        reviews: [
          {
            createdAt: '2026-09-29T00:00:00.000Z',
            decision: 'approved',
            id: 'review-1',
            reason: null,
            reviewerDisplayName: '运营员',
          },
        ],
      },
    } as unknown as CandidateDetailData;

    const html = renderToStaticMarkup(
      <CandidateDetailView canWrite csrfToken="token" detail={detail} onSaved={vi.fn()} />,
    );

    expect(html).toContain('aria-label="一键人工复核"');
    expect(html).toContain('class="candidate-quick-approve"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('>通过</button>');
    expect(html).toContain('>不通过</button>');
  });
});
