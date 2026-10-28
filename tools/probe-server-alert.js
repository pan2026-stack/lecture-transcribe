const puppeteer = require('puppeteer-core');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const { execSync } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await pg.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  const read = () => pg.evaluate(() => {
    const gp = document.getElementById('globalProgress');
    const al = document.getElementById('serverAlert');
    return {
      gpHidden: gp.classList.contains('hidden'),
      gpWidth: gp.querySelector('.gp-fill').style.width,
      gpLabel: gp.querySelector('.gp-label').textContent,
      alertHidden: al.classList.contains('hidden'),
      alertText: document.getElementById('serverAlertText').textContent,
      alertClass: al.className,
    };
  });

  console.log('初始:', JSON.stringify(await read()));

  // 杀掉服务，观察「重启中」提示
  const pid = execSync('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 8787 -State Listen).OwningProcess"')
    .toString().trim().split(/\s+/)[0];
  console.log('杀掉服务 PID:', pid);
  execSync(`taskkill /PID ${pid} /F`);
  await sleep(6000);
  const down = await read();
  console.log('断开 6 秒:', JSON.stringify(down));
  await pg.screenshot({ path: 'shots/server-down.png', clip: { x: 420, y: 0, width: 600, height: 70 } });

  // 等守护拉起
  let up = null;
  for (let i = 0; i < 20; i += 1) {
    await sleep(2000);
    up = await read();
    if (up.alertHidden || up.alertClass.includes('recovered')) break;
  }
  console.log('恢复后:', JSON.stringify(up));
  await pg.screenshot({ path: 'shots/server-recovered.png', clip: { x: 420, y: 0, width: 600, height: 70 } });

  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
