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
  pg.on('pageerror', (e) => errors.push({ msg: e.message, stack: (e.stack || '').split('\n').slice(0, 5).join(' | ') }));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push({ msg: 'c: ' + m.text().slice(0, 160), stack: '' }); });

  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  await pg.evaluate(() => document.getElementById('btnMain').click());
  await sleep(900);

  const modal = await pg.evaluate(() => {
    const m = document.getElementById('courseModal');
    if (!m || m.classList.contains('hidden')) return 'no-modal';
    const input = m.querySelector('input');
    if (input) input.value = '自测静音';
    const go = document.getElementById('btnCourseGo');
    if (go) go.click();
    return 'go';
  });
  console.log('课程弹窗:', modal);

  for (let i = 1; i <= 10; i += 1) {
    await sleep(5000);
    const st = await pg.evaluate(() => ({
      state: (document.getElementById('btnMain') || {}).dataset.state,
      rows: document.querySelectorAll('#transcript .seg').length,
      silent: document.querySelectorAll('#transcript .seg.is-silent').length,
      runs: document.querySelectorAll('#transcript .silence-run').length,
      banner: (document.getElementById('banner') || {}).textContent || '',
    }));
    console.log(`t=${i * 5}s`, JSON.stringify(st));
    if (errors.length) break;
  }

  console.log('错误数:', errors.length);
  errors.slice(0, 5).forEach((e, i) => console.log(` ${i + 1}. ${e.msg}\n    ${e.stack}`));

  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
