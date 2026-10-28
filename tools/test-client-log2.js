const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOG = path.join(__dirname, '..', 'logs', 'client.log');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message.slice(0, 80)));
  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  // 确定性触发：直接调用上报函数
  const called = await pg.evaluate(() => {
    if (typeof window.__errTest !== 'function') return 'no-hook';
    window.__errTest('自测：前端异常上报');
    return 'called';
  });
  await sleep(1500);

  // 再触发一个未处理的 Promise 拒绝
  await pg.evaluate(() => { Promise.reject(new Error('自测：未处理 Promise')); });
  await sleep(1500);

  const text = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf-8') : '';
  const tail = text.trim().split('\n').slice(-6);
  console.log('钩子调用:', called);
  console.log('日志尾部:');
  tail.forEach((l) => console.log('  ' + l));

  const okHook = text.includes('自测：前端异常上报');
  const okReject = text.includes('自测：未处理 Promise');
  console.log('手动上报写入:', okHook ? '✓' : '✗');
  console.log('未处理 Promise 捕获:', okReject ? '✓' : '✗');
  console.log('页面错误:', errs.slice(0, 2));

  await b.close();
  process.exit(okHook ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
