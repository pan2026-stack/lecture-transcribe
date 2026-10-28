const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));

  // 版本
  const ver = await pg.evaluate(() => (document.getElementById('appVer') || {}).textContent);

  // 进「处理」
  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  await new Promise((r) => setTimeout(r, 1600));

  // 点开一条转写稿
  const clicked = await pg.evaluate(() => {
    const rows = [...document.querySelectorAll('#histList .file-row')];
    const t = rows.find((r) => (r.textContent || '').includes('转写稿'));
    if (!t) return null;
    t.click();
    return t.textContent.trim().slice(0, 46);
  });
  await new Promise((r) => setTimeout(r, 2200));

  const pos = await pg.evaluate(() => {
    const btn = document.getElementById('btnRegenNotes');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, visible: !btn.classList.contains('hidden') };
  });
  console.log('版本:', ver, '| 点开:', clicked, '| 按钮:', JSON.stringify(pos));

  await pg.screenshot({ path: 'shots/regen-where.png' });
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
