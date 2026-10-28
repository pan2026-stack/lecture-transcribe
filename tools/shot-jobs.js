const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message.slice(0, 100)));
  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));

  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  await new Promise((r) => setTimeout(r, 1600));
  await pg.screenshot({ path: 'shots/jobs-empty.png' });

  // 点开第一条「笔记」
  await pg.evaluate(() => {
    const rows = [...document.querySelectorAll('#histList .file-row')];
    const t = rows.find((r) => (r.textContent || '').includes('笔记'));
    if (t) t.click();
  });
  await new Promise((r) => setTimeout(r, 2500));
  await pg.screenshot({ path: 'shots/jobs-notes.png' });

  const st = await pg.evaluate(() => ({
    title: (document.querySelector('.jp-doc-title') || {}).textContent,
    actions: [...document.querySelectorAll('.jp-doc-actions button')].map((x) => x.textContent.trim()),
    nav: [...document.querySelectorAll('#jpRight a')].length,
    bodyLen: (document.querySelector('.jp-doc-body') || {}).textContent?.length || 0,
  }));
  console.log('笔记态:', JSON.stringify(st));

  // 点开一条转写稿
  await pg.evaluate(() => {
    const rows = [...document.querySelectorAll('#histList .file-row')];
    const t = rows.find((r) => (r.textContent || '').includes('转写稿'));
    if (t) t.click();
  });
  await new Promise((r) => setTimeout(r, 2500));
  await pg.screenshot({ path: 'shots/jobs-transcript.png' });
  const st2 = await pg.evaluate(() => ({
    title: (document.querySelector('.jp-doc-title') || {}).textContent,
    actions: [...document.querySelectorAll('.jp-doc-actions button')].map((x) => x.textContent.trim()),
    nav: [...document.querySelectorAll('#jpRight a')].length,
  }));
  console.log('转写稿态:', JSON.stringify(st2));
  console.log('errors:', errs.slice(0, 3));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
