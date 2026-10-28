const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });

  // 1) 正常加载
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 70)));
  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  const inflight = [];
  page.on('request', (q) => inflight.push('→ ' + q.url().slice(0, 70)));
  page.on('response', (q) => inflight.push('← ' + q.status() + ' ' + q.url().slice(0, 70)));
  await new Promise((r) => setTimeout(r, 3000));
  console.log('请求流水:', inflight.slice(-8));
  const conv = await page.evaluate(() => window.__cfgErr || null);
  if (conv) console.log('loadConfig 报错:', String(conv).split('\n').slice(0, 4).join(' | '));
  const normal = await page.evaluate(() => ({
    ver: (document.getElementById('appVer') || {}).textContent,
    bannerHidden: document.getElementById('banner').classList.contains('hidden'),
    bannerText: (document.getElementById('banner') || {}).textContent,
    pill: (document.getElementById('pillAsr') || {}).textContent,
    modeChip: (document.getElementById('modeChip') || {}).textContent,
    cfgErr: window.__cfgErr || null,
  }));
  console.log('正常加载:', JSON.stringify(normal), 'errors:', errs.slice(0, 2));

  // 2) 模拟 config 前 2 次失败，看能否自愈
  const page2 = await browser.newPage();
  let fails = 0;
  await page2.setRequestInterception(true);
  page2.on('request', (req) => {
    if (req.url().includes('/api/config') && fails < 2) {
      fails += 1;
      req.abort('failed');
    } else {
      req.continue();
    }
  });
  await page2.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 4000));
  const healed = await page2.evaluate(() => ({
    ver: (document.getElementById('appVer') || {}).textContent,
    bannerHidden: document.getElementById('banner').classList.contains('hidden'),
  }));
  console.log('两次失败后:', JSON.stringify(healed), '(中止次数', fails, ')');

  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
