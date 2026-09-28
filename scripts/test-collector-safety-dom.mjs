import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { readCaptchaEvidence } from '../apps/collector/dist/captcha-evidence.js';
import { detectCollectionSafetyIssue } from '../apps/collector/dist/safety-gate.js';
import { inspectDouyinCreatorProfile } from '../apps/collector/dist/profile-inspection.js';

// Isolated local HTML only: no real Douyin requests, login state or profile data.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', (route) =>
    route.fulfill({ body: '<body></body>', contentType: 'text/html' }),
  );
  const cases = [
    ['ordinary caption', '<article><p>反诈科普：不要把验证码告诉陌生人</p></article>', null],
    ['ordinary safety caption', '<article><h3>汽车安全验证测试记录</h3></article>', null],
    ['quoted instructions', '<article><p>请完成安全验证</p></article>', null],
    ['creator description', '<p data-e2e="user-desc">请完成安全验证</p>', null],
    [
      'hidden script',
      '<script type="application/json">{"message":"安全验证"}</script><main>正常页面</main>',
      null,
    ],
    ['hidden prompt', '<div hidden><p>请完成安全验证</p></div>', null],
    ['hidden nested text', '<div><span style="opacity:0">请完成安全验证</span></div>', null],
    [
      'split visible instruction',
      '<div><span>请完成</span><span>安全验证</span></div>',
      'CAPTCHA_DOCUMENT_PROMPT',
    ],
    ['transparent prompt', '<div style="opacity:0"><p>请完成安全验证</p></div>', null],
    ['offscreen prompt', '<div style="position:absolute;top:3000px">请完成安全验证</div>', null],
    ['hidden dialog', '<div role="dialog" style="display:none">请完成安全验证<input></div>', null],
    [
      'normal modal caption',
      '<div role="dialog"><article>不要把验证码告诉陌生人</article><button>关闭</button></div>',
      null,
    ],
    [
      'visible challenge dialog',
      '<div role="dialog"><h2>安全验证</h2><input aria-label="验证码"><button>提交</button></div>',
      'CAPTCHA_VISIBLE_DIALOG',
    ],
    [
      'visible slider prompt',
      '<div role="dialog"><p>请拖动滑块完成验证</p><div role="slider" style="width:100px;height:30px"></div></div>',
      'CAPTCHA_VISIBLE_DIALOG',
    ],
    ['standalone challenge', '<h1>请完成安全验证</h1>', 'CAPTCHA_DOCUMENT_PROMPT'],
    ['bare document challenge', '请完成安全验证', 'CAPTCHA_DOCUMENT_PROMPT'],
    [
      'visible widget',
      '<div id="captcha_verify_container"><canvas width="100" height="80"></canvas></div>',
      'CAPTCHA_VISIBLE_WIDGET',
    ],
    [
      'hidden widget',
      '<div hidden><div id="captcha_verify_container"><canvas width="100" height="80"></canvas></div></div>',
      null,
    ],
    [
      'visible verification frame',
      '<iframe src="https://local.test/verifycenter"></iframe>',
      'CAPTCHA_VISIBLE_WIDGET',
    ],
    [
      'hidden verification frame',
      '<iframe hidden src="https://local.test/verifycenter"></iframe>',
      null,
    ],
  ];
  for (const [label, html, expected] of cases) {
    await page.setContent(html);
    const evidence = await readCaptchaEvidence(page);
    assert.equal(evidence, expected, label);
    const issue = detectCollectionSafetyIssue({
      url: 'https://www.douyin.com/user/local-fixture',
      title: '测试作者',
      bodyText: await page.locator('body').innerText(),
      captchaEvidence: evidence,
    });
    assert.equal(
      issue?.code ?? null,
      expected ? 'captcha_required' : null,
      label + ' classification',
    );
  }
  let hasChallenge = false;
  await page.unroute('**/*');
  await page.route('**/*', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<html><head><title>本地测试作者</title></head><body><h1 data-e2e="user-title">本地测试作者</h1><span data-e2e="user-info-fans">粉丝 1200</span><article><p>不要把验证码告诉陌生人</p></article>${hasChallenge ? '<div role="dialog"><p>请完成安全验证</p><input></div>' : ''}</body></html>`,
    }),
  );
  const input = {
    profileUrl: 'https://www.douyin.com/user/local-fixture',
    rollingDays: 15,
    settleMs: 1500,
  };
  const result = await inspectDouyinCreatorProfile(page, input);
  assert.equal(result.profile.followerCount, 1200, 'actual profile call accepts ordinary content');
  hasChallenge = true;
  await assert.rejects(
    inspectDouyinCreatorProfile(page, input),
    (error) =>
      error.issue?.code === 'captcha_required' && error.issue.evidence === 'CAPTCHA_VISIBLE_DIALOG',
  );
  console.log(
    `Collector safety DOM smoke passed: ${cases.length} DOM cases + 2 real profile-call cases.`,
  );
} finally {
  await browser.close();
}
