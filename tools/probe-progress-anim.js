const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });
  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  for (let i = 0; i < 20; i += 1) {
    await sleep(600);
    if (await pg.evaluate(() => document.querySelectorAll('#histList .file-row').length > 0)) break;
  }
  await pg.evaluate(() => {
    const all = [...document.querySelectorAll('#histList .file-row')];
    const withAct = all.filter((r) => r.querySelector('.row-act'));
    withAct[withAct.length - 1].querySelector('.row-act').click();
  });
  await sleep(2500);

  const frames = [];
  for (let i = 0; i < 6; i += 1) {
    await sleep(220);
    frames.push(await pg.evaluate(() => {
      const f = document.querySelector('#globalProgress .gp-fill');
      return f ? getComputedStyle(f).transform : 'no-fill';
    }));
  }
  console.log('进度条动画帧:');
  frames.forEach((f, i) => console.log(` ${i}: ${f}`));
  const moving = new Set(frames).size > 2;
  console.log('动画在动:', moving ? '✓' : '✗');
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
