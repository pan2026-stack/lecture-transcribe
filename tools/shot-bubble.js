const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 900));

  await pg.evaluate(() => {
    const el = document.getElementById('botBubble');
    el.classList.remove('hidden', 'side-left', 'side-right');
    el.classList.add('show', 'side-bottom');
    el.querySelector('#bubbleText').textContent = '台下这么安静，我先练会儿嘴皮子。';
    el.style.left = '40px';
    el.style.top = '40px';
    el.style.whiteSpace = 'nowrap';
  });

  // 抓三帧：入场中、稳定、离场前
  await new Promise((r) => setTimeout(r, 110));
  const box = await pg.evaluate(() => {
    const el = document.getElementById('botBubble');
    const r = el.getBoundingClientRect();
    return { x: r.left - 20, y: r.top - 16, width: r.width + 40, height: r.height + 32 };
  });
  await pg.screenshot({ path: 'shots/bubble-mid.png', clip: box });

  await new Promise((r) => setTimeout(r, 500));
  await pg.screenshot({ path: 'shots/bubble-stable.png', clip: box });

  await pg.evaluate(() => {
    const el = document.getElementById('botBubble');
    el.classList.remove('show');
    el.classList.add('leaving');
  });
  await new Promise((r) => setTimeout(r, 140));
  await pg.screenshot({ path: 'shots/bubble-out.png', clip: box });

  console.log('ok');
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
