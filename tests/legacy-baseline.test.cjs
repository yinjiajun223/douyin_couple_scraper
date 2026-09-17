const assert = require('node:assert/strict');
const test = require('node:test');

const {
  csvEscape,
  extractFollowerCount,
  normalizeProfileUrl,
  parseArgs,
  parseCompactNumber,
  safeFilename,
} = require('../legacy/scraper.cjs');

test('仓库默认入口启动新采集助手，旧脚本只保留在兼容路径', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const rootLauncher = fs.readFileSync(path.join(__dirname, '..', 'run.ps1'), 'utf8');
  const legacyLauncher = fs.readFileSync(path.join(__dirname, '..', 'legacy', 'run.ps1'), 'utf8');
  assert.match(rootLauncher, /@douyin\/collector/);
  assert.doesNotMatch(rootLauncher, /scraper\.cjs/);
  assert.match(legacyLauncher, /scraper\.cjs/);
});

test('legacy 默认参数保持不变', () => {
  assert.deepEqual(parseArgs([]), {
    keywords: ['情侣博主', '情侣日常', '情侣vlog', '恋爱日常'],
    minFollowers: 200,
    maxFollowers: 5000,
    maxProfiles: 80,
    scrolls: 12,
  });
});

test('legacy 自定义参数仍可解析', () => {
  assert.deepEqual(
    parseArgs([
      '--keywords',
      '情侣博主,情侣vlog',
      '--min-followers',
      '0',
      '--max-followers',
      '5000',
      '--max-profiles',
      '120',
      '--scrolls',
      '16',
    ]),
    {
      keywords: ['情侣博主', '情侣vlog'],
      minFollowers: 0,
      maxFollowers: 5000,
      maxProfiles: 120,
      scrolls: 16,
    },
  );
});

test('legacy 紧凑数字解析覆盖中文和字母单位', () => {
  assert.equal(parseCompactNumber('1,234'), 1234);
  assert.equal(parseCompactNumber('1.2万'), 12000);
  assert.equal(parseCompactNumber('2W'), 20000);
  assert.equal(parseCompactNumber('3.5k'), 3500);
  assert.equal(parseCompactNumber('1亿'), 100000000);
  assert.equal(parseCompactNumber('未知'), null);
});

test('legacy 粉丝文本可从前后两种布局识别', () => {
  assert.deepEqual(extractFollowerCount('关注 12  粉丝：3.5K  获赞 9万'), {
    raw: '3.5K',
    value: 3500,
  });
  assert.deepEqual(extractFollowerCount('当前共有 1.2 万 粉丝'), { raw: '1.2万', value: 12000 });
  assert.deepEqual(extractFollowerCount('粉丝未知'), { raw: '', value: null });
});

test('legacy 主页链接只接受抖音用户页并移除查询参数', () => {
  assert.equal(
    normalizeProfileUrl('https://www.douyin.com/user/example?from=search'),
    'https://www.douyin.com/user/example',
  );
  assert.equal(normalizeProfileUrl('https://example.com/user/example'), null);
  assert.equal(normalizeProfileUrl('https://www.douyin.com/video/example'), null);
});

test('legacy CSV 与文件名转义保持安全', () => {
  assert.equal(csvEscape('昵称,"测试"'), '"昵称,""测试"""');
  assert.equal(safeFilename('测试 / 博主:*?'), '测试___博主___');
});
