const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');

(async () => {
  const b = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-first-run', '--disable-gpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message.slice(0, 90)));
  await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1500));

  await (await pg.$('.card.stats')).screenshot({ path: 'shots/card-idle.png' });

  await pg.click('#btnMain');
  await new Promise((r) => setTimeout(r, 700));
  const hasModal = await pg.evaluate(() => {
    const m = document.getElementById('courseModal');
    return m && !m.classList.contains('hidden');
  });
  if (hasModal) {
    await pg.type('#courseInput', '自检');
    await pg.click('#btnCourseGo');
  }
  await new Promise((r) => setTimeout(r, 9000));

  await (await pg.$('.card.stats')).screenshot({ path: 'shots/card-rec.png' });
  await pg.screenshot({ path: 'shots/page-rec.png' });
  console.log('errors:', errs.slice(0, 3));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
