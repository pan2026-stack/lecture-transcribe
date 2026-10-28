const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe';
(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run','--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await pg.goto('http://127.0.0.1:8795/?notesdemo=1', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2500));
  const box = await pg.evaluate(() => {
    const m = document.querySelector('#notesModal .notes-head');
    const r = m.getBoundingClientRect();
    return { x: r.left - 10, y: r.top - 10, width: r.width + 20, height: r.height + 20 };
  });
  await pg.screenshot({ path: 'shots/notes-toolbar.png', clip: box });
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
