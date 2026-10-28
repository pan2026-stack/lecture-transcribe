const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message.slice(0, 90)));
  await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));

  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  await new Promise((r) => setTimeout(r, 1600));

  // 找「转写稿」那一行
  const opened = await pg.evaluate(() => {
    const rows = [...document.querySelectorAll('#histList .file-row')];
    const t = rows.find((r) => (r.textContent || '').includes('转写稿'));
    if (!t) return null;
    t.click();
    return t.textContent.trim().slice(0, 40);
  });
  await new Promise((r) => setTimeout(r, 2200));

  const state = await pg.evaluate(() => {
    const btn = document.getElementById('btnRegenNotes');
    const modal = document.querySelector('.modal:not(.hidden)');
    return {
      opened: !!modal,
      btnExists: !!btn,
      btnVisible: btn ? !btn.classList.contains('hidden') : false,
      btnText: btn ? btn.textContent.trim() : '',
      title: (document.getElementById('historyTitle') || {}).textContent,
    };
  });
  console.log('打开的行:', opened);
  console.log('状态:', JSON.stringify(state, null, 1));

  // 截图看按钮位置
  const head = await pg.$('.modal:not(.hidden) .notes-head');
  if (head) await head.screenshot({ path: 'shots/regen-head.png' });
  console.log('errors:', errs.slice(0, 3));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
