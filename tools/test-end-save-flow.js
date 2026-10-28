const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEED = {
  at: Date.now(),
  segments: [
    { seq: 1, time: '00:15', text: '今天讲搜索问题的形式化，先看初始状态和目标测试。', tr: '' },
    { seq: 2, time: '00:30', text: '状态空间可以看成一棵搜索树，每个节点是一个状态。', tr: '' },
    { seq: 3, time: '00:45', text: '深度优先搜索用栈，广度优先搜索用队列。', tr: '' },
    { seq: 4, time: '01:00', text: 'A 星搜索用 g 加 h 来排序，h 必须可采纳才保证最优。', tr: '' },
    { seq: 5, time: '01:15', text: '下面举个八数码的例子说明启发式函数怎么设计。', tr: '' },
  ],
};

(async () => {
  const b = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-first-run', '--disable-gpu', '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });
  const errors = [];
  pg.on('pageerror', (e) => errors.push({ msg: e.message, stack: (e.stack || '').split('\n').slice(0, 4).join(' | ') }));

  // 先种一份上次的记录，再进页面
  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await pg.evaluate((seed) => {
    localStorage.setItem('lecture-transcribe:lastSession', JSON.stringify(seed));
  }, SEED);
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2500);

  const restored = await pg.evaluate(() => document.querySelectorAll('#transcript .seg').length);
  console.log('恢复的段落数:', restored);

  // 开始录音（先弹课程名）
  await pg.evaluate(() => document.getElementById('btnMain').click());
  await sleep(900);
  await pg.evaluate(() => {
    const m = document.getElementById('courseModal');
    if (!m || m.classList.contains('hidden')) return;
    const input = m.querySelector('input');
    if (input) input.value = '自测结束流程';
    const go = document.getElementById('btnCourseGo');
    if (go) go.click();
  });
  await sleep(1000);
  console.log('状态:', await pg.evaluate(() => document.getElementById('btnMain').dataset.state));

  // 录 22 秒，至少产生一段静音
  await sleep(22000);
  const mid = await pg.evaluate(() => ({
    rows: document.querySelectorAll('#transcript .seg').length,
    runs: document.querySelectorAll('#transcript .silence-run').length,
    state: document.getElementById('btnMain').dataset.state,
  }));
  console.log('录音中:', JSON.stringify(mid));

  // 结束并保存
  console.log('--- 结束并保存 ---');
  await pg.evaluate(() => document.getElementById('btnMain').click());

  let sawProgress = false;
  for (let i = 1; i <= 30; i += 1) {
    await sleep(2000);
    const st = await pg.evaluate(() => {
      const gp = document.getElementById('globalProgress');
      const jobs = [...document.querySelectorAll('.job-pill, .job-card')].map((e) => e.textContent.trim().slice(0, 40));
      return {
        gpHidden: gp.classList.contains('hidden'),
        gpLabel: gp.querySelector('.gp-label').textContent,
        gpWidth: gp.querySelector('.gp-fill').style.width,
        jobs,
        banner: (document.getElementById('banner') || {}).textContent || '',
        alert: (() => { const a = document.getElementById('serverAlert'); return a.classList.contains('hidden') ? '' : document.getElementById('serverAlertText').textContent; })(),
      };
    });
    if (!st.gpHidden) sawProgress = true;
    console.log(`t+${i * 2}s gp=${st.gpHidden ? '-' : st.gpLabel || st.gpWidth} jobs=${JSON.stringify(st.jobs)} ${st.banner ? 'banner=' + st.banner.slice(0, 30) : ''}`);
    if (st.jobs.some((j) => j.includes('已经生成') || j.includes('都已生成') || j.includes('失败'))) break;
  }

  console.log('页面错误:', errors.length);
  errors.slice(0, 4).forEach((e, i) => console.log(` ${i + 1}. ${e.msg}\n    ${e.stack}`));
  console.log('进度条出现过:', sawProgress);
  console.log('结论:', errors.length === 0 && sawProgress ? '通过' : '需要复查');

  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
