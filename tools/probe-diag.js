const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message.slice(0, 90)));
  await pg.goto('http://127.0.0.1:8787/?diag=1', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 4000));

  const st = await pg.evaluate(() => {
    const kids = [...document.body.children].map((el) => ({
      tag: el.tagName, id: el.id, cls: el.className,
      pos: getComputedStyle(el).position, len: (el.textContent || '').length,
      head: (el.textContent || '').slice(0, 40).replace(/\s+/g, ' '),
    }));
    const hit = [...document.body.children].find((el) => (el.textContent || '').includes('看门狗'));
    return { found: !!hit, watchdog: window.__watchdogText || '', children: kids.filter((k) => k.pos === 'fixed' || k.len < 900).slice(-6) };
  });
  console.log('面板里有看门狗行:', st.found);
  console.log('看门狗文本:', st.watchdog);
  console.log('页面异常:', errs.slice(0, 3));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
