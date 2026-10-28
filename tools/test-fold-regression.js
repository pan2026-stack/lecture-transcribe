const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message.slice(0, 90)));
  await pg.goto('http://127.0.0.1:8787/?qa=1', { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  const r1 = await pg.evaluate(() => window.__foldTest(false));   // 正常情况
  const r2 = await pg.evaluate(() => window.__foldTest(true));    // 行已脱离文档（旧代码会崩）
  const counts = await pg.evaluate(() => ({
    runs: document.querySelectorAll('#transcript .silence-run').length,
    silent: document.querySelectorAll('#transcript .seg.is-silent').length,
  }));

  console.log('正常折叠:', r1);
  console.log('脱离文档折叠:', r2, r2 === 'ok' ? '✓ 不再抛错' : '✗ 仍然抛错');
  console.log('折叠块数:', JSON.stringify(counts), counts.runs === 1 ? '✓ 合并成一条' : '✗ 没有合并');
  console.log('页面错误:', errs.slice(0, 3));

  const pass = r1 === 'ok' && r2 === 'ok' && counts.runs === 1 && errs.length === 0;
  console.log(pass ? '通过' : '失败');
  await b.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
