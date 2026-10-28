const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message.slice(0, 90)));
  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));

  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  const firstBefore = await pg.evaluate(() => {
    const r = document.querySelector('#histList .file-row');
    return r ? r.textContent.trim().slice(0, 60) : '';
  });

  // 选最短的转写稿（行里时间最新且是转写稿）点重新整理
  const clicked = await pg.evaluate(() => {
    const abs = [...document.querySelectorAll('#histList .row-act')];
    if (!abs.length) return 'no-act';
    abs[abs.length - 1].click();
    return 'clicked';
  });
  console.log('点击:', clicked, '| 之前第一行:', firstBefore);

  // 留在原页面，每 4 秒看一次列表
  for (let i = 1; i <= 22; i += 1) {
    await new Promise((r) => setTimeout(r, 4000));
    const st = await pg.evaluate(() => {
      const rows = document.querySelectorAll('#histList .file-row').length;
      const first = document.querySelector('#histList .file-row');
      const btn = document.querySelector('.jp-doc-actions button');
      return {
        rows,
        first: first ? first.textContent.trim().slice(0, 46) : '',
        btn: btn ? btn.textContent.trim().slice(0, 20) : '',
      };
    });
    console.log(`t=${i * 4}s rows=${st.rows} btn=${st.btn} 第一行=${st.first}`);
    if (st.btn && st.btn.indexOf('重新整理') === -1 && st.btn.indexOf('整理') === -1) break;
  }
  console.log('errors:', errs.slice(0, 3));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
