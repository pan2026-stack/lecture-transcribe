const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe';
(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run','--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1120, height: 780, deviceScaleFactor: 2 });
  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));
  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')].find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  await pg.evaluate(() => {
    const rows = [...document.querySelectorAll('#histList .file-row')];
    const t = rows.find((r) => (r.textContent || '').includes('笔记'));
    if (t) t.click();
  });
  await new Promise((r) => setTimeout(r, 2200));
  await pg.screenshot({ path: 'shots/jobs-narrow.png' });
  const m = await pg.evaluate(() => ({
    left: Math.round(document.querySelector('.jp-left').getBoundingClientRect().width),
    main: Math.round(document.querySelector('.jp-main').getBoundingClientRect().width),
    right: document.querySelector('.jp-right') ? Math.round(document.querySelector('.jp-right').getBoundingClientRect().width) : 0,
  }));
  console.log('窄屏列宽:', JSON.stringify(m));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
