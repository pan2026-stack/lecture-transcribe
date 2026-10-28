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

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1200));

  // 点开始
  await page.click('#btnMain');
  await new Promise((r) => setTimeout(r, 700));

  // 有课程名弹窗就填
  const hasModal = await page.evaluate(() => {
    const m = document.getElementById('courseModal');
    return m && !m.classList.contains('hidden');
  });
  if (hasModal) {
    await page.type('#courseInput', '探针课');
    await page.click('#btnCourseGo');
  }
  await new Promise((r) => setTimeout(r, 2500));

  const state = await page.evaluate(() => {
    const btn = document.getElementById('btnMain');
    const label = btn.querySelector('.bm-label');
    return {
      dataState: btn.dataset.state,
      className: btn.className,
      label: label ? label.textContent : '(无)',
      width: Math.round(btn.getBoundingClientRect().width),
      bg: getComputedStyle(btn).backgroundColor,
      cardView: (document.querySelector('.card.stats') || {}).dataset
        ? document.querySelector('.card.stats').dataset.view : '?',
      segInfo: (document.getElementById('segInfo') || {}).textContent,
      kpi: [...document.querySelectorAll('#kpiGrid .kpi')]
        .map((c) => c.querySelector('span').textContent + '=' + c.querySelector('b').textContent),
      recs: (window.segments || []).length,
    };
  });
  await page.screenshot({ path: 'shots/probe-recording.png' });
  console.log(JSON.stringify(state, null, 2));
  console.log('errors:', errors.slice(0, 6));
  await browser.close();
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
