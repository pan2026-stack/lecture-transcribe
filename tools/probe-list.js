const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));
  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  await new Promise((r) => setTimeout(r, 1800));

  const info = await pg.evaluate(() => {
    const acts = [...document.querySelectorAll('#histList .row-act')];
    return { count: acts.length, sample: acts.slice(0, 3).map((a) => a.textContent.trim()) };
  });
  console.log('列表里的重新整理按钮:', JSON.stringify(info));

  const el = await pg.$('#histList');
  if (el) await el.screenshot({ path: 'shots/list-regen.png' });
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
