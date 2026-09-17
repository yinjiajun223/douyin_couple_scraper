const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

function parseArgs(argv) {
  const options = {
    keywords: ['情侣博主', '情侣日常', '情侣vlog', '恋爱日常'],
    minFollowers: 200,
    maxFollowers: 5000,
    maxProfiles: 80,
    scrolls: 12,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--keywords' && value) {
      options.keywords = value.split(',').map((item) => item.trim()).filter(Boolean);
      index += 1;
    } else if (flag === '--min-followers' && value) {
      options.minFollowers = Number(value);
      index += 1;
    } else if (flag === '--max-followers' && value) {
      options.maxFollowers = Number(value);
      index += 1;
    } else if (flag === '--max-profiles' && value) {
      options.maxProfiles = Number(value);
      index += 1;
    } else if (flag === '--scrolls' && value) {
      options.scrolls = Number(value);
      index += 1;
    }
  }

  for (const [key, value] of Object.entries(options)) {
    if (key !== 'keywords' && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`参数 ${key} 不是有效数字。`);
    }
  }
  return options;
}

function normalizeProfileUrl(value) {
  try {
    const url = new URL(value, 'https://www.douyin.com');
    if (url.hostname !== 'www.douyin.com' || !url.pathname.startsWith('/user/')) {
      return null;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function parseCompactNumber(rawValue) {
  if (!rawValue) return null;
  const cleaned = rawValue.replaceAll(',', '').replaceAll(' ', '').trim();
  const match = cleaned.match(/^([0-9]+(?:\.[0-9]+)?)(万|亿|[wWkK])?$/);
  if (!match) return null;
  const multipliers = { 万: 10000, 亿: 100000000, w: 10000, W: 10000, k: 1000, K: 1000 };
  return Math.round(Number(match[1]) * (multipliers[match[2]] || 1));
}

function extractFollowerCount(text) {
  if (!text) return { raw: '', value: null };
  const normalized = text.replace(/\u00a0/g, ' ');
  const patterns = [
    /粉丝\s*[:：]?\s*([0-9][0-9,.]*(?:\.[0-9]+)?\s*(?:万|亿|[wWkK])?)/,
    /([0-9][0-9,.]*(?:\.[0-9]+)?\s*(?:万|亿|[wWkK])?)\s*粉丝/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      const raw = match[1].replaceAll(' ', '');
      return { raw, value: parseCompactNumber(raw) };
    }
  }
  return { raw: '', value: null };
}

function safeFilename(value) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 70) || '未命名账号';
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function writeCsv(filePath, rows) {
  const columns = [
    ['昵称', 'nickname'],
    ['粉丝数', 'followerCount'],
    ['粉丝数原文', 'followerRaw'],
    ['内容匹配词', 'matchKeywords'],
    ['来源关键词', 'sourceKeywords'],
    ['主页链接', 'profileUrl'],
    ['主页截图', 'screenshot'],
    ['长相复核', 'appearanceReview'],
    ['情侣合照复核', 'couplePhotoReview'],
    ['采集状态', 'status'],
    ['采集时间', 'collectedAt'],
  ];
  const lines = [columns.map(([title]) => csvEscape(title)).join(',')];
  for (const row of rows) {
    lines.push(columns.map(([, key]) => csvEscape(row[key])).join(','));
  }
  fs.writeFileSync(filePath, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

function writeReviewHtml(filePath, rows) {
  const cards = rows.map((row) => {
    const screenshot = row.screenshot ? escapeHtml(row.screenshot.replaceAll('\\', '/')) : '';
    const nickname = escapeHtml(row.nickname);
    const profileUrl = escapeHtml(row.profileUrl);
    return `
      <article class="card">
        ${screenshot ? `<img src="${screenshot}" alt="${nickname} 主页截图">` : '<div class="missing">没有截图</div>'}
        <div class="meta">
          <h2>${nickname}</h2>
          <p>粉丝：${escapeHtml(row.followerCount ?? '未识别')}（${escapeHtml(row.followerRaw || '无原文')}）</p>
          <p>内容证据：${escapeHtml(row.matchKeywords || '未命中')}</p>
          <a href="${profileUrl}" target="_blank" rel="noreferrer">打开抖音主页</a>
          <p class="hint">请在 CSV 的“长相复核”和“情侣合照复核”两列填写“通过/不通过”。</p>
        </div>
      </article>`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>抖音情侣博主人工复核</title>
  <style>
    :root { color-scheme: dark; font-family: "Microsoft YaHei", system-ui, sans-serif; }
    body { margin: 0; padding: 28px; background: #101114; color: #f6f7f9; }
    header { max-width: 1200px; margin: 0 auto 24px; }
    h1 { margin: 0 0 10px; font-size: 28px; }
    header p, .hint { color: #afb4bf; }
    main { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 20px; max-width: 1400px; margin: auto; }
    .card { overflow: hidden; border: 1px solid #2c3038; border-radius: 18px; background: #191b20; box-shadow: 0 12px 35px rgba(0,0,0,.2); }
    img, .missing { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; object-position: top; background: #242730; }
    .missing { display: grid; place-items: center; color: #8d93a0; }
    .meta { padding: 18px; }
    h2 { margin: 0 0 12px; font-size: 20px; }
    p { margin: 8px 0; line-height: 1.55; }
    a { color: #ff4d6d; }
  </style>
</head>
<body>
  <header>
    <h1>抖音情侣博主人工复核</h1>
    <p>自动筛选条件：粉丝区间；人工复核条件：整体出镜效果、主页是否有真实情侣同框/合照。</p>
  </header>
  <main>${cards || '<p>本次没有筛选出符合粉丝区间的账号。</p>'}</main>
</body>
</html>`;
  fs.writeFileSync(filePath, html, 'utf8');
}

function locateChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function waitForEnter(message) {
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question(`${message}\n按回车继续……`);
  } finally {
    rl.close();
  }
}

async function collectSearchCandidates(page, keyword, scrolls) {
  const url = `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=user`;
  console.log(`\n搜索：${keyword}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2500);

  const candidates = new Map();
  for (let index = 0; index <= scrolls; index += 1) {
    const batch = await page.locator('a[href*="/user/"]').evaluateAll((anchors) => anchors.map((anchor) => {
      let container = anchor;
      let bestText = anchor.innerText || anchor.textContent || '';
      for (let depth = 0; depth < 6 && container.parentElement; depth += 1) {
        container = container.parentElement;
        const text = container.innerText || '';
        if (text.length >= bestText.length && text.length <= 900) bestText = text;
        if (/粉丝/.test(text) && text.length <= 900) {
          bestText = text;
          break;
        }
      }
      return { href: anchor.href, cardText: bestText };
    }));

    for (const item of batch) {
      const profileUrl = normalizeProfileUrl(item.href);
      if (profileUrl && !candidates.has(profileUrl)) {
        candidates.set(profileUrl, { profileUrl, cardText: item.cardText, sourceKeyword: keyword });
      }
    }

    console.log(`  已发现 ${candidates.size} 个主页`);
    if (index < scrolls) {
      await page.mouse.wheel(0, 950);
      await page.waitForTimeout(1400 + Math.floor(Math.random() * 900));
    }
  }
  return [...candidates.values()];
}

async function inspectProfile(page, candidate, options, screenshotDir, index, total) {
  console.log(`[${index}/${total}] 校验 ${candidate.profileUrl}`);
  try {
    await page.goto(candidate.profileUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(2200 + Math.floor(Math.random() * 1000));
    const bodyText = await page.locator('body').innerText({ timeout: 20000 });
    const title = await page.title();
    const cardFollowers = extractFollowerCount(candidate.cardText);
    const pageFollowers = extractFollowerCount(bodyText);
    const followers = pageFollowers.value == null ? cardFollowers : pageFollowers;
    const nicknameFromTitle = title.replace(/的抖音.*$/u, '').trim();
    const nicknameFromBody = bodyText.split(/\r?\n/).map((line) => line.trim()).find((line) => line && line.length <= 40 && !/^(关注|粉丝|获赞|私信|作品|推荐|喜欢)$/.test(line));
    const nickname = nicknameFromTitle && nicknameFromTitle !== '抖音' ? nicknameFromTitle : (nicknameFromBody || '未识别昵称');
    const evidenceWords = ['情侣', '女朋友', '男朋友', '老婆', '老公', '恋爱', '夫妻', '对象'];
    const matched = evidenceWords.filter((word) => bodyText.includes(word));
    const inRange = followers.value != null && followers.value >= options.minFollowers && followers.value <= options.maxFollowers;
    let screenshot = '';

    if (inRange) {
      const filename = `${String(index).padStart(3, '0')}_${safeFilename(nickname)}.png`;
      const absoluteScreenshot = path.join(screenshotDir, filename);
      await page.screenshot({ path: absoluteScreenshot, fullPage: false });
      screenshot = path.relative(path.join(screenshotDir, '..'), absoluteScreenshot);
    }

    return {
      nickname,
      followerCount: followers.value,
      followerRaw: followers.raw,
      matchKeywords: matched.join('、'),
      sourceKeywords: candidate.sourceKeywords.join('、'),
      profileUrl: candidate.profileUrl,
      screenshot,
      appearanceReview: '',
      couplePhotoReview: '',
      status: inRange ? (matched.length ? '粉丝区间通过，待看图复核' : '粉丝区间通过，情侣内容证据不足') : '粉丝区间不通过或未识别',
      collectedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      nickname: '读取失败',
      followerCount: null,
      followerRaw: '',
      matchKeywords: '',
      sourceKeywords: candidate.sourceKeywords.join('、'),
      profileUrl: candidate.profileUrl,
      screenshot: '',
      appearanceReview: '',
      couplePhotoReview: '',
      status: `读取失败：${String(error.message || error).slice(0, 120)}`,
      collectedAt: new Date().toISOString(),
    };
  }
}

async function main() {
  const { chromium } = require('playwright');
  const options = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(__dirname, '..');
  const dataDir = path.join(rootDir, 'data');
  const screenshotDir = path.join(dataDir, 'screenshots');
  const profileDir = path.join(dataDir, 'browser-profile');
  fs.mkdirSync(screenshotDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const executablePath = locateChrome();
  if (!executablePath) throw new Error('没有找到 Chrome 或 Edge，请设置 CHROME_PATH 环境变量。');

  console.log('启动浏览器。浏览器资料只保存在当前目录的 data/browser-profile，不读取你的日常浏览器资料。');
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: false,
    viewport: { width: 1440, height: 1100 },
    locale: 'zh-CN',
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`https://www.douyin.com/search/${encodeURIComponent(options.keywords[0])}?type=user`, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await waitForEnter('请在打开的浏览器中扫码登录抖音。若出现验证码，请由你本人完成；看到搜索结果后回到此窗口。');

    const candidateMap = new Map();
    for (const keyword of options.keywords) {
      const discovered = await collectSearchCandidates(page, keyword, options.scrolls);
      for (const candidate of discovered) {
        if (!candidateMap.has(candidate.profileUrl)) {
          candidateMap.set(candidate.profileUrl, { ...candidate, sourceKeywords: [keyword] });
        } else {
          const existing = candidateMap.get(candidate.profileUrl);
          if (!existing.sourceKeywords.includes(keyword)) existing.sourceKeywords.push(keyword);
          if (candidate.cardText.length > existing.cardText.length) existing.cardText = candidate.cardText;
        }
      }
      if (candidateMap.size >= options.maxProfiles) break;
    }

    const candidates = [...candidateMap.values()].slice(0, options.maxProfiles);
    console.log(`\n共收集 ${candidates.length} 个候选主页，开始逐个校验粉丝数。`);
    const results = [];
    for (let index = 0; index < candidates.length; index += 1) {
      results.push(await inspectProfile(page, candidates[index], options, screenshotDir, index + 1, candidates.length));
      await page.waitForTimeout(1000 + Math.floor(Math.random() * 1000));
    }

    const qualified = results.filter((row) => row.followerCount != null && row.followerCount >= options.minFollowers && row.followerCount <= options.maxFollowers);
    const allCsv = path.join(dataDir, '全部候选.csv');
    const qualifiedCsv = path.join(dataDir, `粉丝${options.minFollowers}-${options.maxFollowers}_待人工复核.csv`);
    const jsonFile = path.join(dataDir, '全部候选.json');
    const reviewHtml = path.join(dataDir, '人工复核.html');
    writeCsv(allCsv, results);
    writeCsv(qualifiedCsv, qualified);
    fs.writeFileSync(jsonFile, JSON.stringify(results, null, 2), 'utf8');
    writeReviewHtml(reviewHtml, qualified);

    console.log(`\n完成：${qualified.length} 个账号通过粉丝区间筛选。`);
    console.log(`筛选表：${qualifiedCsv}`);
    console.log(`看图复核：${reviewHtml}`);
  } finally {
    await context.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n采集失败：${error.stack || error.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  csvEscape,
  escapeHtml,
  extractFollowerCount,
  parseArgs,
  parseCompactNumber,
  normalizeProfileUrl,
  safeFilename,
  writeCsv,
  writeReviewHtml,
};
