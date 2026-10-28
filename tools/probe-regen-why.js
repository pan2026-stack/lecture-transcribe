const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8787');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await pg.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1200));

  await pg.evaluate(() => {
    const hit = [...document.querySelectorAll('nav.rail button, nav.rail a')]
      .find((e) => (e.textContent || '').includes('处理'));
    if (hit) hit.click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  const chips = await pg.evaluate(() => [...document.querySelectorAll('.hist-chip')]
    .map((c) => ({ text: c.textContent.trim(), active: c.classList.contains('active') })));
  console.log('筛选芯片状态:', JSON.stringify(chips));

  async function tryOpen(label) {
    const r = await pg.evaluate((kind) => {
      document.querySelector('#historyModal').classList.add('hidden');
      const rows = [...document.querySelectorAll('#histList .file-row')];
      const hit = rows.find((x) => (x.textContent || '').includes(kind));
      if (!hit) return null;
      hit.click();
      return hit.textContent.trim().slice(0, 40);
    }, label);
    await new Promise((r2) => setTimeout(r2, 4500));
    const st = await pg.evaluate(() => {
      const btn = document.getElementById('btnRegenNotes');
      return btn ? { visible: !btn.classList.contains('hidden'), text: btn.textContent.trim() } : null;
    });
    console.log(`点开含「${label}」的行:`, r, '→ 按钮:', JSON.stringify(st));
  }

  await tryOpen('笔记');
  await tryOpen('转写稿');

  // 再试试切到「转写稿」筛选后打开
  await pg.evaluate(() => {
    const chip = [...document.querySelectorAll('.hist-chip')].find((c) => c.textContent.includes('转写稿'));
    if (chip) chip.click();
  });
  await new Promise((r) => setTimeout(r, 1200));
  const rows = await pg.evaluate(() => [...document.querySelectorAll('#histList .file-row')].length);
  console.log('切到转写稿筛选后行数:', rows);

  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
