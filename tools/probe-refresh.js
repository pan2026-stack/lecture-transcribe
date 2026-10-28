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

  // 切到处理页
  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  const before = await pg.evaluate(() => document.querySelectorAll('#histList .file-row').length);

  // 在页面里造一个新文件（模拟生成完成），然后触发 updateJob 的收尾分支
  const after = await pg.evaluate(async () => {
    // 直接调用内部的自动刷新：改 currentView 不可行，这里观察 5 秒轮询
    return new Promise((resolve) => {
      setTimeout(() => resolve(document.querySelectorAll('#histList .file-row').length), 6000);
    });
  });

  console.log('行数 before:', before, 'after:', after);
  console.log('errors:', errs.slice(0, 3));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
