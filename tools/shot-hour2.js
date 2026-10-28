const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message.slice(0, 90)));
  await pg.goto(BASE + '/?hourtest=1&hourslow=1', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1000));

  // 切到录音视图，让小时进度可见
  await pg.evaluate(() => {
    document.querySelector('.card.stats').dataset.view = 'recording';
    window.__hourTest(0);
  });
  await new Promise((r) => setTimeout(r, 300));
  const card = await pg.$('.card.stats');
  await card.screenshot({ path: 'shots/hour-0.png' });

  // 跑到 59:59（几乎满）
  await pg.evaluate(() => window.__hourTest(3599));
  await new Promise((r) => setTimeout(r, 400));
  await card.screenshot({ path: 'shots/hour-1-full.png' });

  // 触发满格，逐帧看飞行
  await pg.evaluate(() => window.__hourTest(3601));
  const marks = [200, 900, 1500, 2300];
  let prev = 0;
  let idx = 0;
  for (const t of marks) {
    await new Promise((r) => setTimeout(r, t - prev));
    prev = t;
    const alive = await pg.evaluate(() => { const c = document.querySelector('.hour-chip-fly'); if (!c) return null; const r = c.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; });
    await pg.screenshot({ path: 'shots/hour-2-fly' + idx + '.png' });
    console.log(`t=${t}ms chip=${alive}`);
    idx += 1;
  }

  console.log('errors:', errs.slice(0, 3));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
