const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-first-run', '--disable-gpu', '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });
  const errors = [];
  pg.on('pageerror', (e) => errors.push({ msg: e.message, stack: (e.stack || '').split('\n').slice(0, 5).join(' | ') }));

  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  await pg.evaluate(() => document.getElementById('btnMain').click());
  await sleep(900);
  await pg.evaluate(() => {
    const m = document.getElementById('courseModal');
    const input = m && m.querySelector('input');
    if (input) input.value = '自测结束保存';
    const go = document.getElementById('btnCourseGo');
    if (go) go.click();
  });

  // 录 65 秒，制造 3-4 段静音
  for (let i = 1; i <= 13; i += 1) {
    await sleep(5000);
    const st = await pg.evaluate(() => ({
      rows: document.querySelectorAll('#transcript .seg').length,
      runs: document.querySelectorAll('#transcript .silence-run').length,
      banner: (document.getElementById('banner') || {}).textContent || '',
    }));
    if (i % 3 === 0) console.log(`t=${i * 5}s`, JSON.stringify(st));
  }

  // 结束并保存
  console.log('--- 点结束 ---');
  await pg.evaluate(() => document.getElementById('btnMain').click());

  for (let i = 1; i <= 12; i += 1) {
    await sleep(3000);
    const st = await pg.evaluate(() => ({
      banner: (document.getElementById('banner') || {}).textContent || '',
      placeholder: !!document.querySelector('#transcript .empty'),
      gp: (() => { const g = document.getElementById('globalProgress'); return g.classList.contains('hidden') ? 'hidden' : (g.querySelector('.gp-label').textContent || 'shown'); })(),
      alert: (() => { const a = document.getElementById('serverAlert'); return a.classList.contains('hidden') ? '' : document.getElementById('serverAlertText').textContent; })(),
      jobs: [...document.querySelectorAll('.job-pill, .job-card')].map((e) => e.textContent.trim().slice(0, 30)),
    }));
    console.log(`t+${i * 3}s`, JSON.stringify(st));
    if (st.placeholder && (st.gp === 'hidden' || st.gp.includes('整理完成'))) break;
  }

  console.log('页面错误:', errors.length);
  errors.slice(0, 4).forEach((e, i) => console.log(` ${i + 1}. ${e.msg}\n    ${e.stack}`));

  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
