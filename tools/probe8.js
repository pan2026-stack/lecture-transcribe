const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const page = await browser.newPage();
  const logs = [];
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + (e.stack || e.message)));
  page.on('console', (m) => { if (m.type() === 'error') logs.push('CONSOLE ' + m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) logs.push('HTTP ' + r.status() + ' ' + r.url().slice(0, 60)); });

  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 3000));

  const state = await page.evaluate(() => ({
    ver: (document.getElementById('appVer') || {}).textContent,
    pill: (document.getElementById('pillAsr') || {}).textContent,
    modeChip: (document.getElementById('modeChip') || {}).textContent,
    banner: (document.getElementById('banner') || {}).textContent,
    bannerHidden: (document.getElementById('banner') || {}).classList.contains('hidden'),
    bootCfg: !!window.__BOOT_CONFIG,
    cfgErr: window.__cfgErr || null,
    cfgModel: (document.getElementById('cfgModel') || {}).value || '',
    connAsr: (document.getElementById('connAsr') || {}).textContent || '',
    connNotes: (document.getElementById('connNotes') || {}).textContent || '',
  }));

  console.log('页面状态:', JSON.stringify(state, null, 2));
  console.log('错误清单:');
  logs.slice(0, 6).forEach((l) => console.log('  ' + l.split('\n').slice(0, 3).join(' | ')));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
