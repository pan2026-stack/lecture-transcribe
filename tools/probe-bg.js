const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe';
(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run','--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });
  await pg.goto('http://127.0.0.1:8795/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));
  const out = await pg.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return sel + ': 无';
      const cs = getComputedStyle(el);
      return sel + ' bg=' + cs.backgroundColor + ' img=' + (cs.backgroundImage || '').slice(0, 40) + ' shadow=' + cs.boxShadow.slice(0, 46);
    };
    return ['.left', '.transcript-wrap', '.transcript', '.toolbar', '.stage', '.cols'].map(pick);
  });
  out.forEach((l) => console.log(l));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
