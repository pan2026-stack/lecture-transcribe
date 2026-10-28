const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  for (const vp of [{ w: 1440, h: 900 }, { w: 1120, h: 780 }]) {
    const pg = await b.newPage();
    await pg.setViewport({ width: vp.w, height: vp.h });
    await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 1200));
    const m = await pg.evaluate(() => {
      const card = document.querySelector('.card.stats');
      const inner = card ? card.getBoundingClientRect() : null;
      const grid = document.getElementById('kpiGrid');
      const act = document.querySelector('.card.stats .actions');
      return {
        card: inner ? Math.round(inner.width) + '×' + Math.round(inner.height) : null,
        grid: grid ? Math.round(grid.getBoundingClientRect().width) : null,
        actions: act ? Math.round(act.getBoundingClientRect().width) + '×' + Math.round(act.getBoundingClientRect().height) : null,
        clockFontSize: getComputedStyle(document.getElementById('clock')).fontSize,
        rowHeight: getComputedStyle(document.getElementById('kpiGrid')).rowGap,
      };
    });
    console.log(vp.w + 'px 视口:', JSON.stringify(m));
    await pg.close();
  }
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
