const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FILE = 'file:///C:/Users/92182/Documents/deepseek-harness/default-workspace/lecture-transcribe/mockup/neumorph-full.html';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--allow-file-access-from-files'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await pg.goto(FILE, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 600));

  const stats = await pg.$('.stats');
  await stats.screenshot({ path: 'shots/mock-card.png' });

  const stage = await pg.$('.stage');
  await stage.screenshot({ path: 'shots/mock-stage.png' });

  await pg.screenshot({ path: 'shots/mock-full.png' });
  console.log('done');
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
