const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });
  const calls = [];
  pg.on('response', (r) => {
    if (r.url().includes('/api/export')) calls.push(r.url().split('fmt=')[1].split('&')[0] + ':' + r.status());
  });
  const client = await pg.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});

  await pg.goto(BASE + '/?notesdemo=1', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 2500));

  for (const id of ['btnDownloadNotes', 'btnDownloadPdf', 'btnDownloadHtml']) {
    await pg.evaluate((bid) => {
      const btn = document.getElementById(bid);
      if (btn) btn.click();
    }, id);
    await new Promise((r) => setTimeout(r, id === 'btnDownloadPdf' ? 8000 : 1600));
  }

  console.log('笔记弹窗导出请求:', JSON.stringify(calls));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
