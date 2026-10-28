const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe';
(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run','--allow-file-access-from-files'] });
  const pg = await b.newPage();
  pg.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  pg.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
  await pg.goto('file:///C:/Users/92182/Documents/deepseek-harness/default-workspace/lecture-transcribe/mockup/neumorph-full.html', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));
  const d = await pg.evaluate(() => ({
    lcd: document.getElementById('lcd').innerHTML.length,
    squares: document.getElementById('squares').children.length,
    wave: document.getElementById('wave').children.length,
    lcdBox: (() => { const r = document.getElementById('lcd').getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })(),
    svgBox: (() => { const g = document.querySelector('#lcd svg'); const r = g.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })(),
    screenBox: (() => { const r = document.querySelector('.screen').getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })(),
  }));
  console.log(JSON.stringify(d));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
