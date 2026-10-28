// 视觉检查：用本机 Edge 打开页面，跑页面里的 runQa()，输出报告 + 截图
// 用法: node qa.js http://127.0.0.1:8787 [出图目录]
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const EDGE = process.env.EDGE_PATH
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const url = process.argv[2];
const outDir = process.argv[3] || path.join(process.cwd(), 'shots');
if (!url) {
  console.error('用法: node qa.js <url> [出图目录]');
  process.exit(2);
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, dsf: 1 },
  { name: 'narrow', width: 1120, height: 780, dsf: 1 },
];

(async () => {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-first-run', '--disable-gpu', '--hide-scrollbars'],
  });

  let failed = 0;
  const report = [];

  for (const vp of VIEWPORTS) {
    const page = await browser.newPage();
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.dsf });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 120)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2200));

    const data = await page.evaluate(() => (typeof runQa === 'function' ? runQa() : null));
    const shot = path.join(outDir, `qa-${vp.name}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    await page.close();

    report.push({ viewport: `${vp.width}×${vp.height}`, shot, errors, data });
  }

  await browser.close();

  let bad = 0;
  for (const r of report) {
    console.log(`\n=== ${r.viewport}  ${path.basename(r.shot)} ===`);
    if (r.errors.length) {
      console.log('  脚本错误:');
      r.errors.forEach((e) => console.log('   ✗ ' + e));
      bad++;
    }
    if (!r.data) {
      console.log('  ✗ 页面没有 runQa()，无法检查');
      bad++;
      continue;
    }
    for (const c of r.data.checks) {
      console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}  ${c.detail}`);
      if (!c.ok) bad++;
    }
  }

  failed = bad > 0 ? 1 : 0;
  console.log(`\n${failed ? '✗ 有 ' + bad + ' 项不通过' : '✓ 全部通过'}`);
  process.exit(failed);
})().catch((e) => {
  console.error('检查脚本自身出错:', e.message);
  process.exit(3);
});
