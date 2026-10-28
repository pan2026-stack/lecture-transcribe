const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message.slice(0, 90)));
  await pg.goto(BASE + '/?hourtest=1', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));

  // 直接驱动小时进度，模拟刚好满两格
  const frames = [];
  await pg.evaluate(() => {
    document.querySelector('.card.stats').dataset.view = 'recording';
    window.__probe = true;
  });

  // 用真实函数：先跑到 59:59，再跳到 60:00
  const shots = ['shots/hour-a.png', 'shots/hour-b.png', 'shots/hour-c.png', 'shots/hour-d.png'];
  await pg.evaluate(() => { if (window.__hourTest) window.__hourTest(0); });
  await new Promise((r) => setTimeout(r, 200));

  await pg.evaluate(() => { if (window.__hourTest) window.__hourTest(3599); });
  await new Promise((r) => setTimeout(r, 300));
  const card = await pg.$('.card.stats');
  await card.screenshot({ path: shots[0] });

  await pg.evaluate(() => { if (window.__hourTest) window.__hourTest(3601); });
  await new Promise((r) => setTimeout(r, 180));
  await card.screenshot({ path: shots[1] });
  await new Promise((r) => setTimeout(r, 200));
  await card.screenshot({ path: shots[2] });
  await new Promise((r) => setTimeout(r, 700));
  await card.screenshot({ path: shots[3] });

  console.log('errors:', errs.slice(0, 3));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
