const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 800));

  const rect = await page.evaluate(() => {
    const r = document.getElementById('btnMain').getBoundingClientRect();
    return { x: r.left - 12, y: r.top - 12, width: r.width + 24, height: r.height + 24 };
  });

  for (let i = 0; i < 24; i += 1) {
    const name = 'shots/spin-g' + String(i).padStart(2, '0') + '.png';
    await page.screenshot({ path: name, clip: rect });
    await new Promise((r) => setTimeout(r, 170));
  }

  console.log('rect', JSON.stringify(rect));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
