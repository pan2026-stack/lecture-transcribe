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
  await new Promise((r) => setTimeout(r, 1800));

  const clicked = await pg.evaluate(() => {
    const rows = [...document.querySelectorAll('#histList .file-row')];
    const hit = rows.find((r) => (r.textContent || '').includes('哈佛公开课AI'));
    if (!hit) return rows.length;
    hit.click();
    return true;
  });
  console.log('点击结果:', clicked);
  await new Promise((r) => setTimeout(r, 2500));

  const state = await pg.evaluate(() => {
    const panel = document.querySelector('.modal:not(.hidden)');
    const html = panel ? panel.innerHTML : '';
    const anchors = [...(panel ? panel.querySelectorAll('a.ts-jump') : [])].map((a) => a.textContent);
    const navLinks = [...(panel ? panel.querySelectorAll('.notes-nav a, #notesNav a') : [])].map((a) => a.textContent.trim().slice(0, 30));
    return {
      hasPanel: !!panel,
      anchorCount: anchors.length,
      anchors: anchors.slice(0, 10),
      longAnchors: anchors.filter((t) => t.split(':').length === 3),
      navCount: navLinks.length,
      nav: navLinks.slice(0, 12),
      rawBracket: /\[\d:\d{2}:\d{2}\]/.test(html) ? '仍有未解析的 h:mm:ss 方括号' : '全部解析',
    };
  });
  console.log(JSON.stringify(state, null, 1));
  console.log('errors:', errs.slice(0, 3));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
