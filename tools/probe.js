const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://127.0.0.1:8787/?stats=rec', { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 2000));
  const info = await page.evaluate(() => {
    const clock = document.getElementById('clock');
    const cs = getComputedStyle(clock);
    const big = document.querySelector('.kpi-big');
    const act = document.querySelector('.card.stats .actions');
    const btn = document.getElementById('btnMain');
    return {
      clockColor: cs.color,
      clockOpacity: cs.opacity,
      clockFontSize: cs.fontSize,
      bigBg: getComputedStyle(big).backgroundColor,
      actionsJustify: getComputedStyle(act).justifyContent,
      actionsWidth: act.getBoundingClientRect().width,
      cardWidth: document.querySelector('.card.stats').getBoundingClientRect().width,
      btnRect: btn.getBoundingClientRect(),
      cardRect: document.querySelector('.card.stats').getBoundingClientRect(),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
