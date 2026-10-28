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
  await sleep(2000);

  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  await sleep(2000);

  // 找最短的转写稿（列表里最后一条），点它的重新整理
  const picked = await pg.evaluate(() => {
    const rows = [...document.querySelectorAll('#histList .file-row')];
    const withAct = rows.filter((r) => r.querySelector('.row-act'));
    if (!withAct.length) return 'no-row(' + rows.length + ')';
    const target = withAct[withAct.length - 1];
    target.querySelector('.row-act').click();
    return target.textContent.trim().slice(0, 40);
  });
  console.log('目标:', picked);

  let shot = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    const st = await pg.evaluate(() => {
      const gp = document.getElementById('globalProgress');
      return {
        hidden: gp.classList.contains('hidden'),
        indet: gp.classList.contains('indeterminate'),
        width: gp.querySelector('.gp-fill').style.width,
        label: gp.querySelector('.gp-label').textContent,
        banner: (document.getElementById('banner') || {}).textContent || '',
      };
    });
    if (!st.hidden && st.width) {
      console.log(`t=${i + 1}s 进度 ${st.width} | ${st.label}`);
      if (!shot && parseInt(st.width, 10) >= 15) {
        await pg.screenshot({ path: 'shots/progress-bar.png', clip: { x: 0, y: 0, width: 1440, height: 46 } });
        shot = true;
      }
    } else if (st.label === '整理完成' || (st.hidden && i > 5)) {
      console.log(`t=${i + 1}s 收尾 | label=${st.label} hidden=${st.hidden}`);
      if (i > 5) break;
    }
  }
  console.log('错误:', errs.slice(0, 3));
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
