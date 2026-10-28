const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1000));

  const out = await pg.evaluate(async () => {
    const el = document.getElementById('botBubble');
    el.classList.remove('hidden', 'side-left', 'side-right');
    el.classList.add('show', 'side-bottom');
    el.querySelector('#bubbleText').textContent = '这是一句测试台词，用来观察气泡形状。';
    const radii = [];
    for (let i = 0; i < 12; i += 1) {
      await new Promise((r) => setTimeout(r, 40));
      const cs = getComputedStyle(el);
      radii.push(cs.borderTopLeftRadius.replace(/\s+/g, '') + '|' + cs.transform.slice(0, 34));
    }
    return radii;
  });
  console.log('入场期间形状采样:');
  out.forEach((x, i) => console.log(' ', i * 40 + 'ms', x));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
