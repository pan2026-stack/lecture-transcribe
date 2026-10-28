const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900 });

  // 在页面脚本执行前挂一个计数器，统计振荡器有没有真的被创建
  await pg.evaluateOnNewDocument(() => {
    window.__oscCount = 0;
    window.__ctxCount = 0;
    const OrigAC = window.AudioContext || window.webkitAudioContext;
    if (OrigAC) {
      const Wrapped = function (...args) {
        window.__ctxCount += 1;
        const ctx = new OrigAC(...args);
        const origCreate = ctx.createOscillator.bind(ctx);
        ctx.createOscillator = (...a) => {
          window.__oscCount += 1;
          return origCreate(...a);
        };
        return ctx;
      };
      Wrapped.prototype = OrigAC.prototype;
      window.AudioContext = Wrapped;
      window.webkitAudioContext = Wrapped;
    }
  });

  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message.slice(0, 90)));
  await pg.goto('http://127.0.0.1:8787/?chatter=fast', { waitUntil: 'domcontentloaded' });

  // 先点一下页面，解锁音频
  await pg.mouse.click(700, 500);
  await new Promise((r) => setTimeout(r, 12000));

  const st = await pg.evaluate(() => ({
    osc: window.__oscCount,
    ctx: window.__ctxCount,
    bubbleVisible: !document.getElementById('botBubble').classList.contains('hidden'),
    text: (document.getElementById('bubbleText') || {}).textContent,
    setting: document.getElementById('optBubbleSound') ? document.getElementById('optBubbleSound').checked : null,
  }));
  console.log('AudioContext 创建次数:', st.ctx);
  console.log('振荡器创建次数:', st.osc);
  console.log('气泡可见:', st.bubbleVisible, '| 文案:', (st.text || '').slice(0, 24));
  console.log('设置开关默认值:', st.setting);
  console.log('页面异常:', errs.slice(0, 3));

  // 关掉开关后再等，计数不应再涨
  await pg.evaluate(() => {
    const box = document.getElementById('optBubbleSound');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
  });
  const before = st.osc;
  await new Promise((r) => setTimeout(r, 12000));
  const after = await pg.evaluate(() => window.__oscCount);
  console.log('关闭后新增振荡器:', after - before, after === before ? '✓ 静音生效' : '✗ 仍在响');

  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
