const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1500));

  const idle = await pg.evaluate(() => {
    const meter = document.getElementById('hourMeter');
    const bars = document.getElementById('weekBars');
    const cs = getComputedStyle(meter);
    return {
      view: document.querySelector('.card.stats').dataset.view,
      hourMeter: cs.display,
      hourMeterH: Math.round(meter.getBoundingClientRect().height),
      weekBarsH: Math.round(bars.getBoundingClientRect().height),
      weekBarsHTML: bars.innerHTML.slice(0, 120),
      weekBarCount: bars.children.length,
    };
  });
  console.log('空闲态:', JSON.stringify(idle, null, 1));

  // 切到录音视图，看小时进度条是否出现
  const rec = await pg.evaluate(() => {
    document.querySelector('.card.stats').dataset.view = 'recording';
    const meter = document.getElementById('hourMeter');
    const bars = document.getElementById('weekBars');
    return {
      hourMeter: getComputedStyle(meter).display,
      hourMeterH: Math.round(meter.getBoundingClientRect().height),
      weekBarsH: Math.round(bars.getBoundingClientRect().height),
      strip: !!document.querySelector('.hour-strip'),
      squares: document.getElementById('hourSquares').children.length,
    };
  });
  console.log('录音态:', JSON.stringify(rec, null, 1));

  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
