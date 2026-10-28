const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await pg.goto(BASE + '/?hourtest=1', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));
  await pg.evaluate(() => {
    document.querySelector('.card.stats').dataset.view = 'recording';
    document.getElementById('clockUnit').textContent = '';
    window.__hourTest(3 * 3600 + 20 * 60);
  });
  await new Promise((r) => setTimeout(r, 700));
  const card = await pg.$('.card.stats');
  await card.screenshot({ path: 'shots/hour-b-plan.png' });

  // 再来一次满格，看落位后的排列
  await pg.evaluate(() => window.__hourTest(4 * 3600 + 30));
  await new Promise((r) => setTimeout(r, 900));
  await card.screenshot({ path: 'shots/hour-b-landed.png' });
  console.log('ok');
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
