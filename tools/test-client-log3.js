const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = path.join(__dirname, '..', 'logs', 'client.log');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  // 直接派发一个 unhandledrejection 事件，验证监听器接线
  const dispatched = await pg.evaluate(() => {
    try {
      const ev = new PromiseRejectionEvent('unhandledrejection', {
        promise: Promise.reject(new Error('x')).catch(() => {}),
        reason: new Error('自测：派发的 rejection'),
      });
      window.dispatchEvent(ev);
      return 'dispatched';
    } catch (e) {
      return 'fail:' + e.message;
    }
  });
  await sleep(1200);

  const text = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf-8') : '';
  const ok = text.includes('自测：派发的 rejection');
  console.log('派发结果:', dispatched);
  console.log('rejection 监听器写入日志:', ok ? '✓' : '✗');
  if (ok) {
    const tail = text.trim().split('\n').slice(-4);
    tail.forEach((l) => console.log('  ' + l));
  }
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
