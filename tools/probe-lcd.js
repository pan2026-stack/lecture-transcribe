const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe';
(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run','--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });
  await pg.goto('http://127.0.0.1:8795/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));
  const d = await pg.evaluate(() => {
    const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height); };
    const cs = getComputedStyle(document.querySelector('.kpi-big'));
    return { kpiBig: r('.kpi-big'), box: r('#lcdBox'), svg: r('#lcdBox svg'), pad: cs.padding, height: cs.height, lineHeight: cs.lineHeight };
  });
  console.log(JSON.stringify(d));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
