const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });
  const exportCalls = [];
  pg.on('response', (r) => {
    if (r.url().includes('/api/export')) exportCalls.push(r.url().split('fmt=')[1].split('&')[0] + ':' + r.status());
  });

  // 拦下载，避免真的落盘
  const client = await pg.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});

  await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));

  // 切到「处理」
  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  await new Promise((r) => setTimeout(r, 2000));

  // 打开历史里第一条
  const opened = await pg.evaluate(() => {
    const row = document.querySelector('#histList .file-row') || document.querySelector('.file-row') || document.querySelector('.hist-row');
    if (!row) return false;
    row.click();
    return true;
  });
  await new Promise((r) => setTimeout(r, 2500));

  const groupState = await pg.evaluate(() => {
    const g = document.getElementById('dlGroup');
    return {
      exists: !!g,
      visible: g ? !g.classList.contains('hidden') : false,
      buttons: g ? [...g.querySelectorAll('button')].map((x) => x.dataset.dl) : [],
    };
  });

  // 依次点三个格式
  for (const fmt of ['docx', 'pdf', 'html']) {
    await pg.evaluate((f) => {
      const btn = document.querySelector(`#dlGroup button[data-dl="${f}"]`);
      if (btn) btn.click();
    }, fmt);
    await new Promise((r) => setTimeout(r, fmt === 'pdf' ? 8000 : 1500));
  }

  console.log('打开文档:', opened);
  console.log('历史导出组:', JSON.stringify(groupState));
  console.log('导出请求:', JSON.stringify(exportCalls));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
