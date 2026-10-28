const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://127.0.0.1:8787/?stats=rec', { waitUntil: 'networkidle2' });

  for (const wait of [600, 900, 900]) {
    await new Promise((r) => setTimeout(r, wait));
    const vals = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('#kpiGrid .kpi')];
      const btn = document.getElementById('btnMain').getBoundingClientRect();
      const card = document.querySelector('.card.stats').getBoundingClientRect();
      return {
        cells: cells.map((c) => c.querySelector('span').textContent + '=' + c.querySelector('b').textContent),
        rightGap: Math.round(card.right - btn.right),
        view: document.querySelector('.card.stats').dataset.view,
      };
    });
    console.log(JSON.stringify(vals));
  }
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
