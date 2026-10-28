const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  const r = await pg.evaluate(async () => {
    let got = 0;
    window.addEventListener('unhandledrejection', () => { got += 1; });
    Promise.reject(new Error('reject-test'));
    await new Promise((res) => setTimeout(res, 800));
    return { got, hasOwnHandler: typeof window.__errTest === 'function' };
  });
  console.log('自己的监听器收到:', r.got, '| 页面钩子存在:', r.hasOwnHandler);
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
