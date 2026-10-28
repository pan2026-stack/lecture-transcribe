const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle2' });

  const out = await page.evaluate(async () => {
    // 造一段 10 秒、16k 单声道、约 320KB 的 WAV，跟真实上传体量接近
    const n = 16000 * 10;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i += 1) {
      dv.setInt16(44 + i * 2, Math.round(8000 * Math.sin(2 * Math.PI * 210 * i / 16000)), true);
    }
    const blob = new Blob([buf], { type: 'application/octet-stream' });
    const t0 = performance.now();
    try {
      const r = await fetch('/api/transcribe?lang=zh&session=probe&seq=2', { method: 'POST', body: blob });
      const text = (await r.text()).slice(0, 160);
      return { size: blob.size, status: r.status, ms: Math.round(performance.now() - t0), text };
    } catch (e) {
      return { size: blob.size, fail: e.name + ': ' + e.message, ms: Math.round(performance.now() - t0) };
    }
  });

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
