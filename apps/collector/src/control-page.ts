export const COLLECTOR_CONTROL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>抖音采集助手 · 星探台</title>
  <style>
    :root { font-family: Inter, "MiSans", "PingFang SC", "Microsoft YaHei", sans-serif; color: #172036; background: #edf0f4; --ink: #172036; --graphite: #566077; --signal: #b83c2b; --mint: #2d8f76; --line: #d7dce5; --panel-radius: 8px 28px 8px 8px; --panel-shadow: 0 18px 55px rgba(27, 37, 58, .07); }
    * { box-sizing: border-box; } body { margin: 0; } main { max-width: 1080px; margin: auto; padding: 32px 24px 60px; }
    header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding-bottom: 24px; }
    h1 { font-size: 30px; margin: 6px 0; } h2 { font-size: 18px; margin: 0 0 14px; } p { line-height: 1.8; }
    .eyebrow { color: var(--signal); font: 800 12px Consolas, monospace; letter-spacing: .14em; } .muted, small { color: var(--graphite); }
    .badge { padding: 8px 12px; border-radius: 5px; color: #16614f; background: #ddf3eb; white-space: nowrap; }
    .grid { display: grid; grid-template-columns: 1fr 1.3fr; gap: 20px; } section { padding: 24px; background: white; border: 1px solid var(--line); border-radius: var(--panel-radius); box-shadow: var(--panel-shadow); }
    .step { color: #b83c2b; font: bold 14px Consolas, monospace; margin-right: 10px; }
    .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; } form { display: grid; gap: 14px; } label { display: grid; gap: 7px; font-size: 13px; font-weight: 600; }
    input, select, button { font: inherit; border-radius: 6px; padding: 10px 12px; min-height: 44px; } input, select { min-width: 0; width: 100%; border: 1px solid #cbd2de; background-color: white; color: var(--ink); font-weight: 700; transition: border-color 150ms ease, box-shadow 150ms ease; }
    select { appearance: none; padding-right: 38px; background-image: linear-gradient(45deg, transparent 50%, #69748a 50%), linear-gradient(135deg, #69748a 50%, transparent 50%); background-position: calc(100% - 17px) 18px, calc(100% - 12px) 18px; background-repeat: no-repeat; background-size: 5px 5px; cursor: pointer; }
    input:hover, select:hover { border-color: #aeb8c8; } input:focus, select:focus { border-color: #aeb8c8; box-shadow: 0 4px 14px rgba(23, 32, 54, .08); outline: 0; }
    button { border: 0; cursor: pointer; font-weight: 600; color: white; background: #b83c2b; } button.secondary { background: #eaf0f7; color: #273b59; } button.danger { background: #fff0ee; color: #9b3024; }
    button:disabled { opacity: .55; cursor: not-allowed; } :focus-visible { outline: 3px solid rgba(230, 84, 60, .34); outline-offset: 3px; } [hidden] { display: none !important; }
    .run { border-top: 1px solid #d7dce5; padding: 20px 0; } .run:first-child { border: 0; } .run h3 { margin: 0; font-size: 17px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; } .run-head { display: flex; gap: 12px; justify-content: space-between; }
    .counts { display: flex; gap: 24px; margin: 15px 0; color: #566077; font-size: 13px; } .counts b { color: #172036; font: 600 24px Consolas, monospace; margin-right: 6px; }
    #message:not(:empty) { padding: 12px 16px; background: #fff2d8; color: #704a0a; border-radius: 8px; margin: 0 0 20px; }
    #runtime-message { color: #566077; font-size: 13px; } .runs-section { margin-top: 20px; } .section-head { display: flex; gap: 10px; justify-content: space-between; }
    .note { font-size: 13px; color: #566077; padding-top: 14px; border-top: 1px solid #e2e7ee; margin-top: 18px; } .spaced { margin-top: 16px; }
    .empty { padding: 28px 0; color: #566077; } .run-note { padding: 10px 14px; background: #f2f5f9; font-size: 13px; }
    .safety-config { display: grid; grid-template-columns: 1fr auto; gap: 20px; align-items: end; padding: 16px; margin: 14px 0 18px; border: 1px solid #d7dce5; background: #f8fafc; border-radius: 8px; }
    .safety-config h3 { margin: 0 0 5px; font-size: 15px; } .safety-config p { margin: 0; font-size: 13px; color: #566077; }
    .safety-fields { display: flex; gap: 10px; align-items: end; } .safety-fields label { min-width: 190px; } .safety-fields .limit { min-width: 150px; }
    .diagnostic { color: #704a0a; background: #fff7e7; } .error-entry { overflow-wrap: anywhere; }
    @media(max-width:700px) { main { padding: 20px 14px; } .grid, .safety-config { grid-template-columns: 1fr; } section { padding: 18px; } header { align-items: start; } h1 { font-size: 24px; } .counts { gap: 12px; flex-wrap: wrap; } .row label { width: 100%; } .safety-fields { align-items: stretch; flex-direction: column; } }
  </style>
</head>
<body>
<main>
  <header><div><span class="eyebrow">星探台 / 本机采集</span><h1>抖音采集助手 <small id="collector-version"></small></h1><small>网页管理任务，这里控制你电脑上的抖音浏览器。</small></div><span class="badge" id="connection">正在连接…</span></header>
  <p id="message" role="status" aria-live="polite"></p>
  <div class="grid">
    <section aria-labelledby="pair-heading">
      <h2 id="pair-heading"><span class="step">01</span>连接团队工作台</h2>
      <p class="muted" id="pair-hint">在工作台「采集设备」生成配对码，填在这里。</p>
      <form id="pair-form">
        <label>设备名称<input id="device-name" required minlength="2" maxlength="100" aria-describedby="device-name-help" placeholder="例如：小王的运营电脑" /><small id="device-name-help">至少输入 2 个字符。</small></label>
        <label>配对码<input id="pair-code" required autocomplete="off" maxlength="200" placeholder="粘贴 10 分钟内有效的配对码" /></label>
        <button type="submit">完成配对</button>
      </form>
      <p class="note">配对只授权同步任务和公开数据；抖音登录资料不会离开本机。</p>
    </section>
    <section aria-labelledby="profile-heading">
      <h2 id="profile-heading"><span class="step">02</span>准备抖音画像</h2>
      <div class="row"><label for="profile-select">当前画像<select id="profile-select"><option value="">尚未创建画像</option></select></label><button id="select-profile" class="secondary">选择</button><button id="open-profile" class="secondary">打开抖音登录</button></div>
      <form id="profile-form" class="row spaced"><label for="profile-label">新画像名称<input id="profile-label" required maxlength="80" placeholder="例如：校园日常圈层" /></label><button type="submit" class="secondary">创建画像</button></form>
      <p class="note">先打开抖音，人工登录并确认推荐圈层。养号由你操作，助手不会点赞、关注、私信或点击“不感兴趣”。</p>
    </section>
  </div>
  <section class="runs-section" aria-labelledby="runs-heading">
    <div class="section-head"><h2 id="runs-heading"><span class="step">03</span>选择运行，人工开始</h2><button id="refresh" class="secondary">刷新任务</button></div>
    <form id="low-confidence-form" class="safety-config">
      <div><h3>未识别与低可信度处理</h3><p>解析阈值固定为 0.75。未识别到新作品、作者或低可信度页面时不会猜测和写入达人库，并按右侧策略继续或暂停；服务或网络瞬时故障会低频自动恢复，登录、验证码和明确平台限制仍立即暂停。</p></div>
      <div class="safety-fields">
        <label>处理方式<select id="low-confidence-mode"><option value="never_pause">永不因此暂停</option><option value="pause_after_consecutive">连续达到次数后暂停</option></select></label>
        <label class="limit" id="low-confidence-limit-label" hidden>连续次数<input id="low-confidence-limit" type="number" required min="1" max="1000" step="1" value="1" /></label>
        <button type="submit" class="secondary">保存策略</button>
      </div>
    </form>
    <p id="runtime-message"></p><p id="current-operation" class="run-note" hidden></p><div id="runs" aria-live="polite"><p class="empty">正在同步任务…</p></div>
  </section>
  <section class="runs-section" aria-labelledby="errors-heading">
    <h2 id="errors-heading">最近错误诊断</h2>
    <p class="muted">仅保存在本机，展示最近 20 条；继续采集或重启助手后仍可查看，超出保留上限会轮换。不包含 Cookie、令牌、页面正文或完整网址。出现新错误时，可截图此处用于排查。</p>
    <p id="diagnostic-storage-warning" class="run-note diagnostic" role="status" hidden>诊断文件读写失败，部分记录可能仅在本次启动中可见。请检查磁盘空间与数据目录权限。</p>
    <div id="error-diagnostics"><p class="empty">暂无错误诊断。旧版本发生的错误无法补录。</p></div>
  </section>
</main>
<script>
  const message = document.querySelector('#message');
  const runsRoot = document.querySelector('#runs');
  const profileSelect = document.querySelector('#profile-select');
  const lowConfidenceForm = document.querySelector('#low-confidence-form');
  const lowConfidenceMode = document.querySelector('#low-confidence-mode');
  const lowConfidenceLimit = document.querySelector('#low-confidence-limit');
  const lowConfidenceLimitLabel = document.querySelector('#low-confidence-limit-label');
  let actionBusy = false, refreshing = false, settingsDirty = false, lastRuns = '', lastProfiles = '', lastConnectionError = '', lastDiagnostics = '';
  let state = { profiles: [], runs: [], runtime: {} };
  const labels = { ready:'等待人工开始', claimed:'已领取，待开始', running:'采集中', paused:'已暂停', completed:'已完成', failed:'失败', terminated:'已终止' };
  const operationLabels = { start:'启动运行', collect:'采集流程', open_browser:'打开浏览器', read_feed:'读取推荐页', inspect_profile:'核验作者', check_safety:'检查页面状态', capture_screenshot:'截取证据', build_batch:'校验观察数据', persist_queue:'保存待同步数据', sync_batch:'同步观察数据', upload_evidence:'上传截图', sync_runs:'同步任务', get_device:'检查设备授权', report_progress:'上报进度', save_checkpoint:'保存本机进度', scroll_feed:'推荐页翻页' };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  async function request(path, options = {}) {
    const response = await fetch('/control/api' + path, { headers: { 'content-type': 'application/json' }, ...options });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || '操作失败，请检查连接后重试。');
    return payload;
  }
  function render(next) {
    state = next;
    const runtime = state.runtime || {};
    const currentOperation = runtime.currentOperation;
    const stageLabels = { navigate:'打开作者页', settle:'等待页面稳定', responses:'等待作品接口正文（最多 5 秒）', content:'读取作者页内容', safety:'核对作者页安全状态', parse:'解析作者数据' };
    document.querySelector('#current-operation').hidden = !currentOperation;
    document.querySelector('#current-operation').textContent = currentOperation ? (runtime.stopping ? '正在暂停，等待当前步骤结束：' : '当前步骤：') + (stageLabels[currentOperation.stage] || operationLabels[currentOperation.operation] || '采集流程') + ' · 已等待 ' + Math.max(0, Number(currentOperation.elapsedSeconds) || 0) + ' 秒' : '';
    document.querySelector('#collector-version').textContent = runtime.collectorVersion ? 'v' + runtime.collectorVersion : '';
    document.querySelector('#diagnostic-storage-warning').hidden = !runtime.diagnosticStorageError;
    const diagnostics = (runtime.errorDiagnostics || []).slice(0, 20);
    const diagnosticKey = JSON.stringify(diagnostics);
    if (diagnosticKey !== lastDiagnostics) {
      lastDiagnostics = diagnosticKey;
      const operations = { start:'启动运行', collect:'采集流程', open_browser:'打开浏览器', read_feed:'读取推荐页', inspect_profile:'核验作者', check_safety:'检查页面状态', check_feed_safety:'推荐页安全检查', check_profile_safety:'作者页安全检查', capture_screenshot:'截取证据', build_batch:'校验观察数据', persist_queue:'保存待同步数据', sync_batch:'同步观察数据', upload_evidence:'上传截图', sync_runs:'同步任务', get_device:'检查设备授权', report_progress:'上报进度', save_checkpoint:'保存本机进度', scroll_feed:'推荐页翻页' };
      const evidenceLabels = { CAPTCHA_VERIFICATION_URL:'验证页面地址', CAPTCHA_VISIBLE_DIALOG:'可见验证弹窗', CAPTCHA_VISIBLE_WIDGET:'可见验证控件或框架', CAPTCHA_DOCUMENT_PROMPT:'页面明确验证提示', login_required:'登录失效提示', platform_restriction:'平台限制信号', captcha_required:'安全验证信号' };
      document.querySelector('#error-diagnostics').innerHTML = diagnostics.length ? diagnostics.map((entry) => '<article class="run error-entry"><div class="run-head"><strong>' + escapeHtml(operations[entry.operation] || '采集流程') + '</strong><small>' + escapeHtml(new Date(entry.at).toLocaleString('zh-CN')) + '</small></div><p>' + escapeHtml(entry.errorType === 'CollectionPausedError' ? '安全暂停' : entry.errorType) + ' · ' + escapeHtml(entry.code) + (entry.statusCode ? ' · HTTP ' + escapeHtml(entry.statusCode) : '') + '</p>' + (evidenceLabels[entry.code] ? '<p>触发依据：' + escapeHtml(evidenceLabels[entry.code]) + '</p>' : '') + '<small>运行：' + escapeHtml(entry.runId || '未关联') + ' · 助手 v' + escapeHtml(entry.collectorVersion) + (entry.origin ? ' · 位置：' + escapeHtml(entry.origin) : '') + '<br>诊断编号：' + escapeHtml(entry.id) + '</small></article>').join('') : '<p class="empty">暂无错误诊断。旧版本发生的错误无法补录。</p>';
    }
    document.querySelector('#connection').textContent = state.connectionError ? '连接需处理' : state.paired === false ? '未配对' : '已连接团队';
    document.querySelector('#pair-hint').textContent = state.deviceName ? '已授权：' + state.deviceName + '。无需重复配对。' : '在工作台「采集设备」生成配对码，填在这里。';
    document.querySelector('#pair-form').hidden = Boolean(state.paired);
    const profileKey = JSON.stringify([state.profiles, state.selectedProfileId]);
    if (profileKey !== lastProfiles) {
      profileSelect.innerHTML = state.profiles.length ? state.profiles.map((p) => '<option value="' + escapeHtml(p.id) + '" ' + (p.id === state.selectedProfileId ? 'selected' : '') + '>' + escapeHtml(p.label) + '</option>').join('') : '<option value="">尚未创建画像</option>';
      lastProfiles = profileKey;
    }
    document.querySelector('#open-profile').disabled = !state.selectedProfileId || Boolean(runtime.busy);
    document.querySelector('#select-profile').disabled = !state.profiles.length || Boolean(runtime.activeRunId) || Boolean(runtime.busy);
    const policy = runtime.lowConfidencePolicy || { mode: 'never_pause' };
    if (!settingsDirty) {
      lowConfidenceMode.value = policy.mode;
      lowConfidenceLimit.value = String(policy.consecutiveLimit || 1);
    }
    lowConfidenceLimitLabel.hidden = lowConfidenceMode.value === 'never_pause';
    for (const control of lowConfidenceForm.elements) control.disabled = Boolean(runtime.busy);
    document.querySelector('#runtime-message').textContent = (runtime.pendingBatches || runtime.pendingEvidence) ? '有待同步数据 / 截图保存在本机。继续原运行可重试，不要删除本地数据。' : '每 3 秒更新状态。达到停止条件会自动结束，随后到达人库人工复核。';
    const runKey = JSON.stringify([state.runs, runtime.activeRunId, state.selectedProfileId, state.connectionError]);
    if (lastRuns !== runKey) {
      lastRuns = runKey;
      runsRoot.innerHTML = state.runs.length ? state.runs.map((run) => {
        const p = run.progress || {};
        const canStart = ['ready', 'claimed'].includes(run.status);
        const recovering = run.status === 'running' && runtime.activeRunId !== run.id;
        const start = canStart ? '<button data-action="start" ' + (!state.selectedProfileId || state.connectionError || runtime.activeRunId ? 'disabled' : '') + '>人工开始</button>' : '';
        const pause = run.status === 'running' && !recovering ? '<button data-action="pause" class="secondary">暂停</button>' : '';
        const resume = run.status === 'paused' || recovering ? '<button data-action="resume" class="secondary" ' + (state.connectionError || runtime.activeRunId ? 'disabled' : '') + '>继续</button>' : '';
        const terminate = ['running', 'paused', 'claimed'].includes(run.status) ? '<button data-action="terminate" class="danger">终止</button>' : '';
        const low = run.lowConfidenceDiagnostics || {};
        const recovery = run.recoveryDiagnostics || {};
        const recoverableSkips = run.recoverableSkips || {};
        const latest = low.lastIssue ? '<p class="run-note diagnostic">最近低可信度：' + Number(low.lastIssue.parserConfidence || 0).toFixed(2) + '；缺少 ' + escapeHtml((low.lastIssue.missingFields || []).join('、') || '关键主页字段') + '</p>' : '';
        const recoveryIssues = { transient_page_failure:'暂时性页面故障', platform_restriction:'平台限制', login_required:'登录失效', captcha_required:'安全验证', low_parser_confidence:'低可信度' };
        const recoveryStages = { idle:'空闲', reload_page:'重新加载当前页', recreate_profile_page:'重建页面', restart_browser:'同画像重启浏览器', circuit_open:'恢复熔断' };
        const recoveryResults = { waiting:'等待重试', attempting:'正在尝试', cooling:'冷却等待', recovered:'已恢复', skipped:'已跳过并继续', exhausted:'恢复预算耗尽', cancelled:'已取消', idle:'空闲' };
        const nextAttempt = recovery.nextAttemptAt ? '；下次尝试：' + escapeHtml(new Date(recovery.nextAttemptAt).toLocaleString('zh-CN')) : '';
        const recoveryTime = recovery.eventStartedAt ? ' · 发生于 ' + escapeHtml(new Date(recovery.eventStartedAt).toLocaleString('zh-CN')) : '';
        const recoveryNote = recovery.issueCode ? '<p class="run-note diagnostic">最近一次恢复记录（不代表当前步骤）：' + escapeHtml(recoveryIssues[recovery.issueCode] || '未知安全事件') + ' · ' + escapeHtml(recovery.pageType === 'feed' ? '推荐页' : '作者页') + ' · ' + escapeHtml(recoveryStages[recovery.stage] || '未知阶段') + ' · 第 ' + Number(recovery.attemptCount || 0) + ' 次 · ' + escapeHtml(recoveryResults[recovery.lastResult] || '未知结果') + recoveryTime + nextAttempt + '</p>' : '';
        const skipTime = recoverableSkips.lastSkippedAt ? ' · ' + escapeHtml(new Date(recoverableSkips.lastSkippedAt).toLocaleString('zh-CN')) : '';
        const skipNote = Number(recoverableSkips.total || 0) > 0 ? '<p class="run-note diagnostic">最近一次可恢复跳过（不代表当前步骤）：' + escapeHtml(recoverableSkips.lastPageType === 'feed' ? '推荐页' : '作者页') + ' · ' + escapeHtml(recoveryIssues[recoverableSkips.lastReason] || '暂时性页面故障') + skipTime + ' · 已跳过并继续</p>' : '';
        return '<article class="run" data-run-id="' + escapeHtml(run.id) + '"><div class="run-head"><h3>' + escapeHtml(run.campaignName || run.id) + '</h3><small>状态：' + escapeHtml(recovering ? '等待本机继续' : labels[run.status] || run.status) + '</small></div><div class="counts"><span><b>' + Number(p.feedItemsSeen || 0) + '</b>浏览作品</span><span><b>' + Number(p.creatorProfilesSeen || 0) + '</b>核验作者</span><span><b>' + Number(p.candidatesFound || 0) + '</b>硬筛通过</span><span><b>' + Number(low.skippedTotal || 0) + '</b>解析跳过</span><span><b>' + Number(recoverableSkips.total || 0) + '</b>故障跳过</span></div>' + (run.localMessage ? '<p class="run-note">' + escapeHtml(run.localMessage) + '</p>' : '') + recoveryNote + skipNote + latest + '<div class="actions">' + start + pause + resume + terminate + '</div></article>';
      }).join('') : '<p class="empty">还没有可执行的运行。请在工作台「筛选任务」保存任务后，点击「创建运行」。</p>';
    }
    if (state.connectionError) message.textContent = state.connectionError;
    else if (lastConnectionError && message.textContent === lastConnectionError) message.textContent = '';
    lastConnectionError = state.connectionError || '';
  }
  async function refresh() {
    if (refreshing || actionBusy) return;
    refreshing = true;
    try { render(await request('/state')); } catch { message.textContent = '本地助手连接中断。请检查启动终端，再刷新。'; }
    finally { refreshing = false; }
  }
  async function act(button, path, body, success) {
    if (actionBusy) return;
    actionBusy = true; button.disabled = true; message.textContent = '正在处理…';
    try { await request(path, { method: 'POST', body: JSON.stringify(body) }); message.textContent = success; lastRuns = ''; }
    catch(error) { message.textContent = error.message; }
    finally { actionBusy = false; button.disabled = false; await refresh(); }
  }
  document.querySelector('#pair-form').addEventListener('submit', async (event) => { event.preventDefault(); await act(event.submitter, '/pair', { deviceName: document.querySelector('#device-name').value, pairingCode: document.querySelector('#pair-code').value }, '设备已配对。接下来准备抖音画像。'); document.querySelector('#pair-code').value = ''; });
  document.querySelector('#profile-form').addEventListener('submit', (event) => { event.preventDefault(); void act(event.submitter, '/profiles', { label: document.querySelector('#profile-label').value }, '画像已创建，请选择画像并打开抖音登录。'); });
  document.querySelector('#select-profile').addEventListener('click', (event) => act(event.currentTarget, '/profiles/select', { profileId: profileSelect.value }, '已切换画像。请打开抖音确认登录状态。'));
  document.querySelector('#open-profile').addEventListener('click', (event) => act(event.currentTarget, '/profiles/open', {}, '抖音已打开。请人工登录、确认推荐圈层，再点击人工开始。'));
  lowConfidenceMode.addEventListener('change', () => { settingsDirty = true; lowConfidenceLimitLabel.hidden = lowConfidenceMode.value === 'never_pause'; });
  lowConfidenceLimit.addEventListener('input', () => { settingsDirty = true; });
  lowConfidenceForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = lowConfidenceMode.value === 'never_pause'
      ? { mode: 'never_pause' }
      : { mode: 'pause_after_consecutive', consecutiveLimit: Number(lowConfidenceLimit.value) };
    await act(event.submitter, '/settings/low-confidence', body, '未识别与低可信度处理策略已保存到本机。');
    settingsDirty = false;
  });
  document.querySelector('#refresh').addEventListener('click', refresh);
  runsRoot.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'terminate' && !confirm('终止后无法继续这次运行，已入库的候选会保留。确定终止？')) return;
    void act(button, '/runs/' + button.closest('[data-run-id]').dataset.runId + '/' + button.dataset.action, {}, '操作已完成，运行状态已更新。');
  });
  async function poll() { await refresh(); setTimeout(poll, 3000); }
  void poll();
</script>
</body>
</html>`;
