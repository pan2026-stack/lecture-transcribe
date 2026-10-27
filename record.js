// 逐帧录制：用 Web Animations API 把动画定格到指定时刻再截图
// 用法: node record.js <mode: split|breath> <outDir>
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const mode = process.argv[2] || 'split';
const outDir = process.argv[3] || path.join(process.cwd(), 'frames');

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-first-run', '--disable-gpu', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
  const url = mode === 'split' ? 'http://127.0.0.1:8787/?morph=rec&slomo=1' : 'http://127.0.0.1:8787/';
  await page.goto(url, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1800));

  // 量出动作区位置
  const box = await page.evaluate(() => {
    const el = document.querySelector('.actions');
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.left - 18), y: Math.max(0, r.top - 18), width: r.width + 36, height: r.height + 36 };
  });

  if (mode === 'split') {
    // 回到空闲态，再触发分裂
    await page.evaluate(() => window.__demo.idle());
    await new Promise((r) => setTimeout(r, 300));
    await page.evaluate(() => window.__demo.split());
  }

  const step = mode === 'split' ? 240 : 190;
  const total = mode === 'split' ? 6000 : 3800;
  const prefix = mode === 'split' ? 's' : 'b';
  let i = 0;
  for (let t = 0; t <= total; t += step) {
    await new Promise((r) => setTimeout(r, step));
    const file = path.join(outDir, `${prefix}${String(i).padStart(3, '0')}.png`);
    await page.screenshot({ path: file, clip: box });
    i += 1;
  }

  await browser.close();
  console.log('frames:', i);
})().catch((e) => { console.error(e.message); process.exit(1); });
