const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });

  const errors = [];
  pg.on('pageerror', (e) => errors.push({ msg: e.message, stack: (e.stack || '').split('\n').slice(0, 5).join(' | ') }));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push({ msg: 'console: ' + m.text().slice(0, 200), stack: '' }); });
  pg.on('requestfailed', (r) => { if (!r.url().includes('favicon')) errors.push({ msg: 'reqfail ' + r.url().slice(-40) + ' ' + (r.failure() || {}).errorText, stack: '' }); });

  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await sleep(3500);

  const boot = await pg.evaluate(() => ({
    hasShell: !!document.querySelector('.shell'),
    hasProgress: !!document.getElementById('globalProgress'),
    hasAlert: !!document.getElementById('serverAlert'),
    bodyChildren: [...document.body.children].map((el) => el.tagName + '#' + (el.id || '') + '.' + (el.className || '').split(' ')[0]).slice(0, 8),
    banner: (document.getElementById('banner') || {}).textContent || '',
  }));
  console.log('启动状态:', JSON.stringify(boot, null, 1));

  // 切到处理页，看列表是否渲染
  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  await sleep(3000);
  const jobs = await pg.evaluate(() => ({
    rows: document.querySelectorAll('#histList .file-row').length,
    jpMain: !!document.getElementById('jpMain'),
    banner: (document.getElementById('banner') || {}).textContent || '',
    html: (document.getElementById('histList') || {}).innerHTML ? 'has-html' : 'empty',
  }));
  console.log('处理页:', JSON.stringify(jobs));

  console.log('错误数:', errors.length);
  errors.slice(0, 6).forEach((e, i) => console.log(` ${i + 1}. ${e.msg}\n    ${e.stack}`));
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
