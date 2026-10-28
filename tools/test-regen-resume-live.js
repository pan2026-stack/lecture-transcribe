const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message.slice(0, 90)));

  const goJobs = () => pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  const read = () => pg.evaluate(() => ({
    jobs: [...document.querySelectorAll('.job-pill, .job-card')].map((e) => e.textContent.trim().slice(0, 46)),
    gp: (() => { const g = document.getElementById('globalProgress'); return g.classList.contains('hidden') ? '' : g.querySelector('.gp-label').textContent; })(),
    rows: document.querySelectorAll('#histList .file-row').length,
  }));

  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await sleep(2200);
  await goJobs();
  for (let i = 0; i < 25; i += 1) {
    await sleep(500);
    if (await pg.evaluate(() => document.querySelectorAll('#histList .file-row').length > 0)) break;
  }

  const picked = await pg.evaluate(() => {
    const rows = [...document.querySelectorAll('#histList .file-row')].filter((r) => r.querySelector('.row-act'));
    if (!rows.length) return 'no-act';
    const t = rows[rows.length - 1];
    t.querySelector('.row-act').click();
    return t.textContent.trim().slice(0, 34);
  });
  console.log('目标:', picked);
  await sleep(2500);
  console.log('点击后:', JSON.stringify(await read()));

  // 刷新，验证任务接续
  console.log('--- 刷新页面 ---');
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await goJobs();
  await sleep(2000);
  console.log('刷新后立即:', JSON.stringify(await read()));

  let done = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(2000);
    const st = await read();
    if (i % 3 === 0) console.log(`t+${(i + 1) * 2}s`, JSON.stringify(st));
    if (st.jobs.some((j) => j.includes('重新整理完成') || j.includes('失败'))) { done = st; break; }
  }
  console.log('最终:', JSON.stringify(done));
  await pg.screenshot({ path: 'shots/regen-job-resume.png' });
  console.log('页面错误:', errs.slice(0, 3));
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
