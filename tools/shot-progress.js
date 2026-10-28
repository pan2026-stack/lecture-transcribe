const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message.slice(0, 80)));
  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await sleep(2200);

  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });

  let rows = 0;
  for (let i = 0; i < 20; i += 1) {
    await sleep(600);
    rows = await pg.evaluate(() => document.querySelectorAll('#histList .file-row').length);
    if (rows > 0) break;
  }
  console.log('列表行数:', rows);

  const started = await pg.evaluate(() => {
    const all = [...document.querySelectorAll('#histList .file-row')];
    const withAct = all.filter((r) => r.querySelector('.row-act'));
    if (!withAct.length) return 'no-act';
    withAct[withAct.length - 1].querySelector('.row-act').click();
    return 'clicked';
  });
  console.log('点重新整理:', started);

  let shot = 0;
  for (let i = 1; i <= 45; i += 1) {
    await sleep(1000);
    const st = await pg.evaluate(() => {
      const gp = document.getElementById('globalProgress');
      return {
        hidden: gp.classList.contains('hidden'),
        indet: gp.classList.contains('indeterminate'),
        width: gp.querySelector('.gp-fill').style.width,
        label: gp.querySelector('.gp-label').textContent,
      };
    });
    if (!st.hidden) {
      console.log(`t=${i}s ${st.indet ? '不确定' : st.width} | ${st.label}`);
      if (shot === 0 && i >= 2) {
        await pg.screenshot({ path: 'shots/progress-indet.png', clip: { x: 0, y: 0, width: 1440, height: 34 } });
        shot = 1;
      }
      if (shot === 1 && !st.indet) {
        await pg.screenshot({ path: 'shots/progress-pct.png', clip: { x: 0, y: 0, width: 1440, height: 34 } });
        shot = 2;
      }
    } else if (i > 3) {
      console.log(`t=${i}s 结束（label=${st.label || '空'}）`);
      break;
    }
  }
  console.log('错误:', errs.slice(0, 3));
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
