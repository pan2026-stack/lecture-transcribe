const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: [
      '--no-first-run', '--disable-gpu',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });

  const errors = [];
  pg.on('pageerror', (e) => errors.push({ msg: e.message, stack: (e.stack || '').split('\n').slice(0, 4).join(' | ') }));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push({ msg: 'c: ' + m.text().slice(0, 160), stack: '' }); });

  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  // 点主按钮开始录音
  const started = await pg.evaluate(() => {
    const btn = document.getElementById('btnMain');
    if (!btn) return 'no-btn';
    btn.click();
    return btn.dataset.state || 'clicked';
  });
  console.log('开始录音:', started);

  for (let i = 1; i <= 8; i += 1) {
    await sleep(5000);
    const st = await pg.evaluate(() => ({
      rows: document.querySelectorAll('#transcript .seg').length,
      silent: document.querySelectorAll('#transcript .seg.is-silent').length,
      runs: document.querySelectorAll('#transcript .silence-run').length,
      pending: document.querySelectorAll('#transcript .x.pending').length,
      banner: (document.getElementById('banner') || {}).textContent || '',
      state: (document.getElementById('btnMain') || {}).dataset ? document.getElementById('btnMain').dataset.state : '',
    }));
    console.log(`t=${i * 5}s`, JSON.stringify(st));
    if (errors.length) break;
  }

  console.log('错误数:', errors.length);
  errors.slice(0, 5).forEach((e, i) => console.log(` ${i + 1}. ${e.msg}\n    ${e.stack}`));

  await pg.evaluate(() => { const b2 = document.getElementById('btnMain'); if (b2) b2.click(); });
  await sleep(1500);
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
