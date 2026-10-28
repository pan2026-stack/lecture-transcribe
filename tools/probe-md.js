const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe';
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');
(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run','--disable-gpu'] });
  const pg = await b.newPage();
  await pg.goto(BASE + '/?mdtest=1', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1000));
  const out = await pg.evaluate(() => {
    const md = [
      '- 主题：测试',
      '',
      '## 章节速览',
      '- [00:14] 短时间',
      '- [1:05:52] 超过一小时的锚点',
      '- [12:45] 两位数分钟',
      '',
      '## 一、正文 [1:12:45]',
      '',
      '- **概念**（理论）：解释。',
    ].join('\n');
    const html = window.__mdTest(md);
    const div = document.createElement('div');
    div.innerHTML = html;
    const anchors = [...div.querySelectorAll('a.ts-jump')].map((a) => a.textContent);
    return { anchors, hasRaw: /\[\d:\d{2}:\d{2}\]/.test(html), sample: html.slice(0, 300) };
  });
  console.log(JSON.stringify(out, null, 1));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
