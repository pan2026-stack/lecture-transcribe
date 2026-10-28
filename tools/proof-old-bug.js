const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await sleep(1500);

  // 复刻「旧写法」：行已脱离文档，但 .x 仍有 parentNode
  const result = await pg.evaluate(() => {
    const wrap = document.getElementById('transcript');
    const row = document.createElement('div');
    row.className = 'seg';
    row.innerHTML = '<div class="t">00:99</div><div class="body"><div class="x pending">识别中…</div></div>';
    wrap.appendChild(row);
    row.remove();                       // 模拟「结束并保存」清空转写区

    const rowEl = row.querySelector('.x');
    const out = { oldGuardPasses: !!rowEl.parentNode, oldThrows: '', newReturns: '' };

    // 旧写法：检查 rowEl.parentNode → 通过 → seg.parentNode 为 null → 抛错
    try {
      if (rowEl && rowEl.parentNode) {
        const seg = rowEl.closest('.seg') || rowEl;
        seg.parentNode.insertBefore(document.createElement('div'), seg);
      }
      out.oldThrows = '没抛错';
    } catch (e) {
      out.oldThrows = e.constructor.name + ': ' + e.message;
    }

    // 新写法：isConnected 直接挡住
    out.newReturns = (!rowEl.isConnected) ? '跳过（安全）' : '没有跳过';
    return out;
  });

  console.log('旧守卫是否放过:', result.oldGuardPasses, '（true 就是 bug 的根源）');
  console.log('旧写法结果:', result.oldThrows);
  console.log('新写法结果:', result.newReturns);
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
