const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });
  await pg.goto(BASE + '/?hourtest=1', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1000));

  const trajectory = await pg.evaluate(async () => {
    document.querySelector('.card.stats').dataset.view = 'recording';
    window.__hourTest(3599);
    await new Promise((r) => setTimeout(r, 120));
    window.__hourTest(3601);
    const samples = [];
    for (let i = 0; i < 16; i += 1) {
      const c = document.querySelector('.hour-chip-fly');
      if (c) {
        const r = c.getBoundingClientRect();
        samples.push([Math.round(r.left), Math.round(r.top), Math.round(r.width)]);
      } else {
        samples.push(null);
      }
      await new Promise((r) => setTimeout(r, 45));
    }
    const sq = document.querySelector('#hourSquares i');
    const sr = sq ? sq.getBoundingClientRect() : null;
    return {
      samples,
      target: sr ? [Math.round(sr.left), Math.round(sr.top), Math.round(sr.width)] : null,
      landed: sq ? sq.classList.contains('landed') : false,
      fillOpacity: getComputedStyle(document.getElementById('hourFill')).opacity,
      fillWidth: getComputedStyle(document.getElementById('hourFill')).width,
    };
  });

  console.log(JSON.stringify(trajectory, null, 1));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
