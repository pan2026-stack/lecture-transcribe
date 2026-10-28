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
  pg.on('pageerror', (e) => errors.push({ msg: e.message, stack: (e.stack || '').split('\n').slice(0, 4).join(' | ') }));

  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await sleep(2200);

  await pg.evaluate(() => document.getElementById('btnMain').click());
  await sleep(800);
  await pg.evaluate(() => {
    const m = document.getElementById('courseModal');
    if (!m || m.classList.contains('hidden')) return;
    const input = m.querySelector('input');
    if (input) input.value = '自测飞行中结束';
    const go = document.getElementById('btnCourseGo');
    if (go) go.click();
  });

  // 等到第一段音频正在上传的瞬间（每 15 秒切一段），立刻点结束
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const pending = await pg.evaluate(() => document.querySelectorAll('#transcript .x.pending').length);
    if (pending > 0) {
      console.log(`t=${(i + 1) * 0.5}s 有 ${pending} 段正在上传，立刻点结束`);
      await pg.evaluate(() => document.getElementById('btnMain').click());
      break;
    }
  }

  for (let i = 1; i <= 10; i += 1) {
    await sleep(1500);
    const st = await pg.evaluate(() => ({
      banner: (document.getElementById('banner') || {}).textContent || '',
      rows: document.querySelectorAll('#transcript .seg').length,
      placeholder: !!document.querySelector('#transcript .empty'),
      jobs: [...document.querySelectorAll('.job-pill, .job-card')].map((e) => e.textContent.trim().slice(0, 34)),
    }));
    console.log(`t+${i * 1.5}s`, JSON.stringify(st));
  }

  console.log('页面错误:', errors.length);
  errors.slice(0, 4).forEach((e, i) => console.log(` ${i + 1}. ${e.msg}\n    ${e.stack}`));
  const bad = errors.some((e) => e.msg.includes('insertBefore'));
  console.log(bad ? '仍然复现 insertBefore 错误' : '没有 insertBefore 错误 ✓');

  await b.close();
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
