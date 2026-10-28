const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const URLS = [
  'http://127.0.0.1:8787/',
  'http://localhost:8787/',
];

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });

  for (const url of URLS) {
    const page = await browser.newPage();
    const errs = [];
    page.on('requestfailed', (r) => errs.push(`REQFAIL ${r.url().slice(0, 60)} :: ${r.failure() && r.failure().errorText}`));
    page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message.slice(0, 80)));

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    } catch (e) {
      console.log(`\n=== ${url} 打不开：${e.message.slice(0, 60)}`);
      await page.close();
      continue;
    }

    const result = await page.evaluate(async () => {
      const out = { origin: location.origin, sw: !!navigator.serviceWorker?.controller };
      const wav = new Uint8Array(2000);
      try {
        const r = await fetch('/api/transcribe?lang=zh&session=probe&seq=1', {
          method: 'POST', body: new Blob([wav], { type: 'application/octet-stream' }),
        });
        out.post = 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 80);
      } catch (e) {
        out.post = 'FAIL ' + e.name + ': ' + e.message;
      }
      try {
        const r = await fetch('/api/health');
        out.get = 'HTTP ' + r.status;
      } catch (e) {
        out.get = 'FAIL ' + e.name + ': ' + e.message;
      }
      return out;
    });

    console.log(`\n=== ${url}`);
    console.log(JSON.stringify(result, null, 2));
    if (errs.length) console.log(errs.slice(0, 4).join('\n'));
    await page.close();
  }

  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
