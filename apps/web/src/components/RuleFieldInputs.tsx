import type { RuleFieldDefaults } from '../lib/campaign-rules';

// 任务与模板共用同一组规则字段；字段 name 是 readRuleForm / buildRuleSet 读取表单的契约。
export function HardRuleInputs({
  defaults,
  showViral,
}: {
  defaults: RuleFieldDefaults;
  showViral: boolean;
}) {
  return (
    <>
      <label>
        粉丝下限
        <input
          defaultValue={defaults.followerMin}
          min="0"
          name="followerMin"
          required
          type="number"
        />
      </label>
      <label>
        粉丝上限
        <input
          defaultValue={defaults.followerMax}
          min="0"
          name="followerMax"
          required
          type="number"
        />
      </label>
      {showViral ? (
        <>
          <label>
            观察天数
            <input
              defaultValue={defaults.windowDays}
              min="1"
              name="windowDays"
              required
              type="number"
            />
          </label>
          <label>
            点赞门槛
            <input
              defaultValue={defaults.minimumLikes}
              min="0"
              name="minimumLikes"
              required
              type="number"
            />
          </label>
        </>
      ) : null}
    </>
  );
}

export function StopConditionInputs({ defaults }: { defaults: RuleFieldDefaults }) {
  return (
    <>
      <label>
        最多浏览作品
        <input defaultValue={defaults.maxFeedItems} min="1" name="maxFeedItems" type="number" />
      </label>
      <label>
        最长运行分钟
        <input
          defaultValue={defaults.maxDurationMinutes}
          min="1"
          name="maxDurationMinutes"
          type="number"
        />
      </label>
      <label>
        目标候选数
        <input
          defaultValue={defaults.targetCandidates}
          min="1"
          name="targetCandidates"
          type="number"
        />
      </label>
      <label className="wide-field">
        人工复核项（可选）
        <input
          defaultValue={defaults.manualLabel}
          name="manualLabel"
          placeholder="例如：主页内容是否适合品牌"
        />
      </label>
    </>
  );
}
