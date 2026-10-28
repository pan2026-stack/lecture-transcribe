// Run with NODE_PATH pointing at an external puppeteer-core installation.
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const BASE = process.argv[2] || 'http://127.0.0.1:8894';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.EDGE_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-first-run', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.evaluateOnNewDocument(() => {
      const original = window.fetch.bind(window);
      window.__networkTest = { offline: false, loseAck: true, submissions: [], singlePingFailure: false, holdSave: true, saveHeld: false };
      window.fetch = async (input, options) => {
        const url = String(input);
        const state = window.__networkTest;
        if (url.includes('/api/ping') && state.singlePingFailure) {
          state.singlePingFailure = false;
          throw new TypeError('simulated one-off ping loss');
        }
        if (state.offline && (url.includes('/api/ping') || url.includes('/api/notes-progress'))) {
          throw new TypeError('simulated local transport disconnect');
        }
        const response = await original(input, options);
        if (url === '/api/save' && state.holdSave) {
          state.holdSave = false;
          state.saveHeld = true;
          await new Promise((resolve) => setTimeout(resolve, 3000));
          state.saveHeld = false;
        }
        if (url === '/api/notes' && options?.method === 'POST') {
          state.submissions.push(JSON.parse(options.body).job);
          if (state.loseAck) {
            state.loseAck = false;
            throw new TypeError('simulated lost acceptance response');
          }
        }
        return response;
      };
    });
    const jobs = () => page.evaluate(() => JSON.parse(localStorage.getItem('lecture-transcribe:jobs') || '[]'));
    const state = () => page.evaluate(async () => (await fetch('/__test/state')).json());
    const waitDone = () => page.waitForFunction(() => {
      const list = JSON.parse(localStorage.getItem('lecture-transcribe:jobs') || '[]');
      return list[0]?.status === 'done';
    }, { timeout: 40000 });

    await page.goto(BASE + '/?selftest=stop', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__networkTest.saveHeld, { timeout: 10000 });
    assert.ok(await page.evaluate(() => localStorage.getItem('lecture-transcribe:lastSession')),
              'recovery transcript must survive until save acknowledgement');
    console.log('PASS stop preserves recovery transcript until save is acknowledged');
    await page.waitForFunction(() => window.__networkTest.submissions.length >= 2, { timeout: 12000 });
    let submitted = await page.evaluate(() => window.__networkTest.submissions);
    assert.equal(new Set(submitted).size, 1, 'lost acceptance must reuse the same job ID');
    assert.equal((await state()).calls, 1, 'lost response must not repeat upstream generation');
    await page.evaluate(() => { window.__networkTest.offline = true; });
    await page.waitForFunction(() => !document.getElementById('serverAlert').classList.contains('hidden'),
                               { timeout: 15000 });
    assert.equal((await jobs())[0].status, 'running');
    await page.evaluate(() => { window.__networkTest.offline = false; });
    await waitDone();
    await page.waitForFunction(() => {
      const alert = document.getElementById('serverAlert');
      return alert.classList.contains('hidden') || alert.classList.contains('recovered');
    }, { timeout: 10000 });
    assert.equal((await state()).calls, 1);
    console.log('PASS automatic stop → lost acceptance → disconnect → recover without refresh; one generation');

    await page.evaluate(() => localStorage.removeItem('lecture-transcribe:jobs'));
    await page.goto(BASE + '/?selftest=stop', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__networkTest.submissions.length >= 1, { timeout: 10000 });
    const taskId = (await jobs())[0].serverJob;
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await waitDone();
    assert.equal((await jobs())[0].serverJob, taskId, 'refresh must attach to the original task');
    assert.equal((await state()).calls, 2, 'refresh must not submit a new generation');
    console.log('PASS refresh during generation → original task completes; no duplicate submission');

    await page.evaluate(() => { window.__networkTest.singlePingFailure = true; });
    await delay(6500);
    assert.ok(await page.evaluate(() => document.getElementById('serverAlert').classList.contains('hidden')),
              'one ping failure must not declare the server disconnected');
    console.log('PASS one lost ping does not produce a false disconnect');

    await page.evaluate(async () => { await fetch('/__test/fail'); localStorage.removeItem('lecture-transcribe:jobs'); });
    await page.goto(BASE + '/?selftest=stop', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const list = JSON.parse(localStorage.getItem('lecture-transcribe:jobs') || '[]');
      return list[0]?.status === 'error';
    }, { timeout: 10000 });
    assert.equal((await state()).calls, 3, 'provider rejection must not repeat generation');
    assert.ok(await page.evaluate(() => document.getElementById('serverAlert').classList.contains('hidden')));
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS provider error → visible task failure, no false disconnect, no automatic duplicate call');
    console.log('PASS zero uncaught browser errors');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
