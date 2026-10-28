const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-first-run', '--disable-gpu', '--use-fake-ui-for-media-stream',
           '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 80)));

  const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));
  await page.click('#btnMain');
  await new Promise((r) => setTimeout(r, 600));

  const hasModal = await page.evaluate(() => {
    const m = document.getElementById('courseModal');
    return m && !m.classList.contains('hidden');
  });
  if (hasModal) {
    await page.type('#courseInput', '自检课');
    await page.click('#btnCourseGo');
  }

  // 录 26 秒，让至少两段真正走完上传
  await new Promise((r) => setTimeout(r, 26000));

  const state = await page.evaluate(() => ({
    ver: (document.getElementById('appVer') || {}).textContent,
    rows: [...document.querySelectorAll('#transcript > *')].slice(0, 6)
      .map((e) => e.textContent.trim().slice(0, 42)),
    banner: (document.getElementById('banner') || {}).textContent || '',
    segInfo: (document.getElementById('segInfo') || {}).textContent || '',
    mode: (document.getElementById('modeChip') || {}).textContent || '',
  }));
  const box = await page.evaluate(() => {
    const r = document.getElementById('transcript').getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: Math.min(320, r.height) };
  });
  await page.screenshot({ path: 'shots/silence.png', clip: box });
  console.log(JSON.stringify(state, null, 2));
  console.log('页面异常:', errs.length ? errs.slice(0, 4) : '无');
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
