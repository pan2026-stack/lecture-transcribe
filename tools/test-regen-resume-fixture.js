const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8893';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message.slice(0, 90)));

  const goJobs = () => pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  const read = () => pg.evaluate(() => ({
    jobs: [...document.querySelectorAll('.job-pill, .job-card')].map((e) => e.textContent.trim().slice(0, 44)),
    gp: (() => { const g = document.getElementById('globalProgress'); return g.classList.contains('hidden') ? '' : g.querySelector('.gp-label').textContent; })(),
  }));

  await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await goJobs();
  for (let i = 0; i < 25; i += 1) {
    await sleep(500);
    if (await pg.evaluate(() => document.querySelectorAll('#histList .file-row').length > 0)) break;
  }

  const picked = await pg.evaluate(() => {
    const rows = [...document.querySelectorAll('#histList .file-row')].filter((r) => r.querySelector('.row-act'));
    if (!rows.length) return 'no-act';
    rows[0].querySelector('.row-act').click();
    return rows[0].textContent.trim().slice(0, 34);
  });
  console.log('目标（最新一条）:', picked);
  await sleep(2500);
  console.log('点击后:', JSON.stringify(await read()));

  console.log('--- 刷新页面（模拟中途手滑）---');
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await goJobs();
  await sleep(1500);
  console.log('刷新后:', JSON.stringify(await read()));

  let done = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(2000);
    const st = await read();
    if (i % 3 === 0) console.log(`t+${(i + 1) * 2}s`, JSON.stringify(st));
    if (st.jobs.some((j) => j.includes('讲稿和笔记都已生成') || j.includes('失败'))) { done = st; break; }
  }
  console.log('最终:', JSON.stringify(done));
  const ok = !!(done && done.jobs.some((j) => j.includes('讲稿和笔记都已生成')));
  console.log(ok ? '通过：刷新后接续并完成' : '失败：没有接续完成');
  console.log('页面错误:', errs.slice(0, 3));
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
