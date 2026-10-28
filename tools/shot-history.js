const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1500));

  // 切到「处理」
  const rail = await pg.evaluate(() => {
    const els = [...document.querySelectorAll('nav.rail button, nav.rail a, nav.rail [role="tab"]')];
    return els.map((e) => (e.textContent || '').trim().slice(0, 6));
  });
  console.log('侧栏项:', JSON.stringify(rail));

  await pg.evaluate(() => {
    const els = [...document.querySelectorAll('nav.rail button, nav.rail a')];
    const hit = els.find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  await new Promise((r) => setTimeout(r, 2000));

  // 点历史列表第一行
  const clicked = await pg.evaluate(() => {
    const row = document.querySelector('#histList .file-row') || document.querySelector('.file-row');
    if (!row) return false;
    row.click();
    return true;
  });
  await new Promise((r) => setTimeout(r, 2500));

  const info = await pg.evaluate(() => {
    const head = document.querySelector('.modal:not(.hidden) .notes-head') || document.querySelector('#historyModal .notes-head');
    const btns = [...document.querySelectorAll('.notes-actions button')].map((b2) => ({
      text: (b2.textContent || '').trim(),
      hidden: b2.classList.contains('hidden'),
    }));
    return {
      opened: !!document.querySelector('.modal:not(.hidden)'),
      actions: btns.filter((x) => !x.hidden),
      title: (document.querySelector('#historyTitle') || {}).textContent || '',
    };
  });
  console.log('点击列表:', clicked, '状态:', JSON.stringify(info, null, 2));

  const box = await pg.evaluate(() => {
    const m = document.querySelector('.modal:not(.hidden) .notes-head');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return { x: r.left - 8, y: r.top - 8, width: r.width + 16, height: r.height + 16 };
  });
  if (box) await pg.screenshot({ path: 'shots/history-toolbar.png', clip: box });

  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
