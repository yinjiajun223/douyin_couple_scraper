import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { buildRuleSet, ruleFieldDefaults } from '../lib/campaign-rules';
import { StopConditionInputs } from './RuleFieldInputs';

describe('采集停止条件表单', () => {
  it('最长运行时间明确限制为 1,440 分钟并提示任一条件先到即停止', () => {
    const html = renderToStaticMarkup(<StopConditionInputs defaults={ruleFieldDefaults(null)} />);

    expect(html).toContain('name="maxDurationMinutes"');
    expect(html).toContain('max="1440"');
    expect(html).toContain('最多 1,440 分钟（24 小时）');
    expect(html).toContain('任一先到即停止');
  });

  it('只保留 1,440 分钟可以创建规则，1,441 分钟在客户端被拒绝', () => {
    const baseValues = {
      followerMax: 5_000,
      followerMin: 0,
      manualLabel: '',
      maxFeedItems: null,
      minimumLikes: 10_000,
      targetCandidates: null,
      windowDays: 15,
    };
    expect(buildRuleSet(null, { ...baseValues, maxDurationMinutes: 1_440 })).toMatchObject({
      stopConditions: { maxDurationMinutes: 1_440 },
    });
    expect(buildRuleSet(null, { ...baseValues, maxDurationMinutes: 1_441 })).toBeNull();
  });
});
