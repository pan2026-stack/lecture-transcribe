const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message.slice(0, 90)));

  const posts = [];
  pg.on('response', (r) => {
    if (r.url().includes('/api/notes')) posts.push(r.status());
  });

  await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1000));
  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  await pg.evaluate(() => {
    const rows = [...document.querySelectorAll('#histList .file-row')];
    // 选最短的一份转写稿，减少等待
    const cands = rows.filter((r) => (r.textContent || '').includes('转写稿'));
    (cands[cands.length - 1] || cands[0]).click();
  });
  await new Promise((r) => setTimeout(r, 2000));

  const clicks = await pg.evaluate(() => {
    const btn = document.getElementById('btnRegenNotes');
    if (!btn || btn.classList.contains('hidden')) return 'no-button';
    btn.click();
    return 'clicked';
  });
  console.log('点击:', clicks);

  // 最多等 180 秒
  const start = Date.now();
  let done = false;
  while (Date.now() - start < 180000) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await pg.evaluate(() => {
      const btn = document.getElementById('btnRegenNotes');
      const banner = document.getElementById('banner');
      return {
        btn: btn ? btn.textContent.trim() : '',
        disabled: btn ? btn.disabled : null,
        banner: banner && !banner.classList.contains('hidden') ? banner.textContent.slice(0, 60) : '',
        title: (document.getElementById('historyTitle') || {}).textContent,
      };
    });
    if (st.btn === '重新生成笔记' && !st.disabled) { done = true; console.log('结束状态:', JSON.stringify(st)); break; }
    console.log('等待中…', JSON.stringify(st));
  }
  console.log('是否完成:', done, '/api/notes 状态:', posts);
  console.log('errors:', errs.slice(0, 3));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
