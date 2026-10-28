const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });
  const histCalls = [];
  pg.on('request', (r) => { if (r.url().includes('/api/history')) histCalls.push(Date.now()); });

  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1500));

  // 切到处理页，记下切换时的请求数
  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  const afterSwitch = histCalls.length;

  // 触发窗口 focus，应当再拉一次 history
  await pg.evaluate(() => window.dispatchEvent(new Event('focus')));
  await new Promise((r) => setTimeout(r, 1200));
  const afterFocus = histCalls.length;

  // 在记录页触发 focus，不应该多拉（只有处理页才刷）
  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('记录'));
    if (hit) hit.click();
  });
  await new Promise((r) => setTimeout(r, 800));
  const beforeLogFocus = histCalls.length;
  await pg.evaluate(() => window.dispatchEvent(new Event('focus')));
  await new Promise((r) => setTimeout(r, 1000));

  console.log('切到处理页请求数:', afterSwitch);
  console.log('处理页 focus 后:', afterFocus, afterFocus > afterSwitch ? '✓ 会刷新' : '✗ 没刷新');
  console.log('记录页 focus 后:', histCalls.length, histCalls.length === beforeLogFocus ? '✓ 不多余' : '✗ 多拉了');
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
