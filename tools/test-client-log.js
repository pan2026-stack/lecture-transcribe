const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOG = path.join(__dirname, '..', 'logs', 'client.log');

(async () => {
  const before = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;

  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  // 1) 触发一个同步异常
  await pg.evaluate(() => {
    setTimeout(() => { throw new Error('自测：同步异常'); }, 0);
  });
  // 2) 触发一个未处理的 Promise 拒绝
  await pg.evaluate(() => {
    Promise.reject(new Error('自测：未处理的 Promise'));
  });
  await sleep(2500);

  const after = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
  console.log('日志文件增长:', after - before, '字节');
  if (after > before) {
    const text = fs.readFileSync(LOG, 'utf-8');
    const lines = text.trim().split('\n').slice(-8);
    console.log('最后几行:');
    lines.forEach((l) => console.log('  ' + l));
  }
  const ok = after > before && fs.readFileSync(LOG, 'utf-8').includes('自测：同步异常');
  console.log(ok ? '通过：异常已落盘' : '失败：没写进日志');
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
