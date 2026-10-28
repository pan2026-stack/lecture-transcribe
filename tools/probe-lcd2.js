const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe';
(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run','--disable-gpu','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });
  await pg.goto('http://127.0.0.1:8795/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 800));
  await pg.click('#btnMain');
  await new Promise((r) => setTimeout(r, 500));
  const has = await pg.evaluate(() => { const m = document.getElementById('courseModal'); return m && !m.classList.contains('hidden'); });
  if (has) { await pg.type('#courseInput', 'x'); await pg.click('#btnCourseGo'); }
  await new Promise((r) => setTimeout(r, 7000));
  const d = await pg.evaluate(() => {
    const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    const svg = document.querySelector('#lcdBox svg');
    return {
      kpiBig: box('.kpi-big'), lcdBox: box('#lcdBox'), svg: box('#lcdBox svg'),
      svgAttr: svg ? [svg.getAttribute('width'), svg.getAttribute('height')] : null,
      svgStyle: svg ? getComputedStyle(svg).height + '/' + getComputedStyle(svg).width : null,
      lcdText: document.getElementById('lcdBox').children.length,
      clockHTML: document.getElementById('lcdBox').innerHTML.slice(0, 80),
    };
  });
  console.log(JSON.stringify(d, null, 1));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
