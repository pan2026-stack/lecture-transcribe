/* 课堂实时转写 —— 前端逻辑
   采集：AudioContext + ScriptProcessor 取 PCM，按 segment_seconds 切段
   上传：每段转 16kHz 单声道 WAV，POST /api/transcribe，服务端代理到识别接口
   展示：先占位再回填，保证时间顺序不乱 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const elDot = $('statusDot'), elClock = $('clock'), elBanner = $('banner');
  const elTranscript = $('transcript'), elEmpty = $('emptyHint');
  const elSegInfo = $('segInfo'), elSpectrum = $('spectrum');
  const btnMain = $('btnMain'), btnPause = $('btnPause');
  let mainState = 'idle';
  let lastTextAt = 0;
  let silenceTimer = null;
  const MAIN_LABEL = { idle: '开始听课', recording: '结束并保存', busy: '正在收尾…' };


  // 分裂时冒几个液体泡泡
  function spawnSplash(hostEl, count) {
    if (!hostEl) return;
    const rect = hostEl.getBoundingClientRect();
    const parent = hostEl.offsetParent || document.body;
    const prect = parent.getBoundingClientRect();
    for (let i = 0; i < count; i += 1) {
      const dot = document.createElement('span');
      dot.className = 'splash';
      const size = 4 + Math.random() * 7;
      dot.style.width = size + 'px';
      dot.style.height = size + 'px';
      dot.style.left = (rect.left - prect.left + rect.width * (0.15 + Math.random() * 0.7)) + 'px';
      dot.style.top = (rect.top - prect.top + rect.height * 0.35) + 'px';
      dot.style.setProperty('--dx', (Math.random() * 40 - 20).toFixed(0) + 'px');
      dot.style.setProperty('--dy', (-20 - Math.random() * 30).toFixed(0) + 'px');
      parent.appendChild(dot);
      setTimeout(() => dot.remove(), 760);
    }
  }

  function setMainState(state) {
    if (!btnMain) return;
    mainState = state;
    btnMain.dataset.state = state;
    btnMain.disabled = state === 'busy';
    const label = btnMain.querySelector('.bm-label');
    if (label) label.textContent = MAIN_LABEL[state] || '开始听课';
  }
  const btnCopy = $('btnCopy'), btnSettings = $('btnSettings'), btnNotes = $('btnNotes');
  const elModeChip = $('modeChip'), btnRecover = $('btnRecover'), btnBackfill = $('btnBackfill');
  const elSaved = $('savedPath'), elFoot = $('footInfo');
  const elConnAsr = $('connAsr'), elConnNotes = $('connNotes');
  const notesModal = $('notesModal'), notesBody = $('notesBody'), notesPath = $('notesPath');
  const chkFollow = $('chkFollow'), btnJumpBottom = $('btnJumpBottom');
  const tabs = Array.from(document.querySelectorAll('.tab'));
  let lastNotes = '', lastArticle = '', currentTab = 'notes';
  let lastNotesPath = '', lastArticlePath = '', historyDocPath = '';
  let docText = '', docTitle = '';
  let followTail = true, autoScrolling = false;

  const TARGET_RATE = 16000;
  const MAX_INFLIGHT = 1;   // 串行发送：并发容易触发接口限流
  const UPLOAD_TIMEOUT = 60000;
  const BACKLOG_LIMIT = 8;   // 排队超过这个数就降级，先存盘后处理
  // 静音判定改成自适应：先估出本机噪声底，再按噪声底的倍数判停顿
  const PAUSE_MS = 600;            // 停顿超过 0.6 秒才算一句话说完
  const MIN_SEGMENT_SEC = 2.0;     // 太短的片段不单独送识别

  let audioCtx = null, sourceNode = null, procNode = null, sinkNode = null, micStream = null;
  let analyser = null, freqData = null;   // 换成音量环后仍保留，避免 start() 里引用未声明变量
  let running = false, paused = false;
  let chunks = [], buffered = 0, segSeconds = 6;
  let segments = [], inflight = 0, fireQueue = [];
  let startedAt = 0, timerId = null, statsTimer = null;
  let startPending = false;   // 防止「开始听课」被连点，起两套录音与计时器
  let sessionTitle = '';      // 本节课程名，开始前填写，存稿和整理都用它
  const TITLES_KEY = 'lecture-transcribe:titles';

  const pad2 = (n) => String(n).padStart(2, '0');

  function defaultTitle() {
    const d = new Date();
    return `课堂 ${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function safeTitle(t) {
    return (t || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  }

  function recentTitles() {
    try {
      const raw = localStorage.getItem(TITLES_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, 5) : [];
    } catch (_) { return []; }
  }

  function rememberTitle(t) {
    if (!t) return;
    try {
      const list = recentTitles().filter((x) => x !== t);
      list.unshift(t);
      localStorage.setItem(TITLES_KEY, JSON.stringify(list.slice(0, 5)));
    } catch (_) {}
  }

  // 文件名预览
  function coursePreviewHtml(title) {
    const name = safeTitle(title) || defaultTitle();
    const d = new Date();
    const ymd = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
    const hm = `${pad2(d.getHours())}${pad2(d.getMinutes())}`;
    const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    return ''
      + `<div>笔记  <b>课堂笔记</b>-${name}-${date}-${hm}.md</div>`
      + `<div>讲稿  <b>课堂原文</b>-${name}-${date}-${hm}.md</div>`
      + `<div>转写稿 ${ymd}-${hm}12-${name}-转写稿.md</div>`;
  }

  // ---------- 2) 弹窗 ----------
  const START_LINES = [
    '开始录啦，我坐好了。',
    '老师开讲吧，我记着呢。',
    '开录，我上线了。',
    '话筒开啦，别管我。',
    '记笔记模式，启动。',
    '我准备好啦，开始吧。',
  ];


  const DONE_LINES = [
    '整理完啦，笔记存好了。',
    '写完啦，讲稿和笔记都好了。',
    '搞定，去知识库看看。',
    '收工，俩文件都写好了。',
    '弄完了，点开翻翻？',
  ];

  function pickDoneLine() {
    return DONE_LINES[Math.floor(Math.random() * DONE_LINES.length)];
  }

  function pickStartLine() {
    return START_LINES[Math.floor(Math.random() * START_LINES.length)];
  }

  function openCourseModal() {
    const layer = $('courseModal');
    if (!layer) { sessionTitle = defaultTitle(); start(); return; }

    const input = $('courseInput');
    const chips = $('courseChips');
    const preview = $('coursePreview');

    const recents = recentTitles();
    input.value = recents[0] || '';
    chips.innerHTML = recents.map((t) => `<button type="button" class="title-chip">${t}</button>`).join('');
    Array.from(chips.querySelectorAll('.title-chip')).forEach((btn) => {
      btn.addEventListener('click', () => {
        input.value = btn.textContent;
        preview.innerHTML = coursePreviewHtml(input.value);
        input.focus();
      });
    });

    preview.innerHTML = coursePreviewHtml(input.value);
    input.oninput = () => { preview.innerHTML = coursePreviewHtml(input.value); };

    layer.classList.remove('hidden');
    setTimeout(() => input.focus(), 30);
  }

  function closeCourseModal() {
    const layer = $('courseModal');
    if (layer) layer.classList.add('hidden');
  }

  function confirmCourse() {
    const input = $('courseInput');
    const raw = input ? input.value : '';
    const title = safeTitle(raw) || defaultTitle();
    sessionTitle = title;
    rememberTitle(title);
    closeCourseModal();

    const t = $('txTitle');
    if (t) t.textContent = title;

    start();
  }


  let recordedSec = 0;
  let lastSampleRate = 44100;
  let silenceMs = 0;
  let noiseFloor = 0.02;    // 噪声底，只会往下收敛
  let speechSeen = false;   // 这段里出现过“明显高于噪声底”的声音       // 真实录到的秒数，时长以它为准（不受后台标签页节流影响）
  let currentLang = 'zh';

  // 会话与降级状态
  let sessionId = 'S' + Date.now();
  let mode = 'live';          // live=边听边识别，deferred=只存盘，结束后统一识别
  let failStreak = 0;
  let lastRecogErr = '';   // 最近一次识别失败的原因，降级时一并显示
  let seqNo = 0;
  const stored = [];          // 已存盘待识别的片段 {seq, timeLabel, node}
  let recoverBusy = false;
  let notesReady = false;     // 配了 DeepSeek KEY 才在结束时自动整理

  const STORE_KEY = 'lecture-transcribe:lastSession';

  function persistSession() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        at: Date.now(),
        segments: segments.map((x) => ({ seq: x.seq, time: x.time, text: x.text, tr: x.tr || '' })),
        shots: shots.map((x) => ({ sec: x.sec, name: x.name })),
      }));
    } catch (_) { /* 隐私模式等情况忽略 */ }
  }

  function restoreSession() {
    setTimeout(() => { if (!running) flashEmotion('05', '02', 1800); }, 400);   // 苏醒
    let data;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return 0;
      data = JSON.parse(raw);
    } catch (_) { return 0; }
    const list = (data && data.segments) || [];
    if (Array.isArray(data && data.shots)) {
      shots = data.shots.filter((x) => x && x.name).map((x) => ({ sec: Number(x.sec) || 0, name: x.name }));
      updateCamCount();
    }
    if (!list.length) return 0;

    elTranscript.innerHTML = '';
    segments = [];
    let maxSeq = 0;
    list.forEach((item) => {
      const node = addSegmentRow(item.time || '00:00');
      node.x.classList.remove('pending');
      node.x.textContent = (item.text || '').trim() || '（（空））';
      if (item.tr) {
        node.tr.classList.remove('hidden');
        node.tr.textContent = item.tr;
      }
      segments.push({
        seq: item.seq || 0, time: item.time, text: item.text || '', tr: item.tr || '',
        trEl: node.tr, translated: !!item.tr, trDir: 'restored',
      });
      maxSeq = Math.max(maxSeq, item.seq || 0);
    });
    seqNo = maxSeq;
    updateStats();
    syncNotesButton();
    const badge = $('txMode');
    if (badge) {
      badge.textContent = '上次的记录 ' + list.length + ' 段';
      badge.classList.remove('hidden');
    }
    const wrap = document.querySelector('.transcript-wrap');
    if (wrap) wrap.classList.add('restored');
    return list.length;
  }

  function clearStored() {
    try { localStorage.removeItem(STORE_KEY); } catch (_) {}
  }

  // ------------------------------------------------------------ 工具

  const fmtClock = (ms) => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
  };

  const durationMs = () => recordedSec * 1000;
  const durationText = () => fmtClock(durationMs());

  window.__lastError = '';
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason || {};
    window.__lastError = 'Promise: ' + (r.message || r) + ' @' + ((r.stack || '').split('\\n')[1] || '');
    const b = $('banner');
    if (b) {
      b.textContent = '脚本异常：' + (r.message || r);
      b.classList.remove('hidden');
    }
  });
  // 自测钩子：确定性触发一次上报
  window.__errTest = (msg) => reportClientError('qa', new Error(msg || 'qa error'), 'hook');

  window.addEventListener('error', (e) => {
    window.__lastError = (e.message || '') + ' @' + (e.lineno || '?');
    const b = $('banner');
    if (b) {
      b.textContent = '脚本出错：' + (e.message || '未知') + '（行 ' + (e.lineno || '?') + '）';
      b.classList.remove('hidden');
    }
  });

  const showBanner = (msg) => {
    elBanner.textContent = msg;
    elBanner.classList.remove('hidden');
  };
  const hideBanner = () => elBanner.classList.add('hidden');

  const setStatus = (state) => {
    elDot.className = 'dot';
    if (state === 'live') elDot.classList.add('live');
    if (state === 'paused') elDot.classList.add('paused');
  };

  // ------------------------------------------------------------ 表情球

  let ball = null;
  let toneFollow = true;      // 点小球可以暂停「跟着语气变」，工作状态仍照常
  let runToken = 0;           // 每开一节 +1；旧的收尾流程看到变化就自动退出
  const TONE_EMOTION = { '😮': '13', '🤔': '11', '😌': '19', '🙂': '02', '😴': '00' };

  let ballInited = false;

  function initBall() {
    const box = $('ball');
    if (!box || !window.EmotionBall || ballInited) return;
    ballInited = true;
    box.innerHTML = '';   // 清掉上一次失败留下的半成品，避免叠出两个球
    try {
      ball = EmotionBall.create(box, {
        emotion: '02', shape: 'blob', eyeScale: 1.45, lite: true,
      });
    } catch (err) {
      console.warn('表情球初始化失败：', err);
    }
  }


  // 短暂显示某个表情，然后回到常态
  let emotionBackTimer = null;
  function flashEmotion(id, backTo, ms) {
    setEmotion(id);
    clearTimeout(emotionBackTimer);
    if (backTo) emotionBackTimer = setTimeout(() => setEmotion(backTo), ms || 2200);
  }

  // 点小球：随机换一个表情 + 水球回弹
  const TAP_FACES = ['10', '11', '13', '14', '17', '20', '21', '03', '07', '31'];
  const FACE_NAME = {
    '10': '开心', '11': '疑惑', '13': '惊讶', '14': '害羞', '17': '慌张',
    '20': '困惑', '21': '生气', '03': '好奇', '07': '抖动唤醒', '31': '接收任务',
  };
  let tapCount = 0;
  let tapCountTimer = null;

  function tapBall() {
    const dock = $('ballDock');
    if (dock) {
      dock.classList.remove('is-tapped');
      void dock.offsetWidth;
      dock.classList.add('is-tapped');
      setTimeout(() => dock.classList.remove('is-tapped'), 500);
    }
    if (mainState === 'idle' && !running) setEmotion('07');   // 抖动唤醒
    tapCount += 1;
    clearTimeout(tapCountTimer);
    tapCountTimer = setTimeout(() => { tapCount = 0; }, 12000);
    if (tapCount >= 3) {
      setEmotion('14');                       // 害羞：被戳太多次
      elFoot.textContent = '别戳了，它害羞了。';
      clearTimeout(emotionBackTimer);
      emotionBackTimer = setTimeout(() => setEmotion(running ? '16' : '02'), 2200);
      return;
    }
    const face = TAP_FACES[Math.floor(Math.random() * TAP_FACES.length)];
    setEmotion(face);
    elFoot.textContent = `它换了个表情：${FACE_NAME[face]}。`;
    clearTimeout(emotionBackTimer);
    emotionBackTimer = setTimeout(() => setEmotion(running ? '16' : '02'), 2600);
  }

  function setEmotion(id) {
    if (!ball || !id) return;
    try { ball.setEmotion(id); } catch (_) {}
  }

  // 只有「语气」这条线受点击开关控制，录音/整理/出错这些状态不受影响
  function setToneEmotion(id) {
    if (!toneFollow) return;
    setEmotion(id);
  }

  setTimeout(() => { initBall(); initSpectrum(); initStage(); loadConfig(); }, 0);   // 尽早跑，不被后面的绑定拖累

  // ------------------------------------------------------------ 连接状态

  let connAsrOk = false, connNotesOk = false;
  let connAsrBad = false, connNotesBad = false;   // 只有 KEY 被拒才算「确定坏」

  const CONN_CACHE = 'lecture-transcribe:conn';

  function cacheConn(kind, ok) {
    try {
      const c = JSON.parse(localStorage.getItem(CONN_CACHE) || '{}');
      c[kind] = ok ? Date.now() : 0;
      localStorage.setItem(CONN_CACHE, JSON.stringify(c));
    } catch (_) {}
  }

  function cachedConn(kind) {
    try {
      const c = JSON.parse(localStorage.getItem(CONN_CACHE) || '{}');
      return (c[kind] || 0) > 0;
    } catch (_) { return false; }
  }

  function paintConn(el, state, msg) {
    if (!el) return;
    el.classList.remove('ok', 'bad', 'checking', 'unknown');
    if (state) el.classList.add(state);
  }

  const HEALTH_INTERVAL = 90000;
  let healthTimer = null;

  function startHealthPolling() {
    if (healthTimer) return;
    healthTimer = setInterval(() => {
      if (!document.hidden) checkHealth();
    }, HEALTH_INTERVAL);
    document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      setEmotion('06');                       // 休眠
    } else if (!running) {
      flashEmotion('05', '02', 1500);         // 回来先苏醒
    }
      if (!document.hidden) checkHealth();
    });
  }

  let healthChecking = false;
  async function checkHealth() {
    if (healthChecking) return;
    healthChecking = true;
    try {
      await checkHealthOnce();
    } finally {
      healthChecking = false;
    }
  }

  async function checkHealthOnce() {
    setEmotion('36');                // 联网加载
    paintConn(elConnAsr, 'checking', '正在检测硅基流动…');
    paintConn(elConnNotes, 'checking', '正在检测 DeepSeek…');

    let data;
    try {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (err) {
      // 拿不到检测结果（旧版服务、网络抖动）：沿用上次「连通过」的记忆，不判红
      const asrOk = cachedConn('asr');
      const notesOk = cachedConn('notes');
      connAsrOk = asrOk; connNotesOk = notesOk;
      connAsrBad = false; connNotesBad = false;
      paintConn(elConnAsr, asrOk ? 'ok' : '', asrOk ? '上次连接正常（本次没查成）' : '暂时查不到状态');
      paintConn(elConnNotes, notesOk ? 'ok' : '', notesOk ? '上次连接正常（本次没查成）' : '暂时查不到状态');
      applyGate();
      return;
    }

    const asr = data.asr || {};
    const notes = data.notes || {};
    connAsrOk = !!asr.ok;
    connNotesOk = !!notes.ok;
    connAsrBad = !!asr.definitive && !asr.ok;
    connNotesBad = !!notes.definitive && !notes.ok;

    if (connAsrOk) cacheConn('asr', true);
    if (connNotesOk) cacheConn('notes', true);

    paintConn(elConnAsr, connAsrOk ? 'ok' : (connAsrBad ? 'bad' : ''),
      '硅基流动 · 语音识别 — ' + (asr.msg || '未知'));
    paintConn(elConnNotes, connNotesOk ? 'ok' : (connNotesBad ? 'bad' : ''),
      'DeepSeek · 整理笔记 — ' + (notes.msg || '未知'));

    applyGate();
    startHealthPolling();
  }

  // 只有 KEY 被明确拒绝才拦；查不到状态时放行，不耽误上课
  function applyGate() {
    const blocked = connAsrBad || connNotesBad;
    if (btnMain) {
      btnMain.disabled = false;         // 永远可点：点了会告诉你为什么不能开始
      }
    if (blocked) setEmotion('20');   // 困惑：KEY 不对
    if (blocked) {
      const missing = [];
      if (connAsrBad) missing.push('硅基流动（识别）');
      if (connNotesBad) missing.push('DeepSeek（整理）');
      showBanner(`${missing.join(' 和 ')} 的 KEY 被拒绝。到「设置」核对后保存，或点右上角标签重测。`);
    } else {
      hideBanner();
    }
  }

  // 「生成笔记」常驻：有内容才可点，没内容保持禁用
  // 液晶计时：七段数码管，用 SVG 画，不依赖字体
  const SEG_MAP = {
    '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
    '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
  };
  const SEG_RECT = {
    a: [4.6, 0.8, 16.8, 4.4], b: [20, 3.6, 4.4, 15.4], c: [20, 23, 4.4, 15.4], d: [4.6, 37.2, 16.8, 4.4],
    e: [1.6, 23, 4.4, 15.4], f: [1.6, 3.6, 4.4, 15.4], g: [4.6, 19, 16.8, 4.4],
  };
  function segDigit(ch) {
    const lit = SEG_MAP[ch] || '';
    let out = '';
    Object.keys(SEG_RECT).forEach((k) => {
      const r = SEG_RECT[k];
      const on = lit.indexOf(k) >= 0;
      out += '<rect x="' + r[0] + '" y="' + r[1] + '" width="' + r[2] + '" height="' + r[3]
        + '" rx="1.8" fill="' + (on ? 'currentColor' : 'rgba(37,48,60,.07)') + '"/>';
    });
    return '<svg width="21" height="34" viewBox="0 0 26 42" style="width:21px;height:34px;display:block">'
      + out + '</svg>';
  }
  function segColon() {
    return '<svg width="7" height="34" viewBox="0 0 9 42" style="width:7px;height:34px;display:block">'
      + '<rect x="3" y="12" width="4" height="4" rx="1.2" fill="currentColor"/>'
      + '<rect x="3" y="26" width="4" height="4" rx="1.2" fill="currentColor"/></svg>';
  }

  // 小时进度：本节累计，满 60 分钟长出一格，最多 24 格
  let hourDone = 0;

  // 满格瞬间：进度条先缩成一颗小方块，再落到下方累积区
  function flyHourChip(fill, target, to) {
    const from = fill.getBoundingClientRect();
    const chip = document.createElement('div');
    chip.className = 'hour-chip-fly';
    chip.style.left = from.left + 'px';
    chip.style.top = from.top + 'px';
    chip.style.width = from.width + 'px';
    chip.style.height = from.height + 'px';
    document.body.appendChild(chip);
    void chip.offsetWidth;

    // 用 transform 做位移和缩放：不触发布局，也不会被 width 过渡干扰
    const dx = to.left - from.left;
    const dy = to.top - from.top;
    const sx = Math.max(0.04, to.width / Math.max(1, from.width));
    const sy = Math.max(0.04, to.height / Math.max(1, from.height));
    chip.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')';
    chip.style.borderRadius = '4px';

    const k = document.body.classList.contains('hourslow') ? 4 : 1;
    fill.style.opacity = '0';
    setTimeout(() => {
      target.classList.add('landed');
      chip.classList.add('fade');
      setTimeout(() => chip.remove(), 240 * k);
    }, 470 * k);
  }

  function updateHourMeter(sec) {
    const box = $('hourSquares'), fill = $('hourFill');
    const cap = $('hourText'), next = $('hourNext');
    if (!box || !fill) return;
    const hours = Math.min(24, Math.floor(sec / 3600));
    const mins = Math.floor((sec % 3600) / 60);

    if (hours > hourDone) {
      // 把这一格补上（可能一次跨多格，逐格补动画）
      for (let i = box.children.length; i < hours; i += 1) {
        const sq = document.createElement('i');
        box.appendChild(sq);
        const r = sq.getBoundingClientRect();      // 先量真实位置
        if (i === hours - 1) {
          sq.className = 'pending';                // 最后一格藏着等飞落
          flyHourChip(fill, sq, {
            left: r.left, top: r.top, width: r.width, height: r.height,
          });
        } else {
          sq.className = 'landed';                 // 跨多格时，前面的直接落位
        }
      }
      hourDone = hours;
      setTimeout(() => {
        fill.style.opacity = '1';
        fill.style.width = '0%';
      }, 520);
    } else {
      fill.style.width = ((sec % 3600) / 3600 * 100).toFixed(2) + '%';
    }

    if (cap) cap.textContent = '本小节 · ' + mins + ' 分';
    if (next) next.textContent = hours >= 24 ? '已满 24 格' : '已攒 ' + hours + ' 格 · 满 60 分再攒一格';
  }

  // 测试钩子：?hourtest=1 时可用 console 驱动小时进度
  if (location.search.indexOf('hourslow') >= 0) document.body.classList.add('hourslow');
  if (location.search.indexOf('mdtest') >= 0) {
    window.__mdTest = (txt) => mdToHtml(txt);
  }

  if (location.search.indexOf('hourtest') >= 0) {
    window.__hourTest = (sec) => updateHourMeter(sec);
  }

  function resetHourMeter() {
    hourDone = 0;
    const box = $('hourSquares'), fill = $('hourFill');
    if (box) box.innerHTML = '';
    if (fill) { fill.style.width = '0%'; fill.style.opacity = '1'; }
    const cap = $('hourText'), next = $('hourNext');
    if (cap) cap.textContent = '本小节 · 0 分';
    if (next) next.textContent = '满 60 分攒一格';
  }

  function setClockText(str) {
    const box = $('lcdBox');
    const txt = $('clockText');
    if (txt) txt.textContent = str;
    if (!box) return;
    const clean = String(str).replace(/[^0-9:]/g, '');
    if (!clean) return;
    box.innerHTML = clean.split('').map((c) => (c === ':' ? segColon() : segDigit(c))).join('');
  }

  function setPauseLabel(text) {
    if (!btnPause) return;
    btnPause.setAttribute('aria-label', text);
    const el = $('pauseText');
    if (el) el.textContent = text;
  }

  function syncNotesButton() {
    if (!btnNotes) return;
    const has = segments.some((s) => (s.text || '').trim().length > 0);
    btnNotes.disabled = !has;
    const wasReady = btnNotes.classList.contains('is-ready');
    btnNotes.classList.toggle('is-ready', has);
    // 从「还不能用」变成「能用」的瞬间，分裂一次
    if (has && !wasReady) {
      btnNotes.classList.remove('is-budding');
      void btnNotes.offsetWidth;
      btnNotes.classList.add('is-budding');
      setTimeout(() => btnNotes.classList.remove('is-budding'), 620);
    }
  }

  function setModeText(text, cls) {
    const el = $('modeChip');
    if (!el) return;
    el.className = 'mode-chip' + (cls ? ' ' + cls : '');
    el.textContent = text;
  }


  // ------------------------------------------------------------ 统计卡
  let statsData = { today: {}, week: [] };
  let statsView = 'idle';

  function fmtInt(n) {
    const v = Number(n) || 0;
    return v.toLocaleString('zh-CN');
  }

  function fmtMinutes(n) {
    const m = Math.max(0, Math.round(Number(n) || 0));
    if (m < 60) return `${m}<small>分</small>`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}<small>小时</small>${r}<small>分</small>` : `${h}<small>小时</small>`;
  }

  function paintNum(el, html) {
    if (!el) return;
    el.innerHTML = html;
    el.classList.remove('num-in');
    void el.offsetWidth;
    el.classList.add('num-in');
  }

  function renderWeekBars() {
    const box = $('weekBars');
    if (!box) return;
    if (statsView === 'recording') {   // 录音时这块整个让位，连提示也不留
      box.innerHTML = '';
      box.classList.remove('is-empty');
      return;
    }
    const week = (statsData.week || []).slice(0, 7);
    if (!week.length) { box.innerHTML = ''; return; }
    const peaks = week.map((v) => Number(v) || 0);
    if (Math.max(...peaks) === 0) {
      box.classList.add('is-empty');
      box.innerHTML = '<span class="week-empty">这周还没有记录</span>';
      return;
    }
    box.classList.remove('is-empty');
    const max = Math.max(1, ...peaks);
    const todayIdx = (new Date().getDay() + 6) % 7;
    const names = ['一', '二', '三', '四', '五', '六', '日'];
    box.innerHTML = week.map((v, i) => {
      const h = Math.max(6, Math.round((Number(v) || 0) / max * 100));
      const on = i === todayIdx ? ' class="on"' : '';
      return `<i style="height:${h}%"${on}></i>`;
    }).join('');
  }

  // 文字换值：先淡出，换完再淡入；同一元素连续调用时只保留最后一次
  function swapText(el, text, delay = 0) {
    if (!el) return;
    if (el.textContent === String(text)) return;
    clearTimeout(el._swapTimer);
    el.classList.add('is-out');
    el._swapTimer = setTimeout(() => {
      el.textContent = text;
      el.classList.remove('is-out');
      el.classList.add('is-in');
      void el.offsetWidth;
      requestAnimationFrame(() => el.classList.remove('is-in'));
    }, 140 + delay);
  }

  // 数字滚动：从当前显示值补到目标值
  function animateNum(el, to, ms = 420, delay = 0) {
    if (!el) return;
    const target = Number(to) || 0;
    const raw = (el.textContent || '').replace(/[^\d.]/g, '');
    const from = Number(raw) || 0;
    if (from === target) { el.textContent = fmtInt(target); return; }
    clearTimeout(el._numTimer);
    el._numTimer = setTimeout(() => {
      const t0 = performance.now();
      const tick = (now) => {
        const k = Math.max(0, Math.min(1, (now - t0) / ms));
        const eased = 1 - Math.pow(1 - k, 3);
        el.textContent = fmtInt(Math.round(from + (target - from) * eased));
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, delay);
  }

  function paintIdleStats() {
    const t = statsData.today || {};
    const mins = Math.max(0, Math.round(Number(t.minutes) || 0));
    setClockText(String(mins));
    const unit = $('clockUnit');
    if (unit) unit.textContent = '分';
    const txt = $('clockText');
    if (txt) txt.textContent = `${mins} 分`;
    swapText($('kpiBigLabel'), '时长');
    const grid = $('kpiGrid');
    if (!grid) return;
    const names = { sessions: '节课', segments: '段落', chars: '字数', notes: '笔记' };
    const vals = {
      sessions: fmtInt(t.sessions),
      segments: fmtInt(t.segments),
      chars: fmtInt(t.chars),
      notes: fmtInt(t.notes),
    };
    grid.querySelectorAll('.kpi').forEach((cell, i) => {
      const key = cell.dataset.key;
      cell.classList.remove('warn');
      const sp = cell.querySelector('span');
      if (sp) swapText(sp, names[key] || '', i * 40);
      const b = cell.querySelector('b');
      const t = statsData.today || {};
      const num = { sessions: t.sessions, segments: t.segments, chars: t.chars, notes: t.notes }[key];
      if (b) animateNum(b, num || 0, 420, i * 40);
    });
  }

  function paintRecordingStats() {
    const grid = $('kpiGrid');
    if (!grid) return;
    const names = ['段落', '字数', '译文', '待识别'];
    grid.querySelectorAll('.kpi').forEach((cell, i) => {
      const sp = cell.querySelector('span');
      if (sp) swapText(sp, names[i] || '', i * 40);
    });
    updateStats();
  }

  async function loadStats() {
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();
      if (data && data.today) statsData = data;
    } catch (_) { /* 保底：沿用旧数据 */ }
    renderWeekBars();
    if (statsView === 'idle') paintIdleStats();
  }

  // 兜底：让按钮形态永远跟 running 对齐，避免某个分支漏调 setMainState
  function syncMainState() {
    if (!btnMain || mainState === 'busy') return;
    if (running && mainState !== 'recording') setMainState('recording');
    else if (!running && mainState === 'recording') setMainState('idle');
  }

  // 待机的圆球：随机换一次自转速度与方向，像一颗在桌上打转的球
  let spinTimer = null;
  function spinIdleBall() {
    if (!btnMain) return;
    const dur = (4 + Math.random() * 6).toFixed(1);          // 4–10 秒转一圈
    const dir = Math.random() < 0.5 ? 'normal' : 'reverse';
    btnMain.style.setProperty('--spin-dur', dur + 's');
    btnMain.style.setProperty('--spin-dir', dir);
    clearTimeout(spinTimer);
    spinTimer = setTimeout(spinIdleBall, 8000 + Math.random() * 12000);   // 8–20 秒换一次
  }

  function setStatsView(mode) {
    statsView = mode === 'recording' ? 'recording' : 'idle';
    document.body.classList.toggle('is-idle', statsView === 'idle');
    const card = document.querySelector('.card.stats');
    if (card) card.dataset.view = statsView;
    const seg = $('segInfo');
    if (statsView === 'recording') {
      const nth = (Number((statsData.today || {}).sessions) || 0) + 1;
      swapText(seg, `正在录 · 今天第 ${nth} 节`);
      swapText($('kpiBigLabel'), '本节');
      setClockText('00:00');
      resetHourMeter();
      const unit = $('clockUnit');
      if (unit) unit.textContent = '';
      paintRecordingStats();
    } else {
      swapText(seg, '今天');
      paintIdleStats();
      loadStats();
    }
  }

  function updateStats() {
    const withText = segments.filter((s) => (s.text || '').trim());
    const chars = withText.reduce((n, s) => n + s.text.trim().length, 0);
    const translated = withText.filter((s) => s.tr).length;
    const pending = stored.length + inflight + fireQueue.length;

    if (statsView === 'recording') {
      const grid = $('kpiGrid');
      if (grid) {
        const vals = [withText.length, chars, translated, pending];
        const cells = grid.querySelectorAll('.kpi');
        cells.forEach((cell, i) => {
          const b = cell.querySelector('b');
          if (b) animateNum(b, vals[i], 260, i * 30);
          cell.classList.toggle('warn', i === 3 && pending > 0);
        });
      }
    }

    const pct = withText.length ? Math.round((translated / withText.length) * 100) : 0;
    const ringPct = $('ringPct');
    if (ringPct) ringPct.textContent = `${pct}%`;
    const arc = $('ringArc');
    if (arc) arc.style.strokeDashoffset = String(314 - (314 * pct) / 100);
  }

  // ------------------------------------------------------------ 音量环

  let ring1 = null, ring2 = null, ring3 = null;

  function initSpectrum() {          // 名字保留，实际是音量环初始化
    ring1 = $('ring1'); ring2 = $('ring2'); ring3 = $('ring3');
    resetSpectrum();
  }

  function resetSpectrum() {
    [ring1, ring2, ring3].forEach((el, i) => {
      if (!el) return;
      const base = [152, 186, 224][i];
      el.style.width = `${base}px`;
      el.style.height = `${base}px`;
      el.style.opacity = String([0.45, 0.26, 0.14][i]);
      el.style.borderWidth = i === 0 ? '1.5px' : '1px';
    });
  }

  // rms 0..1 → 环的直径/线宽/透明度
  function pulseRing(rms) {
    if (!ring1) return;
    const k = Math.min(1, Math.max(0, rms * 6));     // 课堂音量一般在 0.02~0.12
    ring1.style.width = `${96 + k * 34}px`;
    ring1.style.height = `${96 + k * 34}px`;
    ring1.style.borderWidth = `${1.5 + k * 3}px`;
    ring1.style.opacity = String(0.35 + k * 0.55);

    ring2.style.width = `${128 + k * 52}px`;
    ring2.style.height = `${128 + k * 52}px`;
    ring2.style.opacity = String(0.16 + k * 0.32);

    ring3.style.width = `${168 + k * 74}px`;
    ring3.style.height = `${168 + k * 74}px`;
    ring3.style.opacity = String(0.08 + k * 0.18);
  }

  function startSpectrum() { resetSpectrum(); }
  function stopSpectrum() { resetSpectrum(); }

  // ------------------------------------------------------------ 舞台

  const WAVE_SAMPLES = 300;        // 100ms 一个点 → 30 秒（每根柱约 1px，视觉上是连续条带）
  const waveBuf = new Array(WAVE_SAMPLES).fill(0);
  let waveCanvas = null, waveCtx = null, glowEl = null;
  let lastWaveAt = 0;

  function initStage() {
    glowEl = $('glow');
    waveCanvas = $('waveCanvas');
    if (waveCanvas) waveCtx = waveCanvas.getContext('2d');
    drawWave();
  }

  function sizeCanvas() {
    if (!waveCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = waveCanvas.clientWidth || 260;
    const h = waveCanvas.clientHeight || 64;
    if (waveCanvas.width !== Math.floor(w * dpr) || waveCanvas.height !== Math.floor(h * dpr)) {
      waveCanvas.width = Math.floor(w * dpr);
      waveCanvas.height = Math.floor(h * dpr);
      waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function drawWave() {
    if (!waveCtx) return;
    sizeCanvas();
    const w = waveCanvas.clientWidth || 260;
    const h = waveCanvas.clientHeight || 90;
    waveCtx.clearRect(0, 0, w, h);
    const mid = h / 2;
    const step = w / WAVE_SAMPLES;
    const barW = Math.max(1.4, step * 0.62);

    // 中线
    waveCtx.strokeStyle = 'rgba(255, 255, 255, .07)';
    waveCtx.lineWidth = 1;
    waveCtx.beginPath();
    waveCtx.moveTo(0, mid + .5);
    waveCtx.lineTo(w, mid + .5);
    waveCtx.stroke();

    // 柱状波形：即使安静也有 2px 底高，整条区域看起来是「仪表」
    for (let i = 0; i < WAVE_SAMPLES; i++) {
      const amp = Math.max(1.6, Math.min(1, waveBuf[i] * 7) * (mid - 4));
      const x = i * step;
      const alpha = 0.20 + Math.min(0.55, waveBuf[i] * 5);
      waveCtx.fillStyle = `rgba(31, 127, 181, ${alpha.toFixed(3)})`;
      waveCtx.fillRect(x, mid - amp, barW, amp * 2);
    }
  }

  function pushWave(rms) {
    const now = performance.now();
    if (now - lastWaveAt < 100) return;      // 10Hz 采样
    lastWaveAt = now;
    waveBuf.shift();
    waveBuf.push(rms);
    drawWave();
  }

  function pulseGlow(rms) {
    if (!glowEl) return;
    const k = Math.min(1, Math.max(0, rms * 6));
    glowEl.style.opacity = String(0.28 + k * 0.55);
    glowEl.style.width = `${190 + k * 40}px`;
    glowEl.style.height = `${190 + k * 40}px`;
  }

  function clearWave() {
    waveBuf.fill(0);
    drawWave();
    if (glowEl) glowEl.style.opacity = '.28';
  }

  // ------------------------------------------------------------ 关键词

  const KW_STOP = new Set(['这个','那个','就是','其实','然后','所以','因为','但是','这样','那样','一个','可以','没有','不是','还是','如果','已经','什么','怎么','时候','问题','东西','大家','现在','这些','那些','以及','对于','关于','通过','进行','能够','需要','应该','可能','一定','非常','比较','特别','一直','不断','我们','你们','他们','对吧','是不是','的话','一下','这种','那种']);
  let lastTagsAt = 0;

  function extractKeywords(text) {
    const clean = text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    const counts = new Map();
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= clean.length; i++) {
        const g = clean.slice(i, i + n);
        if (/^\d+$/.test(g) || KW_STOP.has(g)) continue;
        counts.set(g, (counts.get(g) || 0) + 1);
      }
    }
    const items = [...counts.entries()].filter(([w, c]) => c >= 3 && w.length >= 2);
    items.sort((a, b) => b[1] * b[0].length - a[1] * a[0].length);
    const picked = [];
    for (const entry of items) {
      if (picked.some(([pw]) => pw.includes(entry[0]) || entry[0].includes(pw))) continue;
      picked.push(entry);
      if (picked.length >= 8) break;
    }
    return picked;
  }

  async function renderTags() {
    const box = $('tags');
    if (!box) return;
    const now = performance.now();
    if (now - lastTagsAt < 3000) return;      // 3 秒最多算一次
    lastTagsAt = now;

    const text = segments.map((x) => x.text || '').join('');
    if (text.replace(/\s/g, '').length < 30) {
      box.innerHTML = '<span class="none">讲到十几句后，这里会出现本节的高频词</span>';
      return;
    }

    // 优先用服务端 jieba 分词
    try {
      const res = await fetch('/api/words', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, top: 8 }),
      });
      const data = await res.json();
      if (data.words && data.words.length) {
        box.innerHTML = data.words
          .map((x) => `<span class="kw${x.c >= 5 ? ' hot' : ''}">${x.w}</span>`)
          .join('');
        return;
      }
    } catch (_) { /* 走本地兜底 */ }

    const words = extractKeywords(text);
    box.innerHTML = words.length
      ? words.map(([w, c]) => `<span class="kw${c >= 6 ? ' hot' : ''}">${w}</span>`).join('')
      : '<span class="none">还没形成明显的高频词</span>';
  }

  // ------------------------------------------------------------ 音频处理

  function downsample(input, inRate, outRate) {
    if (outRate >= inRate) return input;
    const ratio = inRate / outRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), input.length);
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out[i] = sum / Math.max(1, end - start);
    }
    return out;
  }

  function encodeWav(samples, sampleRate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buf);
    const writeStr = (off, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);              // PCM
    view.setUint16(22, 1, true);              // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);              // block align
    view.setUint16(34, 16, true);             // bits
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  // ------------------------------------------------------------ 片段上传

  function scrollToBottom() {
    autoScrolling = true;
    elTranscript.scrollTop = elTranscript.scrollHeight;
    setTimeout(() => { autoScrolling = false; }, 80);
  }

  function setFollow(on) {
    followTail = on;
    chkFollow.checked = on;
    btnJumpBottom.classList.toggle('hidden', on);
    if (on) scrollToBottom();
  }

  elTranscript.addEventListener('scroll', () => {
    if (autoScrolling) return;
    const gap = elTranscript.scrollHeight - elTranscript.scrollTop - elTranscript.clientHeight;
    if (gap < 60 && !followTail) setFollow(true);
    else if (gap >= 60 && followTail) setFollow(false);
  });

  chkFollow.addEventListener('change', () => setFollow(chkFollow.checked));
  btnJumpBottom.addEventListener('click', () => setFollow(true));

  function addSegmentRow(time) {
    const row = document.createElement('div');
    row.className = 'seg';
    row.dataset.time = time;
    row.innerHTML = `<div class="t">${time}</div>`
      + '<div class="body"><div class="x pending">识别中…</div><div class="tr hidden"></div></div>';
    elTranscript.appendChild(row);
    if (followTail) scrollToBottom();
    return { row, x: row.querySelector('.x'), tr: row.querySelector('.tr') };
  }

  // 连续的空段落折叠成一行，稿子不被「（本段没听到内容）」刷屏
  function foldSilence(rowEl, timeLabel) {
    // 注意：不能再只判断 rowEl.parentNode。转写区被清空后，行虽然脱离了文档，
    // 但它内部的 .x 仍然有 parentNode，旧写法会在 insertBefore 上抛 TypeError，
    // 还被误报成「连不上本地服务」。这里一律用 isConnected。
    if (!rowEl || !rowEl.isConnected) return;
    const seg = rowEl.closest('.seg') || rowEl;      // 整行（含时间列）一起藏
    if (!seg || !seg.isConnected || !seg.parentNode) return;
    seg.classList.add('is-silent');

    // 往前跳过所有已折叠的静音行，找到这条静音带的开头
    let prev = seg.previousElementSibling;
    while (prev && prev.classList.contains('is-silent')) prev = prev.previousElementSibling;
    let run = (prev && prev.classList.contains('silence-run')) ? prev : null;
    if (!run) {
      run = document.createElement('div');
      run.className = 'silence-run';
      run.dataset.first = timeLabel;
      run.dataset.n = '0';
      seg.parentNode.insertBefore(run, seg);
    }
    const n = (Number(run.dataset.n) || 0) + 1;
    run.dataset.n = String(n);
    const first = run.dataset.first || timeLabel;
    const span = n === 1 ? '' : `（${first}–${timeLabel}）`;
    run.innerHTML = `<div class="t">${first}</div>`
      + `<div class="x">${n} 段静音已跳过${span}</div>`;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 从隐藏变为显示时，给一个轻微的浮现动效，不要“突然蹦出来”
  function reveal(el) {
    if (!el || !el.classList.contains('hidden')) return;
    el.classList.remove('hidden');
    el.classList.add('reveal');
    el.addEventListener('animationend', () => el.classList.remove('reveal'), { once: true });
  }

  // 带超时 + 一次重试的上传：接口偶发卡住时不会把整条流水线堵死
  async function postWav(blob, attempt = 0) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT);
    try {
      const spkUrl = `/api/transcribe?lang=${encodeURIComponent(currentLang)}`
        + `&session=${encodeURIComponent(sessionId || '')}&seq=${seqNo}`;
      const res = await fetch(spkUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({ error: '返回内容无法解析' }));
      if (attempt > 0 && res.ok && !data.error) hideBanner();   // 服务回来了，收掉断线提示
      if (!res.ok || data.error) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (err) {
      if (attempt === 0 && err.status === 429) {
        await sleep(8000);               // 被限流：退避后再试一次
        return postWav(blob, 1);
      }
      // 网络断开（多半是黑窗口被关了）：等本地服务回来，最多重试 5 次、约 15 秒
      if (!err.status) err.network = true;      // 只有网络类错误才算「连不上」，别把代码 bug 也算进去
      if (!err.status && attempt < 5) {
        setModeText(`等待本地服务 ${attempt + 1}/5`, 'warn');
        if (attempt === 0) {
          showBanner('本地服务暂时连不上，正在重试…如果桌面那个黑色窗口被关了，重新运行「课堂转写.bat」，回来会自动续上。');
        }
        await sleep(2500);
        return postWav(blob, attempt + 1);
      }
      const retryable = attempt === 0 && (
        err.name === 'AbortError' || err.status === undefined || err.status >= 500
      );
      if (retryable) {
        await sleep(1200);
        return postWav(blob, 1);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // 写文字时保住语气表情：直接 textContent= 会把 span.tone 一起冲掉
  function setRowText(rowEl, text) {
    if (!rowEl) return;
    const tone = rowEl.querySelector('.tone');
    rowEl.textContent = text;
    if (tone) rowEl.appendChild(tone);
  }

  async function uploadSegment(blob, timeLabel, node, seq, tone) {
    inflight++;
    const rowEl = node.x;
    // 转写区可能已经被清空（例如点「结束并保存」后），那时候只收数据、不碰 DOM
    const alive = () => !!(node && node.row && node.row.isConnected);
    const rec = { seq, time: timeLabel, text: '', tr: '', trEl: node.tr, translated: false };
    try {
      const data = await postWav(blob);
      const text = (data.text || '').trim();
      if (alive()) rowEl.classList.remove('pending');
      lastTextAt = Date.now();
    const plain = (text || '').trim();
    if (plain.length > 80) flashEmotion('13', null, 1500);          // 惊讶：这段特别长
    else if (/[?？]$/.test(plain)) flashEmotion('11', null, 1400);  // 疑惑：问句
    if (alive()) {
      if (text) setRowText(rowEl, text);
      else foldSilence(rowEl, timeLabel);
      maybeTagTone(rowEl, tone, text, seq);
    }
      rec.text = text;
      segments.push(rec);
      if (running && Math.random() < 0.12) flashEmotion('10', '16', 1600);
      persistSession();
      syncNotesButton();
      renderTags();
      enqueueTranslate(rec);
      failStreak = 0;
    } catch (err) {
      reportClientError('upload', err, `seq=${seq} time=${timeLabel}`);
      failStreak++;
      lastRecogErr = String(err.message || err).slice(0, 140);
      if (alive()) {
        rowEl.classList.remove('pending');
        rowEl.classList.add('error');
      }
      setEmotion('34');
      flashEmotion('17', null, 1500);   // 慌张
      if (err.name === 'AbortError') {
      setTimeout(() => setEmotion('15'), 2400);
        if (alive()) setRowText(rowEl, '识别超时：这一段没送出去');
        showBanner('有一段音频识别超过 60 秒没响应，已跳过。网络不稳时会偶发，可以继续听。');
      } else if (err.status === undefined && err.network) {
        if (alive()) setRowText(rowEl, '上传失败：连不上本地服务');
        showBanner(`连不上本地服务（页面地址 ${location.origin}，错误 ${err.name}: ${String(err.message).slice(0, 60)}）。`
          + '如果地址栏不是 http://127.0.0.1:8787，请换这个地址打开；否则重开「课堂转写.bat」后刷新页面。');
      } else if (err.status === undefined) {
        // 非网络类异常（前端 bug）：明确说是本地出错，不要误导成断网
        console.error('[segment] 处理出错', err);
        if (alive()) setRowText(rowEl, '这一段处理出错了（不是网络问题）');
        showBanner(`这一段处理出错：${String(err.message).slice(0, 80)}。其它段不受影响，可以继续。`, 9000);
      } else {
        if (alive()) setRowText(rowEl, `识别失败：${err.message}`);
        if (/(KEY|api key|令牌|认证)/i.test(err.message)) {
          showBanner('识别接口的 KEY 有问题。点右上角「设置」核对第一组 KEY 后保存。');
        }
      }
    } finally {
      inflight--;
      elSegInfo.textContent = `已转写 ${segments.length} 段`;
      updateModeChip();
      updateStats();
      syncNotesButton();
      if (followTail) scrollToBottom();
      pump();
      if (running) {
        if (fireQueue.length >= BACKLOG_LIMIT) degrade(`排队 ${fireQueue.length} 段`);
        else if (failStreak >= 3) { setEmotion('21'); degrade(`连续失败 ${failStreak} 次`); }
      }
    }
  }

  // ------------------------------------------------------------ 语气

  // 从这段音频里读语气：音量峰值=强调，尾音上扬=疑问，尾部渐弱=收尾，起伏大=轻快
  function toneTag(pcm, rate = TARGET_RATE) {
    const frame = Math.floor(rate * 0.02);   // 20ms 一帧
    if (pcm.length < frame * 8) return null;
    const energies = [];
    for (let i = 0; i + frame <= pcm.length; i += frame) {
      let sum = 0;
      for (let j = i; j < i + frame; j++) sum += pcm[j] * pcm[j];
      energies.push(Math.sqrt(sum / frame));
    }
    if (energies.length < 8) return null;

    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const mean = avg(energies);
    if (mean < 0.008) return { emoji: '😴', why: '这段基本没声音', calm: true };
    // 用 95 分位而不是最大值：单个 20ms 毛刺不该被当成强调
    const sortedE = [...energies].sort((a, b) => a - b);
    const peak = sortedE[Math.floor((sortedE.length - 1) * 0.95)];
    const strongFrames = energies.filter((e) => e > mean * 2.8).length;
    const third = Math.max(1, Math.floor(energies.length / 3));
    const head = avg(energies.slice(0, third));
    const tail = avg(energies.slice(-third));

    if (peak > mean * 2.8 && strongFrames >= 3) return { emoji: '😮', why: '有一段持续拔高，像在强调' };
    if (tail > head * 1.3) return { emoji: '🤔', why: '尾音往上走，像在提问' };
    if (tail < head * 0.6) return { emoji: '😌', why: '音量往回收，一句话收尾' };
    return { emoji: '🙂', why: '平稳叙述' };
  }

  let lastToneSeq = -99;      // 上一次标表情的位置
  let lastToneEmoji = '';
  const toneWindow = [];      // 最近若干段的“有没有表情”，用来控制频率

  // 十句里出现两三次、最多五次：语气明显时概率高，平稳时很低
  function shouldTagTone(strong) {
    const used = toneWindow.filter(Boolean).length;
    if (used >= 5) return false;                            // 硬上限
    if (toneWindow.length >= 8 && used >= 3) return Math.random() < 0.08;
    return Math.random() < (strong ? 0.50 : 0.22);
  }

  function rememberTone(shown) {
    toneWindow.push(shown);
    while (toneWindow.length > 10) toneWindow.shift();
  }

  // 内容线索优先于语气：问号→疑问，强调词→惊讶，短句收尾→满意
  function toneFromText(text) {
    const t = (text || '').trim();
    if (!t) return null;
    if (/[？?]\s*$/.test(t)) return { emoji: '🤔', why: '这句在提问', strong: true };
    if (/(注意|一定|必须|关键|核心|最重要|千万)/.test(t)) return { emoji: '😮', why: '这句在强调', strong: true };
    if (t.length <= 8 && /[。！!]$/.test(t)) return { emoji: '😌', why: '短句收尾', strong: false };
    return null;
  }

  // 识别出文字之后再决定这一行要不要挂表情
  function maybeTagTone(rowEl, tone, text, seq) {
    if (!rowEl) return;
    if (rowEl.querySelector('.tone')) return;      // 已经有表情，不重复
    if (seq - lastToneSeq < 2) { rememberTone(false); return; }

    const fromText = toneFromText(text);
    const cue = fromText || tone;
    if (!cue || cue.calm) { rememberTone(false); return; }
    if (!shouldTagTone(!!cue.strong)) { rememberTone(false); return; }

    const span = document.createElement('span');
    span.className = 'tone';
    span.textContent = cue.emoji;
    rowEl.appendChild(span);
    lastToneSeq = seq;
    lastToneEmoji = cue.emoji;
    rememberTone(true);
  }

  function applyTone(rowEl, tone, seq = 0) {
    // 只在“语气明显变化”时标一次：平静的不标、同类不重复、至少隔三段
    if (!tone || tone.calm || !rowEl) return;
    if (seq - lastToneSeq < 2) return;   // 至少隔两段，避免每条都挂表情
    const span = document.createElement('span');
    span.className = 'tone';
    span.textContent = tone.emoji;
    rowEl.appendChild(span);
    lastToneSeq = seq;
    lastToneEmoji = tone.emoji;
  }

  // ------------------------------------------------------------ 翻译

  let translateDir = 'off';
  const trQueue = [];
  let trBusy = false;

  // 「自动」档：看这句主要是中文还是英文，译成另一种
  function detectDir(text) {
    const cjk = (text.match(/[\u3400-\u9FFF]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    if (!cjk && !latin) return null;          // 纯数字、符号、公式，没必要翻
    // 中文夹英文术语很常见，把汉字权重放高：汉字占比 ≥20% 就当中文
    return cjk / (cjk + latin) >= 0.2 ? 'zh2en' : 'en2zh';
  }

  function enqueueTranslate(rec, front = true) {
    if (translateDir === 'off' || !rec || !rec.text) return;
    const dir = translateDir === 'auto' ? detectDir(rec.text) : translateDir;
    if (!dir) return;
    if (rec.translated && rec.trDir === dir) return;
    rec.translateDir = dir;
    rec.reqMode = translateDir;           // 记下当时的档位，切档后作废
    if (front) trQueue.unshift(rec);      // 新来的片段优先翻译，不排在补译后面
    else trQueue.push(rec);
    pumpTranslate();
  }

  async function pumpTranslate() {
    if (trBusy || !trQueue.length) return;
    const rec = trQueue.shift();
    if (!rec || rec.translated || rec.reqMode !== translateDir) { pumpTranslate(); return; }
    trBusy = true;
    rec.trEl.classList.remove('hidden');
    rec.trEl.textContent = '翻译中…';
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: rec.text, direction: rec.translateDir }),
      });
      const data = await res.json().catch(() => ({ error: '返回内容无法解析' }));
      if (!res.ok || data.error) {
        rec.trEl.textContent = `（未翻译：${data.error || res.status}）`;
      } else {
        rec.tr = (data.text || '').trim();
        rec.translated = true;
        rec.trDir = rec.translateDir;
        rec.trEl.textContent = rec.tr;
        persistSession();
      }
    } catch (err) {
      rec.trEl.textContent = `（未翻译：${err.message}）`;
    } finally {
      trBusy = false;
      updateStats();
      syncNotesButton();
      if (followTail) scrollToBottom();
      pumpTranslate();
    }
  }

  function setDir(dir) {
    translateDir = dir;
    document.querySelectorAll('.dir').forEach((b) => {
      b.classList.toggle('active', b.dataset.dir === dir);
    });
    if (dir === 'off') {
      segments.forEach((rec) => rec.trEl.classList.add('hidden'));
      btnBackfill.classList.add('hidden');
      elFoot.textContent = '已切回原文，译文暂时收起（没删）。';
      return;
    }

    // 显示已有译文：自动档全都显示，指定档只显示同向的
    segments.forEach((rec) => {
      // 只要选了非「原文」，有译文就常显；刷新恢复的历史译文也算
      const show = rec.tr && (dir === 'auto' || rec.trDir === dir || rec.trDir === 'restored');
      rec.trEl.classList.toggle('hidden', !show);
    });

    const pending = segments.filter((r) => {
      if (!(r.text || '').trim()) return false;
      return dir === 'auto' ? !r.tr : r.trDir !== dir;
    }).length;

    const label = dir === 'auto' ? '自动' : (dir === 'zh2en' ? '中 → 英' : '英 → 中');
    if (pending) {
      btnBackfill.textContent = `补译前面 ${pending} 段`;
      reveal(btnBackfill);
      elFoot.textContent = `已从此刻起按「${label}」翻译；前面 ${pending} 段不自动回译，要补可点「补译前面」。`;
    } else {
      btnBackfill.classList.add('hidden');
      elFoot.textContent = `已从此刻起按「${label}」翻译。`;
    }
  }

  function backfillTranslate() {
    const dir = translateDir;
    if (dir === 'off') return;
    btnBackfill.classList.add('hidden');
    segments.forEach((rec) => {
      if (!(rec.text || '').trim()) return;
      if (dir === 'auto' ? rec.tr : rec.trDir === dir) return;
      rec.translated = false;
      rec.trEl.classList.remove('hidden');
      enqueueTranslate(rec, false);   // 排队尾，不挡实时
    });
  }

  function pump() {
    while (inflight < MAX_INFLIGHT && fireQueue.length) {
      const item = fireQueue.shift();
      uploadSegment(item.wav, item.timeLabel, item.node, item.seq, item.tone);
    }
  }

  // 实时识别跟不上时，切到「只存盘」
  function degrade(reason) {
    if (mode === 'deferred') return;
    mode = 'deferred';

    setEmotion('32');
    updateModeChip();
    elModeChip.classList.add('deferred');
    const why = lastRecogErr ? `：\n${lastRecogErr}` : '';
    showBanner(`识别跟不上（${reason}${why}）\n已切成「先存盘」：音频照常录、照常保存，讲完点「结束并保存」会自动补识别，不丢内容。`);
    const backlog = fireQueue.splice(0);
    backlog.forEach(storeSegment);
  }

  async function storeSegment(item) {
    const rowEl = item.node.x;
    rowEl.classList.remove('error');
    rowEl.classList.add('pending');
    setRowText(rowEl, '已存盘，待识别');
    try {
      const res = await fetch(`/api/segment?session=${encodeURIComponent(sessionId)}&seq=${item.seq}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: item.wav,
      });
      const data = await res.json().catch(() => ({ error: '返回内容无法解析' }));
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      stored.push(item);
      updateRecoverBtn();
      updateModeChip();
      updateStats();
    } catch (err) {
      rowEl.classList.remove('pending');
      rowEl.classList.add('error');
      setRowText(rowEl, `音频没存下来：${err.message}`);
    }
  }

  // 状态灯：实时识别 / 排队 / 先存盘 / 补识别中，一眼看出管道在哪一步
  function updateModeChip() {
    const el = $('modeChip');
    if (!el) return;
    const queued = inflight + fireQueue.length;
    el.className = 'mode-chip';

    if (recoverBusy) {
      el.classList.add('busy');
      el.textContent = '补识别中…';
      return;
    }
    if (mode === 'deferred') {
      el.classList.add('warn');
      el.textContent = stored.length ? `先存盘 · 待识别 ${stored.length}` : '先存盘 · 待补识别';
      return;
    }
    if (running && paused) {
      el.classList.add('warn');
      el.textContent = '已暂停';
      return;
    }
    if (running) {
      if (fireQueue.length > 5) setEmotion('18');   // 无奈：堵太多了
    if (fireQueue.length > 0) {           // 音频已切好，但还没送到识别接口
        el.classList.add('busy');
        el.textContent = `排队解析 ${fireQueue.length} 段`;
          return;
      }
      if (inflight > 0) {                   // 正在调识别接口
        el.classList.add('busy');
        el.textContent = '解析中…';
          return;
      }
      el.classList.add('ok');
      el.textContent = '收音中';
      return;
    }
    el.textContent = '未开始';
  }

  function updateRecoverBtn() {
    if (!stored.length) {
      btnRecover.classList.add('hidden');
      return;
    }
    reveal(btnRecover);
    btnRecover.textContent = `补识别 ${stored.length} 段`;
  }

  // 依序把存盘的片段补识别回来
  async function recoverStored() {
    if (recoverBusy || !stored.length) return;
    recoverBusy = true;
    btnRecover.disabled = true;
    const total = stored.length;
    let done = 0;
    setEmotion('40');
    updateModeChip();
    while (stored.length) {
      const item = stored.shift();
      const rowEl = item.node.x;
      btnRecover.textContent = `补识别中 ${done}/${total}`;
      elSegInfo.textContent = `补识别 ${done}/${total}`;
      setRowText(rowEl, '识别中…');
      try {
        const res = await fetch('/api/transcribe-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: sessionId, seq: item.seq, lang: currentLang }),
        });
        const data = await res.json().catch(() => ({ error: '返回内容无法解析' }));
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        const text = (data.text || '').trim();
        rowEl.classList.remove('pending');
        if (text) setRowText(rowEl, text);
        else foldSilence(rowEl, item.timeLabel);
        maybeTagTone(rowEl, null, text, item.seq);
        const rec = { seq: item.seq, time: item.timeLabel, text, tr: '', trEl: item.node.tr, translated: false };
        segments.push(rec);
      if (running && Math.random() < 0.12) flashEmotion('10', '16', 1600);
        enqueueTranslate(rec);
        done++;
      } catch (err) {
        rowEl.classList.remove('pending');
        rowEl.classList.add('error');
        setRowText(rowEl, `补识别失败：${err.message}`);
      }
    }
    recoverBusy = false;
    btnRecover.disabled = false;
    setEmotion('19');
    mode = 'live';
    updateModeChip();
    updateRecoverBtn();
    elSegInfo.textContent = `已转写 ${segments.length} 段`;
    updateStats();
  }

  function drain(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const tick = () => {
        if (inflight === 0 && fireQueue.length === 0) return resolve();
        if (Date.now() > deadline) return resolve();
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  function flushSegment(final) {
    if (!buffered) return;
    const captured = buffered;                 // 本段采样数（源采样率）
    const total = new Float32Array(buffered);
    let off = 0;
    for (const c of chunks) { total.set(c, off); off += c.length; }
    chunks = [];
    buffered = 0;

    // 剩余太少就别当一段（避免半句话）
    if (!final && total.length < TARGET_RATE * 0.6) return;

    // 片段时间戳用真实录到的采样数算，和「时长」同一个口径
    const srcRate = audioCtx ? audioCtx.sampleRate : lastSampleRate;
    const segStartSec = Math.max(0, recordedSec - captured / srcRate);
    const timeLabel = fmtClock(segStartSec * 1000);
    const node = addSegmentRow(timeLabel);
    const pcm = downsample(total, srcRate, TARGET_RATE);
    const wav = encodeWav(pcm, TARGET_RATE);
    const seqValue = ++seqNo;
    const tone = toneTag(pcm, TARGET_RATE);   // 只算不挂：等识别出文字后一起决定

    const item = { wav, timeLabel, node, seq: seqValue, tone };

    if (mode === 'deferred') {
      storeSegment(item);
    } else {
      fireQueue.push(item);
      pump();
    }
  }

  // ------------------------------------------------------------ 采集

  async function start() {
    if (running || startPending) { return; }
    if (!sessionTitle) { openCourseModal(); return; }
    setView('log');
    setModeText('启动中…', 'busy');   // 一点下去就该看到变化，用来判断点击有没有被接住
    startPending = true;
    setTimeout(() => { startPending = false; }, 1500);

    hideBanner();
    elSaved.classList.add('hidden');
    if (btnMain) btnMain.disabled = false;   // 先解锁：即使麦克风失败，也能点「结束」

    if (connAsrBad || connNotesBad) {
      setModeText('KEY 被拒绝', 'warn');
      showBanner('KEY 被拒绝，先到「设置」核对。右上角的「识别」「整理」标签可以点一下重测。');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setEmotion('38');               // 拒绝/受限
      setModeText('无麦克风接口', 'warn');
      showBanner('这个页面拿不到麦克风接口——请用 http://127.0.0.1:8787 打开（局域网 IP 或 https 才行）。');
      return;
    }
    try {
      setEmotion('31');                 // 接收任务：正在等权限
    micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      setModeText('麦克风被拒绝', 'warn');
      showBanner(`拿不到麦克风（${err.name}：${err.message}）。点地址栏左边的锁/麦克风图标，把权限改成「允许」，再点开始。`);
      return;
    }

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    lastSampleRate = audioCtx.sampleRate;
    sourceNode = audioCtx.createMediaStreamSource(micStream);
    procNode = audioCtx.createScriptProcessor(4096, 1, 1);
    sinkNode = audioCtx.createGain();
    sinkNode.gain.value = 0; // 静音，只为让 ScriptProcessor 持续回调

    const segSamples = () => segSeconds * audioCtx.sampleRate;

    let cbCount = 0;
    procNode.onaudioprocess = (ev) => {
      if (paused) return;
      const data = ev.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
      buffered += data.length;
      recordedSec += data.length / audioCtx.sampleRate;

      // 时长由音频回调驱动刷新，不依赖定时器（后台标签页定时器会被节流）
      if (++cbCount % 6 === 0) { setClockText(durationText()); updateHourMeter(recordedSec); }

      // 电平表
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);

      // 音量环、光晕、30 秒波形（必须在 rms 之后）
      if (cbCount % 3 === 0) { pulseRing(rms); pulseGlow(rms); }
      pushWave(rms);

      // 句子边界：宁可等一个停顿，也不要把句子从中间切断
      const chunkMs = (data.length / audioCtx.sampleRate) * 1000;
      const loud = rms > Math.max(noiseFloor * 2.2, 0.006);
      if (loud) {
        speechSeen = true;
        silenceMs = 0;
      } else {
        silenceMs += chunkMs;
        // 噪声底只下不上：只有更安静时才更新，避免把说话声吸收成“环境噪声”
        if (rms < noiseFloor) noiseFloor = noiseFloor * 0.9 + rms * 0.1;
      }

      const longEnough = buffered >= audioCtx.sampleRate * MIN_SEGMENT_SEC;
      const atPause = longEnough && speechSeen && silenceMs >= PAUSE_MS;
      const atCap = buffered >= segSamples();
      if (atPause || atCap) {
        flushSegment(false);
        silenceMs = 0;
        speechSeen = false;
      }
    };

    sourceNode.connect(procNode);
    procNode.connect(sinkNode);
    sinkNode.connect(audioCtx.destination);

    // 频谱：同一个音源再分一路给 AnalyserNode
    initSpectrum();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    sourceNode.connect(analyser);
    startSpectrum();

    runToken += 1;
    running = true;
    paused = false;

    startedAt = Date.now();
    recordedSec = 0;
    silenceMs = 0;
    speechSeen = false;
    lastToneSeq = -99;
    lastToneEmoji = '';
    noiseFloor = 0.02;
    segments = [];
    seqNo = 0;
    trQueue.length = 0;
    trBusy = false;

    // 新会话：重置降级状态
    sessionId = 'S' + Date.now();
    mode = 'live';
    failStreak = 0;
    seqNo = 0;
    stored.length = 0;
    recoverBusy = false;
    mode = 'live';
    btnRecover.classList.add('hidden');
    btnBackfill.classList.add('hidden');
    elTranscript.innerHTML = '';
    clearStored();
    resetShots();                       // 新的一节课，截图重新计数
    const badge = $('txMode');
    if (badge) badge.classList.add('hidden');
    const wrap = document.querySelector('.transcript-wrap');
    if (wrap) wrap.classList.remove('restored');
    setStatus('live');
    setStatsView('recording');
    setMainState('recording');
    syncMainState();
    btnPause.classList.remove('is-collapsed');
    const actions = document.querySelector('.actions');
    if (actions) {
      actions.classList.add('is-dividing');
      spawnSplash(btnMain, 5);
      setTimeout(() => actions.classList.remove('is-dividing'), 640);
    }
    syncNotesButton();
    setPauseLabel('暂停');
    setFollow(true);

    clearInterval(timerId);
    clearInterval(statsTimer);
    // 45 秒没识别到新内容就转"等待输入"
    clearInterval(silenceTimer);
    silenceTimer = setInterval(() => {
      if (!running || paused) return;
      const quiet = Date.now() - (lastTextAt || Date.now());
      if (quiet > 45000) setEmotion('35');
    }, 5000);
    timerId = setInterval(() => {
      setClockText(durationText());
      syncMainState();
    }, 500);

    // 心跳：统计数字与页脚状态，不依赖每段识别是否成功
    clearInterval(statsTimer);
    statsTimer = setInterval(() => {
      updateStats();
      updateModeChip();      // 状态灯也走心跳，避免停在旧值
      syncNotesButton();     // 按钮可用性同样跟着心跳刷新
      const withText = segments.filter((x) => (x.text || '').trim()).length;
      const q = inflight + fireQueue.length;
      elFoot.textContent = `录音中 · 已收 ${withText} 段` + (q ? ` · 队列 ${q}` : '');
    }, 800);
    setClockText('00:00');
    elSegInfo.textContent = '正在听……';
    updateModeChip();
    setEmotion('01');
    setTimeout(() => { if (running && !paused) setEmotion('16'); }, 700);
    updateStats();
  }

  function togglePause() {
    if (!running) return;
    paused = !paused;
    setPauseLabel(paused ? '继续' : '暂停');
    setEmotion(paused ? '04' : '16');
    setStatus(paused ? 'paused' : 'live');
    elSegInfo.textContent = paused ? '已暂停' : '正在听……';

    if (paused) {
      flushSegment(false);  // 把当前半段先送出去
      }
  }

  async function stop() {
    if (!running && !segments.length && !stored.length) {
      flashEmotion('12', '02', 2600);   // 失落
      showBanner('现在既没在录音，也没有可保存的内容。先点「开始听课」；如果刚录完，稿子已经存好了。');
      return;
    }
    const wasRunning = running;
    running = false;
    setModeText('收尾中…', 'busy');

    setMainState('busy');
    // 看门狗：万一收尾里某一步卡住，15 秒后把按钮放回来，不至于永远卡着
    const watchdog = setTimeout(() => {
      if (mainState === 'busy') setMainState('recording');
    }, 15000);
    hideBanner();
    elSegInfo.textContent = '正在收尾…';
    clearInterval(timerId);
    timerId = null;
    clearInterval(statsTimer);
    statsTimer = null;
    if (wasRunning) setClockText(durationText());

    // 第一件事：立刻掐掉麦克风。按了结束就一定得停
    try {
      micStream && micStream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      console.error('停止麦克风失败', err);
    }
    paused = true;
    try {
      flushSegment(true);
    } catch (err) {
      console.error('收尾 flush 失败', err);
    }

    stopSpectrum();
    clearWave();
    try { analyser && analyser.disconnect(); } catch (_) {}
    analyser = null;
    freqData = null;
    try { procNode && procNode.disconnect(); } catch (_) {}
    try { sourceNode && sourceNode.disconnect(); } catch (_) {}
    try { sinkNode && sinkNode.disconnect(); } catch (_) {}
    try { audioCtx && audioCtx.close(); } catch (_) {}
    try { micStream && micStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    procNode = sourceNode = sinkNode = audioCtx = micStream = null;

    setStatus('idle');
    setStatsView('idle');
    setMainState('idle');
    btnPause.classList.add('is-collapsed');
    clearTimeout(watchdog);
    updateModeChip();
    elSegInfo.textContent = `共 ${segments.length} 段`;
    setEmotion('41');
    setTimeout(() => { if (!running) setEmotion('02'); }, 1200);

    // 存稿之后自动整理：完整讲稿 + 结构化笔记
    // 交给后台：把这一节的数组引用和待补识别音频一起打包，后台自己等、自己存
    const snapshotSource = segments;
    const pending = stored.splice(0);
    updateStats();
    updateRecoverBtn();
    setView('jobs');

    persistSession();  // 保留恢复副本，直到服务端确认转写稿已经落盘
    finishSession(snapshotSource, pending, {
      title: sessionTitle || defaultTitle(),
      duration: elClock.textContent,
      session: sessionId,
    });

    // 本节已交给后台；恢复副本由 finishSession 在保存成功后清除。
    elTranscript.innerHTML = '<p class="empty">本节已交给后台保存和整理，内容可在「历史」里查看。点「开始听课」录下一节。</p>';
    const badge2 = $('txMode');
    if (badge2) badge2.classList.add('hidden');
    const wrap2 = document.querySelector('.transcript-wrap');
    if (wrap2) wrap2.classList.remove('restored');

    sessionTitle = '';
    const titleEl = $('txTitle');
    if (titleEl) titleEl.textContent = '转写记录';
    syncNotesButton();   // 本节内容还在内存里，允许再整理一次
  }

  // 收尾：只吃「快照」，不碰全局状态，所以随时可以开下一节
  async function finishSession(source, pending, meta) {
    const job = startJob(meta.title);
    setView('jobs');
    setEmotion('37');                  // 复述回忆：开始保存并整理
    setTimeout(() => setEmotion('30'), 900);

    // 后台先等最后几段回来（最多 3 秒），再取快照——不挡界面
    if (inflight > 0 || fireQueue.length > 0) {
      updateJob(job, { detail: '等待最后几段识别…' });
      await drain(3000);
    }
    const snapshot = (source || [])
      .filter((x) => (x.text || '').trim())
      .map((x) => ({ seq: x.seq, time: x.time, text: x.text, tr: x.tr || '' }));

    // 1) 后台补识别：把存盘的音频转成文字，结果写进快照，不碰界面
    if (pending.length) {
      updateJob(job, { detail: `补识别 ${pending.length} 段…` });
      for (const item of pending) {
        try {
          const res = await fetch('/api/transcribe-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: meta.session, seq: item.seq, lang: currentLang }),
          });
          const data = await res.json().catch(() => ({}));
          const text = (data.text || '').trim();
          if (res.ok && !data.error && text) {
            snapshot.push({ seq: item.seq, time: item.timeLabel, text, tr: '' });
          }
        } catch (_) { /* 单段失败不影响整体 */ }
      }
      snapshot.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    }

    if (!snapshot.length) {
      updateJob(job, { status: 'error', detail: '这一节没有识别到内容' });
      notice('这节没听到内容，白录了。', '', 15000);
      return;
    }

    // 2) 存转写稿（连同截图清单一起存，重新整理时才不会丢图）
    updateJob(job, { detail: '保存转写稿…' });
    // 刚按的快门可能还在上传，等它落盘再统计
    for (let guard = 0; guard < 40 && pendingShot; guard += 1) {
      await new Promise((r) => setTimeout(r, 150));
    }
    const shotList = shots.map((x) => ({ sec: x.sec, name: x.name }));
    let saved = false;
    let saveRes = await postJsonRetry('/api/save',
      { title: meta.title, duration: meta.duration, segments: snapshot, shots: shotList }, 4, 1500);
    if (!saveRes.ok && await waitForServer(45000)) {
      // 服务刚重启回来，再给一次机会
      saveRes = await postJsonRetry('/api/save',
        { title: meta.title, duration: meta.duration, segments: snapshot, shots: shotList }, 2, 1500);
    }
    if (saveRes.ok) saved = !!saveRes.data.path;

    if (!saved) {
      updateJob(job, { status: 'error', detail: '转写稿没存成（服务未响应）' });
      notice('稿子没存上，本地服务好像断了。刷新页面后这一节还在，重新点「结束并保存」即可。', '', 20000);
      return;
    }

    if (segments === source && !running) clearStored();

    if (!notesReady) {
      updateJob(job, { status: 'done', detail: '只存了转写稿（未配置 DeepSeek KEY）' });
      notice('稿子存好啦，但没配钥匙，整理不了。', '', 15000);
      return;
    }

    // 3) 整理讲稿 + 笔记
    updateJob(job, { detail: '整理讲稿和笔记…', pct: 6 });
    beginProgress('正在整理讲稿和笔记…');
    setEmotion('37');                  // 复述回忆：过一遍刚录的内容
    setTimeout(() => setEmotion('30'), 900);
    let out = null;
    try {
      out = await requestNotes({
        title: meta.title, duration: meta.duration, segments: snapshot, shots: shotList,
      }, (d) => {
        const text = progressText(d);
        const pct = progressPct(d);
        if (pct != null) updateProgress(pct, text || job.detail);
        if (text) updateJob(job, { detail: text, pct: pct == null ? job.pct : pct });
      }, job);
    } catch (err) {
      reportClientError('finish-notes', err, '');
    }

    if (out && out.notes_path) {
      finishProgress('整理完成');
      updateJob(job, {
        status: 'done', detail: '讲稿和笔记都已生成', pct: 100,
        article: out.article_path, notes: out.notes_path,
      });
      setEmotion('33');
      notice(pickDoneLine(), out.notes_path, 25000);
      setTimeout(() => { if (!running) setEmotion('02'); }, 4000);
      elFoot.textContent = '上一节处理完了：点气泡，或到「处理」里看。';
    } else {
      clearGlobalProgress();
      updateJob(job, { status: 'error', detail: '整理没成，转写稿已保存', pct: 100 });
      if (serverDown) {
        notice('本地服务重启中，稿子已经存好了。等服务回来后到「处理」里点「重新整理」。', '', 25000);
      } else {
        notice('整理没成，但转写稿已经存下来了。到「处理」里找到这一节，点右侧「重新整理」就能再来一次。', '', 25000);
      }
      setEmotion('34');
    }
      setTimeout(() => setEmotion('15'), 2400);
  }

  async function saveSession() {
    const usable = segments.filter((s) => (s.text || '').trim())
      .slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    if (!usable.length) {
      elFoot.textContent = '没有识别到内容，未保存。';
      return false;
    }
    try {
      const res = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `课堂记录 ${new Date().toLocaleDateString('zh-CN')}`,
          duration: durationText(),
          segments: usable.map((s) => ({ time: s.time, text: s.text, tr: s.tr || '' })),
        }),
      });
      const data = await res.json();
      if (data.path) {
        elSaved.textContent = `已保存：${data.path}`;
        elSaved.classList.remove('hidden');
        elFoot.textContent = notesReady ? '转写稿已存好，接着整理讲稿和笔记…' : '转写稿已存到工作区。';
        syncNotesButton();
        return true;
      }
      syncNotesButton();
      showBanner(`保存失败：${data.error || '未知原因'}。稿子还在页面里，可以先点「生成笔记」重试。`);
      return false;
    } catch (err) {
      reportClientError('save', err, `segments=${usable.length}`);
      syncNotesButton();
      showBanner(`保存失败：连不上本地服务（${err.message}）。桌面黑窗口可能被关了，重新启动后点「生成笔记」还能救回来。`);
      return false;
    }
  }

  // ------------------------------------------------------------ 复制

  async function copyAll() {
    const text = segments.filter((s) => (s.text || '').trim())
      .map((s) => (s.tr ? `[${s.time}] ${s.text}\n    ↳ ${s.tr}` : `[${s.time}] ${s.text}`))
      .join('\n');
    if (!text) { showBanner('还没有内容可复制。'); return; }
    try {
      await navigator.clipboard.writeText(text);
      elFoot.textContent = '已复制到剪贴板。';
    } catch (err) {
      showBanner(`复制失败：${err.message}`);
    }
  }

  // ------------------------------------------------------------ 生成笔记


  // 点笔记里的 [03:12]：滚到转写区那一行
  // 时间戳换算成秒：支持 mm:ss 与 h:mm:ss
  function timeToSec(t) {
    const parts = String(t || '').trim().split(':').map(Number);
    if (parts.some((n) => Number.isNaN(n))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
  }

  function jumpToTime(t) {
    const target = timeToSec(t);
    const rows = Array.from(document.querySelectorAll('#transcript .seg, #transcript .row'));
    let best = null;
    let bestDiff = Infinity;
    rows.forEach((el) => {
      const sec = timeToSec(el.dataset.time || '');
      if (sec === null) return;
      const diff = Math.abs(sec - (target === null ? 0 : target));
      if (diff < bestDiff) { bestDiff = diff; best = el; }
    });
    if (!best || bestDiff > 180) {
      elFoot.textContent = `转写区找不到 ${t} 附近的段落。`;
      return;
    }
    best.scrollIntoView({ behavior: 'smooth', block: 'center' });
    best.classList.add('flash');
    setTimeout(() => best.classList.remove('flash'), 1600);
  }

  const TAG_CLASS = {
    '理论': 'theory', '现状': 'status', '方法': 'method',
    '案例': 'case', '对比': 'compare', '原则': 'principle', '风险': 'risk',
  };

  function escHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function mdToHtml(md) {
    const esc = (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const inline = (s) => s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]{1,40})\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      // [03:12] 这样的时间锚点：点一下跳到对应转写行
      // 课堂截图：Obsidian 的 ![[文件名]] 和标准 ![](路径) 都认
      .replace(/!\[\[([^\]|]+?\.(?:jpe?g|png|webp|gif))(?:\|[^\]]*)?\]\]/gi,
        (m, name) => `<img class="note-img" loading="lazy" alt="课堂截图" src="/api/shot?name=${encodeURIComponent(name)}">`)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,
        (m, alt, src) => {
          // alt 来自 markdown，必须转义引号，否则能拼出 onerror 之类的属性
          const safeAlt = String(alt || '课堂截图').replace(/"/g, '&quot;').replace(/</g, '&lt;');
          const safeSrc = String(src).replace(/"/g, '%22').replace(/</g, '%3C');
          return `<img class="note-img" loading="lazy" alt="${safeAlt}" src="${safeSrc}">`;
        })
      .replace(/\[(\d{1,3}:\d{2}(?::\d{2})?)\]/g, '<a class="ts-jump" data-t="$1">$1</a>')
      // （理论）（现状）（方法）（案例）（对比） -> 彩色胶囊
      .replace(/（(理论|现状|方法|案例|对比|原则|风险)）/g, (m, k) =>
        `<span class="note-tag t-${TAG_CLASS[k] || 'other'}">${k}</span>`);
    const lines = esc(md).split(/\r?\n/);
    const out = [];
    let list = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { closeList(); continue; }
      let m;
      if ((m = line.match(/^(#{1,5})\s+(.*)$/))) {
        closeList();
        const lvl = Math.min(4, m[1].length + 1);
        out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
        closeList();
        out.push('<hr/>');
      } else if ((m = line.match(/^[-*+]\s+(.*)$/))) {
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if ((m = line.match(/^\d+[.)、]\s*(.*)$/))) {
        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
        out.push(`<li>${inline(m[1])}</li>`);
      } else {
        closeList();
        out.push(`<p>${inline(line)}</p>`);
      }
    }
    closeList();
    return out.join('\n');
  }

  const notesNav = $('notesNav'), notesRaw = $('notesRaw');

  // 从笔记里抽出「章节速览」，做成左侧导航
  function renderNotesNav() {
    if (!notesNav) return;
    const m = /##\s*章节速览\s*\n([\s\S]*?)(?=\n##\s|$)/.exec(lastNotes || '');
    const rows = [];
    if (m) {
      m[1].split(/\r?\n/).forEach((line) => {
        const hit = /^[-*]\s*\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*(.+)$/.exec(line.trim());
        if (hit) rows.push({ t: hit[1], title: hit[2] });
      });
    }
    if (!rows.length) {
      notesNav.innerHTML = '<h4>章节</h4><p class="nav-empty">这份笔记没有章节速览</p>';
      return;
    }
    notesNav.innerHTML = '<h4>章节速览</h4>'
      + rows.map((r) => `<a data-t="${escHtml(r.t)}"><b>${escHtml(r.t)}</b>${escHtml(r.title)}</a>`).join('');
  }

  // 右栏：完整原文（纯文本，跟着走）
  function renderNotesRaw() {
    if (!notesRaw) return;
    const txt = (lastArticle || '').trim();
    notesRaw.innerHTML = txt
      ? `<div>${txt.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`
      : '<p class="raw-empty">还没有整理出原文</p>';
  }


  // 导出：html / pdf / docx
  async function exportDoc(fmt, explicit) {
    const src = explicit || (currentTab === 'article' ? lastArticlePath : lastNotesPath)
      || lastNotesPath || lastArticlePath || historyDocPath;
    if (!src) {
      elFoot.textContent = '还没有可导出的文件。';
      return;
    }
    elFoot.textContent = `正在导出 ${fmt.toUpperCase()}…`;
    try {
      const res = await fetch(`/api/export?fmt=${fmt}&path=${encodeURIComponent(src)}`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(d.error || '导出失败');
      }
      const blob = await res.blob();
      const name = (src.split(/[\\/]/).pop() || '课堂记录').replace(/\.md$/i, '') + '.' + fmt;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      elFoot.textContent = `已导出 ${name}`;
    } catch (err) {
      elFoot.textContent = '导出失败：' + err.message;
    }
  }

  function showTab(name) {
    currentTab = name;
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    const md = name === 'article' ? lastArticle : lastNotes;
    notesBody.innerHTML = md ? mdToHtml(md) : '<p class="empty">（这一部分没有内容）</p>';
    notesBody.scrollTop = 0;
    renderNotesNav();
    renderNotesRaw();
  }

  async function generateNotes(opts = {}) {
    const usable = segments.filter((s) => (s.text || '').trim())
      .slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    if (!usable.length) { showBanner('还没有转写内容。'); return; }

    hideBanner();
    lastNotes = '';
    lastArticle = '';
    elSegInfo.textContent = '正在整理讲稿和笔记…';
    tabs.forEach((t) => { t.disabled = false; });
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === 'notes'));
    setEmotion('37');                 // 复述回忆
    setTimeout(() => setEmotion('30'), 900);
    const job = startJob(`手动整理 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    updateJob(job, { detail: '整理讲稿和笔记…' });
    const silent = !!opts.auto;   // 自动整理一律不弹窗：结果去「历史」看
    notesBody.innerHTML = '<p class="empty">正在整理：先顺成一篇完整讲稿，再提取成笔记……长课可能要一两分钟。</p>';
    notesPath.textContent = '';
    if (!silent) { notesModal.classList.remove('hidden'); flashEmotion('39', '02', 2400); }   // 输出回复

    btnNotes.disabled = true;
    const label = btnNotes.textContent;
    btnNotes.textContent = '整理中…';
    try {
      const data = await requestNotes({
        title: `课堂 ${new Date().toLocaleDateString('zh-CN')}`,
        duration: durationText(),
        segments: usable.map((seg) => ({ time: seg.time, text: seg.text })),
        shots: shots.map((x) => ({ sec: x.sec, name: x.name })),
      }, null, job);
      const res = { ok: true, status: 200 };
      if (!res.ok || data.error) {
        notesBody.innerHTML = '';
        notesModal.classList.add('hidden');
        setEmotion('34');
        updateJob(job, { status: 'error', detail: String(data.error || res.status).slice(0, 60) });
        setTimeout(() => setEmotion('15'), 2400);
        showBanner(`生成失败：${data.error || res.status}`);
        return;
      }
      lastNotes = data.notes || '';
    renderNotesNav();
    renderNotesRaw();
      lastArticle = data.article || '';
      lastNotesPath = data.notes_path || '';
      lastArticlePath = data.article_path || '';
      updateJob(job, {
        status: 'done', detail: '讲稿和笔记已生成',
        article: data.article_path, notes: data.notes_path,
      });
      const artTab = tabs.find((t) => t.dataset.tab === 'article');
      if (artTab) artTab.disabled = !lastArticle;
      showTab(lastNotes ? 'notes' : 'article');

      const lines = [];
      if (data.notes_path) lines.push(`笔记：${data.notes_path}`);
      if (data.article_path) lines.push(`原文：${data.article_path}`);
      notesPath.textContent = (data.where === 'obsidian' ? '' : '（Obsidian 路径不可写，已存本地）\n')
        + lines.join('\n');
      setEmotion('33');
      setTimeout(() => { if (!running) setEmotion('02'); }, 4000);
      if (opts.auto) return data;              // 后台整理：不打断当前界面
      elFoot.textContent = data.where === 'obsidian'
        ? '两份文件已进 Obsidian 收件箱，30 分钟内自动归档。'
        : '已存到本地 sessions/，检查设置里的收件箱路径。';
      elSegInfo.textContent = `共 ${segments.length} 段`;
    } catch (err) {
      updateJob(job, { status: 'error', detail: err.message.slice(0, 60) });
      notesModal.classList.add('hidden');
      showBanner(`生成失败：${err.message}`);
      return null;
    } finally {
      btnNotes.textContent = label;
      syncNotesButton();
    }
  }

  async function copyNotes() {
    const md = currentTab === 'article' ? lastArticle : lastNotes;
    if (!md) return;
    try {
      await navigator.clipboard.writeText(md);
      elFoot.textContent = currentTab === 'article' ? '原文已复制。' : '笔记已复制。';
    } catch (err) {
      showBanner(`复制失败：${err.message}`);
    }
  }

  // ------------------------------------------------------------ 配置

  // 把服务端给的配置贴到界面上（页面注入和 /api/config 两条路共用）
  function applyConfig(cfg) {
    segSeconds = Number(cfg.segment_seconds) || 6;
    currentLang = cfg.language || 'zh';
    checkHealth();
    $('cfgBaseUrl').value = cfg.base_url || '';
    $('cfgModel').value = cfg.model || '';
    $('cfgSeg').value = cfg.segment_seconds || 6;
    $('cfgLang').value = cfg.language || 'zh';
    $('cfgPrompt').value = cfg.prompt || '';
    $('cfgNotesUrl').value = cfg.notes_base_url || '';
    $('cfgNotesModel').value = cfg.notes_model || '';
    $('cfgInbox').value = cfg.obsidian_inbox || '';
    const ka = $('optKeepAudio');
    if (ka) ka.checked = !!cfg.keep_audio;
    notesReady = !!cfg.has_notes_key;
    window.__ver = cfg.version || '';
    window.__build = cfg.build || '';
    const verEl = $('appVer');
    if (verEl) verEl.textContent = 'v' + (cfg.version || '1.4.0');
    const stamp = cfg.build ? ' · 构建 ' + cfg.build : '';
    elFoot.textContent = '录音在本机切片后只发给识别接口' + stamp;
    const inboxName = (cfg.obsidian_inbox || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    const scopeEl = $('scopeText');
    if (scopeEl) scopeEl.textContent = inboxName ? `存入 ${inboxName}` : '存入本地 sessions';
    $('cfgNotesKey').placeholder = cfg.has_notes_key
      ? `已设置 ${cfg.notes_key_hint}（留空表示不修改）`
      : 'sk-...（留空表示不修改）';
    // 首次运行：缺任一 KEY 就直接弹向导，不让用户去猜「设置在哪」
    const setupModal = $('setupModal');
    if (setupModal && (!cfg.has_key || !cfg.has_notes_key)) {
      $('setupSfKey').placeholder = cfg.has_key ? '已配置，留空表示不改' : 'sk-...  在 cloud.siliconflow.cn 申请';
      $('setupDsKey').placeholder = cfg.has_notes_key ? '已配置，留空表示不改' : 'sk-...  在 platform.deepseek.com 申请';
      setupModal.classList.remove('hidden');
    }
  }

  let configFailures = 0;
  let configLoaded = false;
  let configRetryTimer = null;

  async function loadConfig() {
    if (window.__BOOT_CONFIG) {
      // 页面里已经带了配置：直接用，不发请求
      configFailures = 0;
      configLoaded = true;
      clearInterval(configRetryTimer);
      hideBanner();
      applyConfig(window.__BOOT_CONFIG);
      return;
    }
    if (location.protocol === 'file:') {
      showBanner('你是用「本地文件方式」打开的页面（地址栏以 file:// 开头），这种打开方式连不上本地服务。'
        + '请改成在浏览器输入 http://127.0.0.1:8787 打开。');
      setModeText('请用 http 打开', 'warn');
      return;
    }
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const cfg = await res.json();
      configFailures = 0;
      configLoaded = true;
      clearInterval(configRetryTimer);
      hideBanner();
      applyConfig(cfg);
    } catch (err) {
      console.error('[loadConfig] 失败：', err && (err.stack || err.message || err));
      window.__cfgErr = String((err && (err.stack || err.message)) || err);
      configFailures += 1;
      if (configFailures < 4) {
        // 服务刚启动/刚重启时会有几秒空窗，先自动重试，别把页面卡死在坏状态
        setModeText(`连接本地服务 ${configFailures}/3…`, 'busy');
        setTimeout(loadConfig, 700 * configFailures);
        return;
      }
      showBanner('读不到本地配置，服务端可能没启动。正在后台重连，服务起来后会自动恢复。');
      setModeText('等待本地服务', 'warn');
      clearInterval(configRetryTimer);
      configRetryTimer = setInterval(() => {
        if (configLoaded) { clearInterval(configRetryTimer); return; }
        loadConfig();
      }, 4000);
    }
  }

  async function saveConfig() {
    const body = {
      base_url: $('cfgBaseUrl').value,
      model: $('cfgModel').value,
      segment_seconds: Number($('cfgSeg').value) || 6,
      language: $('cfgLang').value || 'zh',
      prompt: $('cfgPrompt').value,
      notes_base_url: $('cfgNotesUrl').value,
      notes_model: $('cfgNotesModel').value,
      obsidian_inbox: $('cfgInbox').value,
    };
    const key = $('cfgKey').value.trim();
    if (key) body.api_key = key;
    const nkey = $('cfgNotesKey').value.trim();
    if (nkey) body.notes_api_key = nkey;
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const cfg = await res.json();
    if (cfg.error) { showBanner(cfg.error); return; }
    $('cfgKey').value = '';
    $('cfgNotesKey').value = '';
    $('modal').classList.add('hidden');
    hideBanner();
    await loadConfig();
    checkHealth();
    elFoot.textContent = '设置已保存。';
  }

  // ------------------------------------------------------------ 事件绑定

  if (btnMain) {
    btnMain.addEventListener('click', () => {
      if (mainState === 'busy') return;
      if (mainState === 'recording') { stop(); return; }
      start();
    });
  }
  if (btnPause) btnPause.classList.add('is-collapsed');
  btnPause.addEventListener('click', togglePause);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && running) setClockText(durationText());
  });
  btnCopy.addEventListener('click', copyAll);
  btnNotes.addEventListener('click', generateNotes);
  // ------------------------------------------------------------ 下载

  async function downloadDoc(path) {
    if (!path) { showBanner('没有可下载的文件。'); return; }
    try {
      const res = await fetch('/api/doc?path=' + encodeURIComponent(path));
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const name = path.split(/[\\/]/).pop() || '课堂记录.md';
      const blob = new Blob([data.text], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      elFoot.textContent = `已下载 ${name}`;
    } catch (err) {
      showBanner(`下载失败：${err.message}`);
    }
  }

  // ------------------------------------------------------------ 文件列表（原历史）

  let allFiles = [];
  let fileKind = 'all';
  let fileQuery = '';

  function fileDate(ts) {
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function updateJobsHeader() {
    const countEl = $('jobsCount');
    const dotEl = $('jobsDot');
    if (!countEl) return;
    const running = jobs.filter((j) => j.status === 'running').length;
    const files = allFiles.length;
    const head = running ? `正在处理 ${running} 个` : '没有正在处理的任务';
    countEl.textContent = files ? `${head} · 共 ${files} 个文件` : head;
    if (dotEl) dotEl.className = 'jp-dot' + (running ? ' live' : (files ? ' ok' : ''));
  }

  function renderFiles() {
    const box = $('histList');
    if (!box) return;
    const q = fileQuery.trim().toLowerCase();
    const rows = allFiles.filter((it) => {
      if (fileKind !== 'all' && it.kind !== fileKind) return false;
      if (q && !it.name.toLowerCase().includes(q)) return false;
      return true;
    });

    if (!rows.length) {
      box.innerHTML = '<p class="hist-empty">没有匹配的文件。</p>';
      return;
    }

    box.innerHTML = rows.map((it) => {
      const regen = it.kind === '转写稿'
        ? `<span class="row-act" data-regen="${encodeURIComponent(it.path)}" role="button" tabindex="0">重新整理</span>`
        : '';
      return `<button class="file-row" data-path="${encodeURIComponent(it.path)}">`
        + `<span class="fmeta"><span class="ft">${fileDate(it.mtime)}</span>`
        + `<span class="fk k${it.kind}">${it.kind}</span></span>`
        + `<span class="fn">${it.name}</span>`
        + regen
        + '</button>';
    }).join('');
    updateJobsHeader();
  }

  async function loadFiles() {
    const box = $('histList');
    if (box && !allFiles.length) box.innerHTML = '<p class="hist-empty">加载中…</p>';
    try {
      const res = await fetch('/api/history');
      const data = await res.json();
      allFiles = data.items || [];
      renderFiles();
    } catch (err) {
      if (box) box.innerHTML = `<p class="hist-empty">读不到文件列表：${err.message}</p>`;
    }
  }

  if ($('histChips')) {
    $('histChips').addEventListener('click', (e) => {
      const btn = e.target.closest('.hist-chip');
      if (!btn) return;
      fileKind = btn.dataset.kind;
      Array.from($('histChips').querySelectorAll('.hist-chip')).forEach((b) => {
        b.classList.toggle('on', b === btn);
      });
      renderFiles();
    });
  }

  if ($('histSearch')) {
    $('histSearch').addEventListener('input', (e) => {
      fileQuery = e.target.value || '';
      renderFiles();
    });
  }

  // ------------------------------------------------------------ 处理任务

  const jobsPanel = $('jobsPanel');
  const jobBadge = $('jobBadge');
  const botBubble = $('botBubble');
  const bubbleText = $('bubbleText');
  const sheetTabs = Array.from(document.querySelectorAll('.sheet-tab'));
  let jobs = [];
  const JOBS_KEY = 'lecture-transcribe:jobs';

  function saveJobs() {
    try { localStorage.setItem(JOBS_KEY, JSON.stringify(jobs.slice(0, 30))); } catch (_) {}
  }

  function loadJobs() {
    try {
      const raw = localStorage.getItem(JOBS_KEY);
      if (!raw) return;
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        // 上次没跑完的标记为中断，避免一直显示处理中
        jobs = list.map((j) => (j.status === 'running' && !j.serverJob
          ? { ...j, status: 'error', detail: '保存尚未完成，请检查转写稿后重试' } : j));
      }
    } catch (_) {}
  }
  let currentView = 'log';

  // 处理页自动刷新：有任务在跑时每 5 秒拉一次列表
  let jobsAutoRefresh = null;
  function startJobsAutoRefresh() {
    if (jobsAutoRefresh) return;
    jobsAutoRefresh = setInterval(() => {
      if (currentView !== 'jobs') return;
      if (!jobs.some((j) => j.status === 'running')) return;
      loadFiles();
    }, 5000);
  }

  function setView(view) {
    if (!jobsPanel) return;
    currentView = view;
    if (railLog) railLog.classList.toggle('on', view === 'log');
    if (railJobs) railJobs.classList.toggle('on', view === 'jobs');
    sheetTabs.forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    const showJobs = view === 'jobs';
    jobsPanel.classList.toggle('hidden', !showJobs);
    elTranscript.classList.toggle('hidden', showJobs);
    const left = document.querySelector('.left');
    if (left) left.classList.toggle('view-jobs', showJobs);
    if (showJobs) loadFiles();
  }

  function renderJobs() {
    if (!jobsPanel) return;

    const running = jobs.filter((j) => j.status === 'running').length;
    if (jobBadge) {
      if (running) {
        jobBadge.textContent = String(running);
        jobBadge.classList.remove('hidden');
      } else {
        jobBadge.classList.add('hidden');
      }
    }

    const listEl = $('jobsList');
    const countEl = $('jobsCount');
    const dotEl = $('jobsDot');
    if (!listEl) return;

    saveJobs();

    updateJobsHeader();

    if (!jobs.length) {
      listEl.innerHTML = '';
      return;
    }

    // 只按“做到哪一步”给进度，不按时间猜
    function stageOf(job) {
      const d = (job.detail || '') + (job.title || '');
      if (job.status === 'done') return { pct: 100, indet: false, text: '完成' };
      if (job.status === 'error') return { pct: 100, indet: false, text: '失败' };
      // 有服务端真实进度就用它，别按文字猜
      if (job.status === 'running' && typeof job.pct === 'number') {
        return { pct: job.pct, indet: false, text: job.detail || '处理中' };
      }
      if (/等待最后几段/.test(d)) return { pct: 8, indet: false, text: '等最后几段' };
      if (/补识别/.test(d)) return { pct: 18, indet: false, text: '补识别' };
      if (/保存转写稿|存稿/.test(d)) return { pct: 34, indet: false, text: '保存转写稿' };
      if (/整理/.test(d)) return { pct: 0, indet: true, text: '整理讲稿和笔记' };
      return { pct: 6, indet: false, text: '准备中' };
    }

    listEl.innerHTML = jobs.slice(0, 6).map((j) => {
      const st = stageOf(j);
      const state = st.text;
      const cls = j.status === 'done' ? ' done' : (j.status === 'error' ? ' error' : '');
      const links = [];
      if (j.article) links.push(`<button data-doc="${encodeURIComponent(j.article)}">完整原文</button>`);
      if (j.notes) links.push(`<button data-doc="${encodeURIComponent(j.notes)}">AI 笔记</button>`);
      const target = j.notes || j.article || '';
      const docAttr = target ? ` data-doc="${encodeURIComponent(target)}"` : '';

      // 进行中：文字压在进度条里
      if (j.status === 'running') {
        const pct = st.indet ? 100 : st.pct;
        const inner = `<b>${j.title}</b><i>${state}</i>`;
        return `<div class="job-pill${st.indet ? ' indeterminate' : ''}" style="--p:${pct}%"${docAttr}>`
          + '<span class="fill"></span>'
          + `<span class="txt">${inner}</span>`
          + `<span class="txt on-fill" aria-hidden="true">${inner}</span>`
          + '</div>';
      }

      // 完成 / 失败：还是普通卡片
      const detail = (j.detail || '') + (links.length ? ' · ' + links.join(' · ') : '');
      return `<div class="job-card${cls}"${docAttr}>`
        + `<span class="jn">${j.title}</span>`
        + `<span class="js">${state}</span>`
        + `<span class="jd">${detail}</span>`
        + '</div>';
    }).join('');
  }

  function startJob(title) {
    const job = { id: Date.now(), title, status: 'running', detail: '准备中…', ts: Date.now() };
    jobs.unshift(job);
    renderJobs();
    return job;
  }

  function updateJob(job, patch) {
    Object.assign(job, patch);
    renderJobs();
    // 任务收尾（完成/失败）：文件已经落盘，正在看处理页就立刻刷
    if (patch.status === 'done' || patch.status === 'error') {
      if (currentView === 'jobs') loadFiles();
    }
  }

  // 台词池：8 个状态，DeepSeek 生成
  const CHATTER = {
  "还没开始": [
    "我先检查一下麦克风，今天录什么课啊",
    "笔记本摊开啦，老师进来我就开录",
    "今天要记重点，我笔帽都咬出牙印了",
    "没开始前我先坐好，三二一就开工",
    "老师还没到吗，我耳朵已经竖起来啦",
    "谁偷吃了饼干，我闻到味儿更饿了"
  ],
  "录音中": [
    "我耳朵竖好了，台上说重点我记着呢",
    "老师刚说的我记下了，笔速有点跟不上",
    "我在录音，眼睛走神耳朵没走",
    "这条重点画个星号，我回头再瞄一遍",
    "台上讲慢点，我手速和脑子在排队",
    "我正记笔记，黑板那题我算错两次啦"
  ],
  "沉默太久": [
    "怎么突然安静了，我麦克风没坏吧",
    "谁开个头啊，我数到三就假装咳嗽",
    "空气安静得能听见我肚子叫了",
    "不会都被静音了吧，我耳朵还在值班",
    "沉默是金的话，我已经捡到一麻袋",
    "来个人说句话，我快把橡皮抠出地图了"
  ],
  "识别排队": [
    "识别排队中，前面还有八个我在等转写",
    "转写堵车啦，我的声音在队列里转圈",
    "排队像食堂打饭，我口水先排上了",
    "识别系统在开派对吗，怎么还不叫我",
    "队列挪一格啦，我笔记跟着抖三抖",
    "再排下去，我都能把这段编成程序了"
  ],
  "讲得太久": [
    "台上讲好久啦，我腿坐得有点麻",
    "老师喝口水吧，我笔记都快写冒烟了",
    "这节好长啊，我屁股想请假五分钟",
    "我快记成火星文了，台上还不停",
    "老师讲得挺细，就是我脑子快满格了",
    "再讲下去，我坐功要练成书法了"
  ],
  "整理完成": [
    "笔记理好啦，重点圈了三个大圈",
    "整理完毕，我的脑子还冒着热气",
    "错别字抓到两只，笔记可以交差啦",
    "重点像二维码，我扫了半天才排好",
    "笔记整理完，我给自己鼓个掌吧",
    "这页排得真齐，比我羽毛球落点准"
  ],
  "出错了": [
    "我卡壳啦，识别好像听岔了一句",
    "麦克风闹脾气，我重启一下就好",
    "别慌，我先把这个小错误揪出来",
    "转写打偏了，像羽毛球飞出界",
    "错误像小怪兽，我一枪一个删掉",
    "给我十秒，我把这段重新捋一遍"
  ],
  "深夜还在讲": [
    "夜深啦，我眼皮开始打架了",
    "老师还不下课，月亮都听困了吧",
    "我偷偷打个哈欠，麦克风别告状啊",
    "这个点还在讲，我泡面都不敢泡",
    "我眼睛快闭上了，笔记还在硬撑",
    "深夜听课像打夜场，我快没蓝了"
  ]
};

  // 8 个槽位：球的上方 4 个（左/中/右 × 两档偏移）+ 下方 4 个
  const CHATTER_SLOTS = [
    { dx: -0.55, dy: -1 }, { dx: 0, dy: -1 }, { dx: 0.55, dy: -1 }, { dx: 1, dy: -1 },
    { dx: -1, dy: 1 }, { dx: -0.4, dy: 1 }, { dx: 0.4, dy: 1 }, { dx: 0.55, dy: 1 },
  ];

  let lastNoticeAt = 0;
  let lastChatterAt = 0;
  let chatterShown = 0;     // 上次冒话的时间，切回页面时判断要不要补一句
  let chatterTimer = null;
  let chatterSlot = -1;
  let chatterLine = '';
  let chatterHideTimer = null;

  function chatterState() {
    const hour = new Date().getHours();
    if (connAsrBad || connNotesBad) return '出错了';
    if (recoverBusy) return '识别排队';
    if (running && paused) return '沉默太久';
    if (running && fireQueue.length > 0) return '识别排队';
    if (running && recordedSec > 3000) return '讲得太久';
    if (running) {
      return (hour >= 23 || hour < 6) ? '深夜还在讲' : '录音中';
    }
    return '还没开始';
  }

  const chatterRecent = [];

  async function pickChatter() {
    const state = chatterState();
    try {
      const res = await fetch('/api/chatter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, recent: chatterRecent }),
      });
      const data = await res.json();
      const line = (data.line || '').trim();
      if (line) {
        chatterRecent.unshift(line);
        if (chatterRecent.length > 6) chatterRecent.pop();
        return { line, state };
      }
    } catch (_) { /* 走本地兜底 */ }

    const lines = CHATTER[state] || CHATTER['录音中'];
    return { line: lines[Math.floor(Math.random() * lines.length)] || lines[0], state };
  }

  // 生成要几秒，期间状态可能已经变了（比如刚开录），那就作废这句
  // 明明在录音，却生成“老师还没到”这类，直接作废
  const IDLE_TALK = /(还没到|在路上|没来|还没开始|等你|开录|开讲|人到|空着|安静)/;

  function speakIfStateMatches(result) {
    if (!result || !result.line) return;
    const now = chatterState();
    if (result.state !== now) return;                 // 状态变了，作废
    if (now !== '还没开始' && IDLE_TALK.test(result.line)) return;  // 语义不符，作废
    showChatter(result.line);
  }

  let lastNoticeText = '';

  function notice(text, docPath, ms = 5000) {
    lastNoticeAt = Date.now();
    lastNoticeText = text;
    clearTimeout(chatterTimer);        // 聊天让位，别盖掉正式提示
    showBubble(text, docPath, ms);
    scheduleChatter();                 // 提示放完继续说话
  }

  function hideChatter() {
    if (!botBubble) return;
    botBubble.classList.remove('show');
    botBubble.classList.add('leaving');
    // 不要立刻把 opacity 写成 0，交给淡出动画；结束后再真正隐藏
    botBubble.style.opacity = '';
    clearTimeout(chatterHideTimer);
    chatterHideTimer = setTimeout(() => {
      botBubble.classList.add('hidden');
      botBubble.classList.remove('leaving');
    }, 380);
  }

  // ---------------------------------------------------------------- 气泡音效
  // 用 WebAudio 现合成一个很轻的「噗」，不引入音频文件
  let bubbleAudioCtx = null;
  let bubbleSoundOn = true;

  function ensureAudioCtx() {
    if (bubbleAudioCtx) return bubbleAudioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      bubbleAudioCtx = new AC();
    } catch (_) {
      bubbleAudioCtx = null;
    }
    return bubbleAudioCtx;
  }

  function playBubblePop() {
    if (!bubbleSoundOn) return;
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;

    // 一个短促的正弦音，频率从 620 滑到 980，再快速衰减
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(620, t0);
    osc.frequency.exponentialRampToValueAtTime(980, t0 + 0.055);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.055, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.14);

    // 再叠一层更低的「噗」，让它不那么像电子音
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(180, t0);
    osc2.frequency.exponentialRampToValueAtTime(120, t0 + 0.09);
    gain2.gain.setValueAtTime(0.0001, t0);
    gain2.gain.exponentialRampToValueAtTime(0.035, t0 + 0.01);
    gain2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
    osc2.connect(gain2).connect(ctx.destination);
    osc2.start(t0);
    osc2.stop(t0 + 0.12);
  }

  // 浏览器要求先有用户交互才允许出声，第一次点击时把上下文唤醒
  function unlockAudio() {
    const ctx = ensureAudioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  function initBubbleSound() {
    const box = $('optBubbleSound');
    let saved = null;
    try { saved = window.localStorage.getItem('bubbleSound'); } catch (_) {}
    bubbleSoundOn = saved !== '0';
    if (box) {
      box.checked = bubbleSoundOn;
      box.addEventListener('change', () => {
        bubbleSoundOn = box.checked;
        try { window.localStorage.setItem('bubbleSound', box.checked ? '1' : '0'); } catch (_) {}
        if (box.checked) playBubblePop();
      });
    }
    ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => {
      window.addEventListener(ev, unlockAudio, { once: true, passive: true });
    });
  }

  // diag 面板：每 5 秒拉一次看门狗状态
  function pollWatchdogForDiag() {
    const tick = async () => {
      try {
        const res = await fetch('/api/watchdog');
        const d = await res.json();
        const state = d.enabled ? (d.strict ? '严格' : '宽松') : '关闭';
        const last = d.last_check ? `${Math.round(d.since_check)}s 前` : '还没探过';
        window.__watchdogText = `${state} · 失败 ${d.fails}/${d.threshold} · 上次 ${last} · `
          + `空闲 ${Math.round(d.idle_for)}s · 间隔 ${Math.round(d.interval)}s · PID ${d.pid}`;
      } catch (_) {
        window.__watchdogText = '查询失败';
      }
    };
    tick();
    setInterval(tick, 5000);
  }

  function showChatter(line) {
    if (!botBubble || !bubbleText) return;
    chatterLine = line;
    bubbleText.textContent = line;
    botBubble.dataset.doc = '';

    const go = botBubble.querySelector('.bubble-go');
    if (go) go.style.display = 'none';

    // 随机尺寸
    const maxW = [168, 186, 204, 224][Math.floor(Math.random() * 4)];
    const px = 13 + Math.floor(Math.random() * 4);
    const py = 8 + Math.floor(Math.random() * 3);

    botBubble.style.cssText = '';
    botBubble.style.maxWidth = maxW + 'px';
    botBubble.style.padding = py + 'px ' + px + 'px';
    botBubble.classList.remove('hidden');
    botBubble.style.opacity = '0';
    playBubblePop();
    if (bubbleText) bubbleText.style.opacity = '0';

    // 先摆出来量尺寸，再按球心方向定位
    const orb = $('orbArea');
    const dock = $('ballDock');
    if (orb && dock) {
      const area = orb.getBoundingClientRect();
      const ball = dock.getBoundingClientRect();
      const usable = usableCandidates(area, ball, botBubble.offsetWidth, botBubble.offsetHeight, 22);
      let pick = usable.length ? usable[Math.floor(Math.random() * usable.length)] : 0;
      if (pick === chatterSlot && usable.length > 1) {
        pick = usable[(usable.indexOf(pick) + 1) % usable.length];
      }
      chatterSlot = pick;
      placeBubble(pick);
    }

    // 从靠近球的那一端长出来（用实际渲染位置算，别引用局部变量）
    let ox = '50%', oy = '0%';
    if (orb && dock) {
      const ballRect = dock.getBoundingClientRect();
      const bubRect = botBubble.getBoundingClientRect();
      const ballCx = ballRect.left + ballRect.width / 2;
      const ballCy = ballRect.top + ballRect.height / 2;
      const bubCx = bubRect.left + bubRect.width / 2;
      const bubCy = bubRect.top + bubRect.height / 2;
      ox = bubCx < ballCx ? '100%' : '0%';
      oy = bubCy < ballCy ? '100%' : '0%';
    }
    botBubble.style.transformOrigin = `${ox} ${oy}`;

    restartBubbleAnim();
    requestAnimationFrame(() => botBubble.style.setProperty('opacity', '1', 'important'));
    clearTimeout(showChatter.textTimer);
    showChatter.textTimer = setTimeout(() => {
      if (bubbleText) bubbleText.style.opacity = '1';
    }, 160);

    lastChatterAt = Date.now();
    chatterShown += 1;
    clearTimeout(chatterHideTimer);
    chatterHideTimer = setTimeout(hideChatter, 7000);
  }

  // 切回页面：浏览器会节流后台定时器，回来时如果太久没说话就补一句
  function catchUpChatter() {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - lastNoticeAt < 25000) return;                 // 刚有正式提示
    if (now - lastChatterAt < 30000) return;                // 30 秒内刚说过
    if (botBubble && !botBubble.classList.contains('hidden') && botBubble.dataset.doc) return;
    if (now - (catchUpChatter.last || 0) < 5000) return;     // focus 和 visibility 会连着来
    catchUpChatter.last = now;
    pickChatter().then(speakIfStateMatches);
    scheduleChatter();
  }


  document.addEventListener('visibilitychange', catchUpChatter);
  window.addEventListener('focus', catchUpChatter);

  function scheduleChatter() {
    clearTimeout(chatterTimer);
    const fast = location.search.includes('chatter=fast');
    const base = fast ? 3 : 20;
    const delay = (base * 0.7 + Math.random() * base * 0.6) * 1000;   // 默认 14–26 秒
    chatterTimer = setTimeout(() => {
      const cool = location.search.includes('chatter=fast') ? 0 : 8000;
      if (Date.now() - lastNoticeAt < cool) { scheduleChatter(); return; }
      // 正式气泡（任务完成提示）还在时先让位
      if (botBubble && !botBubble.classList.contains('hidden') && botBubble.dataset.doc) {
        scheduleChatter();
        return;
      }
      pickChatter().then(speakIfStateMatches);
      scheduleChatter();
    }, delay);
  }

  // 八个候选位：全部在球的包围盒之外，允许压住其他面板
  function bubbleCandidates(area, ball, bw, bh, gap) {
    const cx = ball.left - area.left + ball.width / 2;
    const cy = ball.top - area.top + ball.height / 2;
    const top = ball.top - area.top;
    const bottom = ball.bottom - area.top;
    const left = ball.left - area.left;
    const right = ball.right - area.left;
    return [
      { x: cx - bw / 2, y: top - bh - gap, tag: '上' },
      { x: cx - bw / 2, y: bottom + gap, tag: '下' },
      { x: right + gap, y: cy - bh / 2, tag: '右' },
      { x: left - bw - gap, y: cy - bh / 2, tag: '左' },
      { x: right + gap * 0.6, y: top - bh - gap * 0.6, tag: '右上' },
      { x: left - bw - gap * 0.6, y: top - bh - gap * 0.6, tag: '左上' },
      { x: right + gap * 0.6, y: bottom + gap * 0.6, tag: '右下' },
      { x: left - bw - gap * 0.6, y: bottom + gap * 0.6, tag: '左下' },
    ];
  }

  // 返回视野内可用的候选下标；给不出就返回空数组
  function usableCandidates(area, ball, bw, bh, gap) {
    const list = bubbleCandidates(area, ball, bw, bh, gap);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const out = [];
    list.forEach((c, i) => {
      const L = area.left + c.x;
      const T = area.top + c.y;
      if (L >= 6 && T >= 6 && L + bw <= vw - 6 && T + bh <= vh - 6) out.push(i);
    });
    return out;
  }

  function placeBubble(preferIndex = -1) {
    const orb = $('orbArea');
    const dock = $('ballDock');
    if (!orb || !dock) return;
    const area = orb.getBoundingClientRect();
    const ball = dock.getBoundingClientRect();
    const bw = botBubble.offsetWidth;
    const bh = botBubble.offsetHeight;
    const gap = 22;

    const usable = usableCandidates(area, ball, bw, bh, gap);
    const list = bubbleCandidates(area, ball, bw, bh, gap);
    let idx = preferIndex;
    if (!usable.includes(idx)) idx = usable.length ? usable[0] : 0;

    botBubble.style.left = list[idx].x + 'px';
    botBubble.style.top = list[idx].y + 'px';
    botBubble.style.right = 'auto';
    botBubble.style.bottom = 'auto';
    botBubble.style.maxWidth = '240px';
  }

  // 判断气泡在球的哪一侧：决定透视往哪边转
  function bubbleSideClass() {
    const orb = $('orbArea');
    const dock = $('ballDock');
    botBubble.classList.remove('side-left', 'side-right', 'side-top', 'side-bottom');
    if (!orb || !dock) return;
    const br = botBubble.getBoundingClientRect();
    const bb = dock.getBoundingClientRect();
    const dx = (br.left + br.width / 2) - (bb.left + bb.width / 2);
    const dy = (br.top + br.height / 2) - (bb.top + bb.height / 2);
    if (Math.abs(dx) > Math.abs(dy) * 0.6) {
      botBubble.classList.add(dx < 0 ? 'side-left' : 'side-right');
    } else {
      botBubble.classList.add(dy < 0 ? 'side-top' : 'side-bottom');
    }
    // 自测：强制某一侧，方便看透视
    if (location.search.includes('bubbleside=left')) {
      botBubble.classList.remove('side-right', 'side-top', 'side-bottom');
      botBubble.classList.add('side-left');
    } else if (location.search.includes('bubbleside=right')) {
      botBubble.classList.remove('side-left', 'side-top', 'side-bottom');
      botBubble.classList.add('side-right');
    }
  }

  // 箭头位置：在气泡自己的坐标系里算，跟随气泡一起透视
  function placeArrow() {
    const dock = $('ballDock');
    if (!dock || !botBubble) return;

    const bw = botBubble.offsetWidth;
    const bh = botBubble.offsetHeight;
    if (!bw || !bh) return;

    // 球心相对气泡中心的偏移（布局坐标，不含变换）
    const dx = (dock.offsetLeft + dock.offsetWidth / 2) - (botBubble.offsetLeft + bw / 2);
    const dy = (dock.offsetTop + dock.offsetHeight / 2) - (botBubble.offsetTop + bh / 2);
    const ang = Math.atan2(dy, dx);

    const cos = Math.abs(Math.cos(ang)) || 1e-6;
    const sin = Math.abs(Math.sin(ang)) || 1e-6;
    const t = Math.min((bw / 2) / cos, (bh / 2) / sin);   // 中心 → 边框

    // 根部压进气泡 3px，尾巴和胶囊之间不留缝
    const ex = bw / 2 + Math.cos(ang) * (t - 3);
    const ey = bh / 2 + Math.sin(ang) * (t - 3);

    botBubble.style.setProperty('--tail-x', ex + 'px');
    botBubble.style.setProperty('--tail-y', ey + 'px');
    botBubble.style.setProperty('--tail-rot', (ang + Math.PI / 2) + 'rad');
  }

  // 重播动画（先定侧边，再强制重排）
  function restartBubbleAnim() {
    bubbleSideClass();
    botBubble.classList.remove('leaving');
    botBubble.classList.remove('show');
    void botBubble.offsetWidth;
    botBubble.classList.add('show');
    placeArrow();
  }

  function showBubble(text, docPath, ms = 15000) {
    const go = botBubble.querySelector('.bubble-go');
    if (go) {
      go.style.display = docPath ? '' : 'none';
      go.style.opacity = '0';
    }
    if (bubbleText) bubbleText.style.opacity = '0';
    botBubble.style.opacity = '1';
    botBubble.classList.remove('leaving');
    botBubble.classList.remove('show');
    botBubble.classList.remove('hidden');
    bubbleText.textContent = text;
    placeBubble();
    restartBubbleAnim();
    clearTimeout(showBubble.textTimer);
    showBubble.textTimer = setTimeout(() => {
      if (bubbleText) bubbleText.style.opacity = '1';
      const btn = botBubble.querySelector('.bubble-go');
      if (btn && btn.style.display !== 'none') btn.style.opacity = '1';
    }, 160);
    botBubble.classList.remove('hidden');
    botBubble.dataset.doc = docPath ? encodeURIComponent(docPath) : '';
    clearTimeout(showBubble.timer);
    showBubble.timer = setTimeout(() => botBubble.classList.add('hidden'), ms);
  }

  // ------------------------------------------------------------ 历史记录

  const historyModal = $('historyModal');
  const historyBody = $('historyBody');
  const historyTitle = $('historyTitle');
  const btnHistoryBack = $('btnHistoryBack');

  async function openHistory() {
    const dl = $('dlGroup');
    if (dl) dl.classList.add('hidden');
    historyModal.classList.remove('hidden');
    btnHistoryBack.classList.add('hidden');
    historyTitle.textContent = '历史记录';
    historyBody.innerHTML = '<p class="empty">加载中…</p>';
    try {
      const res = await fetch('/api/history');
      const data = await res.json();
      const items = data.items || [];
      if (!items.length) {
        historyBody.innerHTML = '<p class="empty">还没有记录。听完一节、点「结束并保存」后，转写稿、讲稿和笔记都会出现在这里。</p>';
        return;
      }
      historyBody.innerHTML = items.map((it) => {
        const d = new Date(it.mtime * 1000);
        const when = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `<button class="hist-row" data-path="${encodeURIComponent(it.path)}">`
          + `<span class="hist-time">${when}</span>`
          + `<span class="hist-kind">${it.kind}</span>`
          + `<span class="hist-name">${it.name}</span></button>`;
      }).join('');
    } catch (err) {
      historyBody.innerHTML = `<p class="empty">读不到历史：${err.message}</p>`;
    }
  }

  let regenSource = '';       // 'doc' = 当前文档就是转写稿；否则是转写稿路径

  // 用标题去历史里找对应的转写稿
  async function findTranscriptFor(title) {
    const t = String(title || '').trim();
    if (!t) return '';
    try {
      const res = await fetch('/api/history');
      const d = await res.json();
      const list = (d.items || []).filter((it) => it.kind === '转写稿' || /\.md$/.test(it.name || ''));
      const hits = (d.items || []).filter((it) => (it.kind === '转写稿')
        && String(it.name || '').includes(t));
      if (!hits.length) return '';
      return hits[0].path;
    } catch (_) {
      return '';
    }
  }

  // 从转写稿重新整理一份笔记
  function parseTranscript(text) {
    const out = [];
    text.split(/\r?\n/).forEach((line) => {
      const hit = /^\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*(.+)$/.exec(line.trim());
      if (!hit) return;
      if (hit[2].startsWith('↳')) return;
      out.push({ time: hit[1], text: hit[2].trim() });
    });
    return out;
  }

  // Submit once, then use short requests. A lost response must not generate a
  // second task, and a temporary disconnect must not discard a running task.
  async function localJson(url, options = {}, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal, cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || data.error) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function pollNotesTask(id, onProgress) {
    for (;;) {
      let state;
      try {
        state = await localJson('/api/notes-progress?job=' + encodeURIComponent(id));
      } catch (err) {
        if (err.status && err.status < 500) throw err;
        await sleep(1200);
        continue;
      }
      if (state.stage === 'unknown') {
        throw new Error('整理任务已不存在（服务可能重启过），请从已保存的转写稿重新整理。');
      }
      if (state.stage === 'error') throw new Error(state.error || state.text || '整理失败');
      if (onProgress) onProgress(state);
      if (state.stage === 'done' && state.result) return state.result;
      await sleep(1200);
    }
  }

  async function requestNotes(payload, onProgress, uiJob) {
    const id = payload.job || ('j' + window.crypto.randomUUID());
    if (uiJob) updateJob(uiJob, { serverJob: id });
    const body = JSON.stringify({ ...payload, job: id, background: true });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await localJson('/api/notes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        });
        break;
      } catch (err) {
        if ((err.status && err.status < 500) || attempt >= 3) throw err;
        await sleep(1500 * (attempt + 1));
      }
    }
    return pollNotesTask(id, onProgress);
  }

  async function resumeNotesJob(job) {
    try {
      const data = await pollNotesTask(job.serverJob, (d) => {
        updateJob(job, { detail: progressText(d) || '正在整理…', pct: progressPct(d) });
      });
      updateJob(job, { status: 'done', detail: '讲稿和笔记都已生成', pct: 100,
        article: data.article_path, notes: data.notes_path });
    } catch (err) {
      updateJob(job, { status: 'error', detail: err.message });
    }
  }

  function progressText(d) {
    if (!d) return '';
    if (d.stage === 'article' && d.total > 1) return `整理讲稿 ${d.done}/${d.total} 段…`;
    if (d.stage === 'notes') return '正在整理笔记…';
    if (d.stage === 'save') return '正在写入知识库…';
    if (d.stage === 'all') return '正在整理讲稿和笔记…';
    return d.text || '';
  }

  // 从一份转写稿重新整理笔记（处理页用）
  async function startRegen(path, btn) {
    if (!path) return;
    if (currentDocPath !== path || !docText) await selectFile(path);
    const segs = parseTranscript(docText);
    if (!segs.length) {
      showBanner('这份转写稿里没找到时间轴，没法重新整理。');
      return;
    }
    const h1 = /^#\s+(.+)$/m.exec(docText);
    const title = h1 ? h1[1].trim() : '课堂记录';

    const label = btn ? btn.textContent : '';
    const job = 'r' + Date.now().toString(36);
    if (btn) { btn.disabled = true; btn.textContent = '整理中…'; }

    // 建一条任务记录：处理页能看到进度，刷新后也能接续
    const uiJob = startJob(`重新整理 ${String(title).slice(0, 16)}`);
    updateJob(uiJob, { detail: '整理讲稿和笔记…', pct: 4 });

    hideBanner();
    beginProgress('正在整理讲稿和笔记…');
    try {
      const data = await requestNotes({ title, segments: segs, job, source: path }, (d) => {
        const text = progressText(d);
        const pct = progressPct(d);
        if (pct != null) updateProgress(pct, text);
        if (text && btn) btn.textContent = text;
        if (pct != null || text) {
          updateJob(uiJob, { detail: text || uiJob.detail, pct: pct == null ? uiJob.pct : pct });
        }
      }, uiJob);
      const res = { ok: true, status: 200 };
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      finishProgress('整理完成');
      updateJob(uiJob, {
        status: 'done', detail: '已重新整理完成', pct: 100,
        article: data.article_path, notes: data.notes_path,
      });
      hideBanner();
      await loadFiles();
      await selectFile(data.notes_path);
      showBanner('已重新整理完成，同名旧文件已覆盖。', 6000);
    } catch (err) {
      reportClientError('regen', err, `path=${path}`);
      updateJob(uiJob, { status: 'error', detail: String((err && err.message) || err).slice(0, 40), pct: 100 });
      clearGlobalProgress();
      const netErr = !err || /Failed to fetch|NetworkError|load failed/i.test(String(err.message || err));
      if (netErr) {
        showBanner('服务好像重启了，正在等它回来…', 0);
        if (await waitForServer(45000)) {
          showBanner('服务已恢复，请再点一次「重新整理」。', 8000);
        } else {
          showBanner('服务没有恢复，请双击桌面「课堂转写」图标重启。', 0);
        }
      } else {
        showBanner(`重新整理失败：${err.message}`);
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label || '重新整理成笔记'; }
    }
  }

  // 兼容旧入口（详情弹层里的按钮）
  async function regenNotes() {
    const path = currentDocPath || regenSource;
    await startRegen(path, $('btnRegenNotes'));
  }

  // ---------------------------------------------------------------- 拍板书
  const camPanel = $('cameraPanel');
  const camVideo = $('camVideo');
  const camHint = $('camHint');
  const camShotBtn = $('camShot');
  const camOpenBtn = $('camOpen');
  const camCloseBtn = $('camClose');
  const camCountEl = $('camCount');
  const camNote = $('camNote');

  let camStream = null;
  let camBusy = false;
  let shots = [];              // [{sec, name, at}]

  function shotSeconds() {
    // 录音中就用时长，没录音就是 0（生成时插到最前面那一章）
    return running ? Math.max(0, Math.round(recordedSec)) : 0;
  }

  function updateCamCount() {
    if (camCountEl) camCountEl.textContent = `${shots.length} 张`;
  }

  function showCamHint(text) {
    if (camHint) {
      camHint.textContent = text;
      camHint.style.display = text ? 'flex' : 'none';
    }
  }

  // ---------------- 外观：深色 / 浅色 ----------------
  const THEME_KEY = 'lecture-transcribe:theme';

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme, remember) {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    if (remember) {
      try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
    }
    const ic = $('themeIc');
    const label = $('themeLabel');
    // 按钮显示「点一下会变成什么」，一眼知道下一步
    if (ic) ic.textContent = currentTheme() === 'dark' ? '☀' : '☾';
    if (label) label.textContent = currentTheme() === 'dark' ? '浅色' : '深色';
  }

  function toggleTheme() {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
  }

  if ($('btnTheme')) $('btnTheme').addEventListener('click', toggleTheme);
  applyTheme(currentTheme(), false);

  // 系统主题变了，且用户没手动选过，就跟着变
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', (e) => {
      let saved = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch (_) {}
      if (!saved) applyTheme(e.matches ? 'dark' : 'light', false);
    });
  } catch (_) {}

  // ---------------- 拍板书：缩放 / 取景 ----------------
  const ZOOM_STEPS = [1, 1.5, 2, 3];          // 再大就糊了，最多 3 倍
  let camZoom = 1;          // 当前倍率
  let camCx = 0.5;          // 取景中心（相对原图 0..1）
  let camCy = 0.5;

  let camNoteTimer = null;

  function camFlashNote(text, ms = 2400) {
    if (!camNote) return;
    camNote.textContent = text;
    if (camNoteTimer) clearTimeout(camNoteTimer);
    camNoteTimer = setTimeout(() => {
      if (camNote) camNote.textContent = '截图会存进知识库附件，生成笔记时按时间插到对应章节';
    }, ms);
  }

  function camClampCenter() {
    const half = 0.5 / camZoom;
    camCx = Math.min(1 - half, Math.max(half, camCx));
    camCy = Math.min(1 - half, Math.max(half, camCy));
  }

  const CAM_VIEW_KEY = 'lecture-transcribe:cameraView';

  function camSaveView() {
    try {
      localStorage.setItem(CAM_VIEW_KEY, JSON.stringify({
        zoom: camZoom, cx: camCx, cy: camCy,
      }));
    } catch (_) {}
  }

  function camRestoreView() {
    try {
      const raw = localStorage.getItem(CAM_VIEW_KEY);
      if (!raw) return false;
      const v = JSON.parse(raw);
      const z = Number(v.zoom);
      if (!isFinite(z) || z <= 1.001) return false;
      camZoom = Math.min(3, Math.max(1, z));
      camCx = Math.min(1, Math.max(0, Number(v.cx) || 0.5));
      camCy = Math.min(1, Math.max(0, Number(v.cy) || 0.5));
      return true;
    } catch (_) {
      return false;
    }
  }

  function camApplyTransform() {
    if (!camVideo) return;
    camZoom = Math.min(3, Math.max(1, camZoom));
    camClampCenter();
    const tx = -(camCx * camZoom - 0.5) * 100;
    const ty = -(camCy * camZoom - 0.5) * 100;
    camVideo.style.transform = `translate(${tx}%, ${ty}%) scale(${camZoom})`;
    if ($('camZoomVal')) $('camZoomVal').textContent = Math.round(camZoom * 100) + '%';
    if (camStream) camSaveView();
  }

  function camSetZoom(next) {
    const steps = ZOOM_STEPS;
    const from = steps.reduce((best, v) => (Math.abs(v - camZoom) < Math.abs(best - camZoom) ? v : best), steps[0]);
    let idx = steps.indexOf(from);
    idx = Math.min(steps.length - 1, Math.max(0, idx + next));
    camZoom = steps[idx];
    camApplyTransform();
  }

  function camResetView(remember) {
    camZoom = 1;
    camCx = 0.5;
    camCy = 0.5;
    camApplyTransform();
    if (remember === false) {
      try { localStorage.removeItem(CAM_VIEW_KEY); } catch (_) {}
    }
  }

  // 在预览上拖一个框 → 只看这块（框按 16:9 约束，和画面同比例）
  (function initCamSelect() {
    const stage = $('camStage');
    const box = $('camSelect');
    if (!stage || !box) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;

    function stageRect() {
      return stage.getBoundingClientRect();
    }

    // 舞台坐标 → 视频像素坐标（预览是 object-fit: cover，会裁掉边）
    function stageToVideo(px, py, rect) {
      const vw = camVideo.videoWidth || 1920;
      const vh = camVideo.videoHeight || 1080;
      const videoAspect = vw / vh;
      const stageAspect = rect.width / rect.height;
      if (videoAspect > stageAspect) {
        // 以高度为准，左右被裁
        const shownW = rect.height * videoAspect;
        const offX = (rect.width - shownW) / 2;
        return {
          x: ((px - offX) / shownW) * vw,
          y: (py / rect.height) * vh,
        };
      }
      const shownH = rect.width / videoAspect;
      const offY = (rect.height - shownH) / 2;
      return {
        x: (px / rect.width) * vw,
        y: ((py - offY) / shownH) * vh,
      };
    }

    function drawBox(x1, y1, x2, y2) {
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      box.style.left = left + 'px';
      box.style.top = top + 'px';
      box.style.width = Math.abs(x2 - x1) + 'px';
      box.style.height = Math.abs(y2 - y1) + 'px';
      box.classList.remove('hidden');
    }

    function hideBox() {
      box.classList.add('hidden');
    }

    stage.addEventListener('pointerdown', (e) => {
      if (!camStream || !camVideo.videoWidth) return;
      const rect = stageRect();
      dragging = true;
      startX = e.clientX - rect.left;
      startY = e.clientY - rect.top;
      drawBox(startX, startY, startX, startY);
      stage.classList.add('dragging');
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });

    stage.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = stageRect();
      const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
      const y = Math.min(rect.height, Math.max(0, e.clientY - rect.top));
      // 按 16:9 调整：先取宽，再按画面比例算高
      let w = Math.abs(x - startX);
      let h = Math.abs(y - startY);
      const ratio = 16 / 9;
      if (h * ratio < w) h = w / ratio;
      else w = h * ratio;
      const x2 = startX + Math.sign(x - startX || 1) * w;
      const y2 = startY + Math.sign(y - startY || 1) * h;
      drawBox(startX, startY, x2, y2);

      // 实时算一下这一框会放大到多少（换算到视频像素，和松手后的逻辑一致）
      const vwNow = camVideo.videoWidth || 1920;
      const a1 = stageToVideo(Math.min(startX, x2), Math.min(startY, y2), rect);
      const b1 = stageToVideo(Math.max(startX, x2), Math.max(startY, y2), rect);
      const wPx = Math.max(1, b1.x - a1.x);
      const predicted = Math.min(3, Math.max(1, vwNow / wPx));
      const badge = $('camSelectZoom');
      if (badge) badge.textContent = '×' + predicted.toFixed(1);
      if ($('camZoomVal')) $('camZoomVal').textContent = Math.round(predicted * 100) + '%';
    });

    const finish = (e) => {
      if (!dragging) return;
      dragging = false;
      stage.classList.remove('dragging');
      const rect = stageRect();
      const boxRect = box.getBoundingClientRect();
      hideBox();
      if (!rect.width || !boxRect.width || boxRect.width < rect.width * 0.06) {
        if ($('camZoomVal')) $('camZoomVal').textContent = Math.round(camZoom * 100) + '%';
        return;                       // 框太小，当作误触
      }
      const a = stageToVideo(boxRect.left - rect.left, boxRect.top - rect.top, rect);
      const b = stageToVideo(boxRect.right - rect.left, boxRect.bottom - rect.top, rect);
      const vw = camVideo.videoWidth;
      const vh = camVideo.videoHeight;
      const selW = Math.max(16, Math.min(vw, b.x - a.x));
      const selH = Math.max(9, Math.min(vh, b.y - a.y));
      // 最小框 = 画面 1/3 宽，对应最大 3 倍；再小就糊成一片
      const minSelW = vw / 3;
      if (selW < minSelW - 1) {
        if ($('camZoomVal')) $('camZoomVal').textContent = Math.round(camZoom * 100) + '%';
        camFlashNote('框太小了，至少圈到画面的三分之一');
        return;
      }
      camZoom = Math.min(3, Math.max(1, vw / selW));
      if (camNoteTimer) { clearTimeout(camNoteTimer); camNoteTimer = null; }
      if (camNote) camNote.textContent = '截图会存进知识库附件，生成笔记时按时间插到对应章节';
      camCx = Math.min(1, Math.max(0, (a.x + selW / 2) / vw));
      camCy = Math.min(1, Math.max(0, (a.y + selH / 2) / vh));
      camApplyTransform();
    };
    stage.addEventListener('pointerup', finish);
    stage.addEventListener('pointercancel', finish);

    stage.addEventListener('wheel', (e) => {
      if (!camStream) return;
      e.preventDefault();
      camSetZoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });

    stage.addEventListener('dblclick', () => camResetView(false));

    if ($('camZoomIn')) $('camZoomIn').addEventListener('click', () => camSetZoom(1));
    if ($('camZoomOut')) $('camZoomOut').addEventListener('click', () => camSetZoom(-1));
    if ($('camZoomReset')) $('camZoomReset').addEventListener('click', () => camResetView(false));
  })();

  function resetShots() {
    shots = [];
    updateCamCount();
    if (camNote) camNote.textContent = '截图会存进知识库附件，生成笔记时按时间插到对应章节';
  }

  // 面板可拖动：拖标题栏，位置记在本地
  const CAM_POS_KEY = 'lecture-transcribe:cameraPos';

  function clampCamPos(left, top) {
    const pad = 8;
    const w = camPanel ? camPanel.offsetWidth : 320;
    const h = camPanel ? camPanel.offsetHeight : 240;
    const maxLeft = Math.max(pad, window.innerWidth - w - pad);
    const maxTop = Math.max(pad, window.innerHeight - h - pad);
    return {
      left: Math.min(Math.max(pad, left), maxLeft),
      top: Math.min(Math.max(pad, top), maxTop),
    };
  }

  function applyCamPos(left, top, remember) {
    if (!camPanel) return;
    const pos = clampCamPos(left, top);
    camPanel.style.left = pos.left + 'px';
    camPanel.style.top = pos.top + 'px';
    camPanel.style.right = 'auto';
    camPanel.style.bottom = 'auto';
    if (remember) {
      try { localStorage.setItem(CAM_POS_KEY, JSON.stringify(pos)); } catch (_) {}
    }
  }

  function restoreCamPos() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(CAM_POS_KEY) || 'null'); } catch (_) {}
    if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
      applyCamPos(saved.left, saved.top, false);
    }
  }

  let camDragReady = false;

  function initCameraDrag() {
    if (!camPanel || camDragReady) return;
    camDragReady = true;
    const handle = camPanel.querySelector('.cp-head');
    if (!handle) return;
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const rect = camPanel.getBoundingClientRect();
      dragging = true;
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      applyCamPos(rect.left, rect.top, false);
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });

    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      applyCamPos(e.clientX - offsetX, e.clientY - offsetY, false);
    });

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      const rect = camPanel.getBoundingClientRect();
      applyCamPos(rect.left, rect.top, true);
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', () => {
      const rect = camPanel.getBoundingClientRect();
      if (camPanel.style.left) applyCamPos(rect.left, rect.top, false);
    });

    restoreCamPos();
  }

  async function openCamera() {
    if (camStream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCamHint('这个浏览器拿不到摄像头');
      return;
    }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        // 用 1080p 起，放大取景时才有像素余量
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      if (camVideo) {
        camVideo.srcObject = camStream;
        camVideo.dataset.live = '1';
        await camVideo.play().catch(() => {});
      }
      if (camShotBtn) camShotBtn.disabled = false;
      if (camOpenBtn) camOpenBtn.textContent = '重连摄像头';
      showCamHint('');
      if (camRestoreView()) camApplyTransform();
      else camResetView();
    } catch (err) {
      const name = (err && err.name) || '';
      if (name === 'NotAllowedError') showCamHint('摄像头权限被拒绝，点地址栏左边的图标允许一下');
      else if (name === 'NotReadableError' || name === 'TrackStartError') {
        showCamHint('摄像头被别的程序占用了（会议软件？），关掉那边再试');
      } else if (name === 'NotFoundError') showCamHint('没找到摄像头，检查 USB 有没有插好');
      else showCamHint('打不开摄像头：' + (err.message || name));
      reportClientError('camera', err, 'open');
    }
  }

  function closeCamera() {
    if (camStream) {
      camStream.getTracks().forEach((t) => t.stop());
      camStream = null;
    }
    if (camVideo) {
      camVideo.srcObject = null;
      delete camVideo.dataset.live;
    }
    if (camShotBtn) camShotBtn.disabled = true;
    if (camOpenBtn) camOpenBtn.textContent = '打开摄像头';
    showCamHint('点「打开摄像头」开始');
    camResetView();
  }

  let pendingShot = null;   // 正在上传的那一张，保存前要等它完成

  async function takeShot() {
    if (camBusy || !camStream || !camVideo) return;
    if (!camVideo || camVideo.readyState < 2 || !camVideo.videoWidth) {
      if (camNote) camNote.textContent = '画面还没准备好，等一秒再拍';
      return;
    }
    const w = camVideo.videoWidth;
    const h = camVideo.videoHeight;
    // 按当前取景裁剪：从原帧里切一块，而不是把预览画面放大
    const sw = w / camZoom;
    const sh = h / camZoom;
    const sx = Math.min(w - sw, Math.max(0, camCx * w - sw / 2));
    const sy = Math.min(h - sh, Math.max(0, camCy * h - sh / 2));
    camBusy = true;
    camShotBtn.disabled = true;
    const task = { at: Date.now() };
    pendingShot = task;
    try {
      const maxW = 1600;
      const scale = Math.min(1, maxW / sw);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(sw * scale);
      canvas.height = Math.round(sh * scale);
      canvas.getContext('2d').drawImage(
        camVideo, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
      if (!blob) throw new Error('画面还没准备好');
      const sec = shotSeconds();
      const url = '/api/shot?' + new URLSearchParams({
        sec: String(sec), title: sessionTitle || defaultTitle(), ext: 'jpg',
      }).toString();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      shots.push({ sec: data.sec != null ? data.sec : sec, name: data.name, at: Date.now() });
      updateCamCount();
      persistSession();
      if (pendingShot === task) pendingShot = null;
      if (camNote) {
        camNote.textContent = `已存：${data.name}`;
        setTimeout(() => {
          if (camNote) camNote.textContent = '截图会存进知识库附件，生成笔记时按时间插到对应章节';
        }, 2600);
      }
      flashEmotion('13', null, 1200);
    } catch (err) {
      reportClientError('camera', err, 'shot');
      if (camNote) camNote.textContent = '截图失败：' + (err.message || err);
      if (pendingShot === task) pendingShot = null;
    } finally {
      camBusy = false;
      camShotBtn.disabled = !camStream;
    }
  }

  if ($('btnCamera')) {
    $('btnCamera').addEventListener('click', () => {
      if (!camPanel) return;
      const hiding = camPanel.classList.toggle('hidden');
      if (hiding) {
        closeCamera();
      } else {
        initCameraDrag();     // 首次打开时应用记住的位置
        openCamera();
      }
    });
  }
  if (camCloseBtn) {
    camCloseBtn.addEventListener('click', () => {
      if (camPanel) camPanel.classList.add('hidden');
      closeCamera();
    });
  }
  if (camOpenBtn) camOpenBtn.addEventListener('click', openCamera);
  if (camShotBtn) camShotBtn.addEventListener('click', takeShot);

  // ---------------------------------------------------------------- 错误上报
  // 浏览器里的异常直接写到服务端 logs/client.log，事后不用再靠截图
  const ERR_SENT = new Map();
  let clientLogCount = 0;

  function reportClientError(kind, err, ctx) {
    try {
      if (clientLogCount > 40) return;                 // 防止死循环刷日志
      const msg = String((err && err.message) || err || '').slice(0, 300);
      if (!msg) return;
      const key = kind + '|' + msg;
      const now = Date.now();
      if (now - (ERR_SENT.get(key) || 0) < 8000) return;   // 同样的错 8 秒内只报一次
      ERR_SENT.set(key, now);
      clientLogCount += 1;
      const body = JSON.stringify({
        kind,
        message: msg,
        stack: String((err && err.stack) || '').slice(0, 2000),
        view: typeof currentView === 'string' ? currentView : '-',
        running: !!running,
        segments: segments.length,
        serverDown: !!serverDown,
        url: location.href,
        ua: navigator.userAgent.slice(0, 120),
        ctx: ctx || '',
      });
      fetch('/api/client-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch (_) { /* 上报本身不能出事 */ }
  }

  window.addEventListener('error', (e) => {
    reportClientError('error', e.error || e.message, `src=${(e.filename || '').split('/').pop()}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    reportClientError('rejection', e.reason, '');
  });

  // ---------------------------------------------------------------- 进度与连接状态
  const gpBox = $('globalProgress');
  const gpFill = $('globalProgressFill');
  const gpLabel = $('globalProgressLabel');
  const gpTime = $('globalProgressTime');
  const serverAlert = $('serverAlert');
  const serverAlertText = $('serverAlertText');
  const btnServerReload = $('btnServerReload');

  let serverDown = false;
  let serverDownAt = 0;
  let serverPingTimer = null;

  // 进度条状态：不确定进度（0-100 未知）+ 已用时间，让人看得出还在动
  const gpState = { pct: null, text: '', indet: true, t0: 0, ticker: null };

  function renderProgress() {
    if (!gpBox) return;
    const sec = gpState.t0 ? Math.round((Date.now() - gpState.t0) / 1000) : 0;
    if (gpLabel) gpLabel.textContent = gpState.text || '正在整理';
    if (gpTime) gpTime.textContent = sec >= 2 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : '';
    gpBox.classList.toggle('indeterminate', gpState.indet);
    if (gpTime && !gpState.indet) gpTime.textContent = `${Math.round(gpState.pct)}% · ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    if (!gpState.indet && gpFill) gpFill.style.width = Math.max(2, Math.min(100, gpState.pct)) + '%';
  }

  function tickProgress() {
    if (gpState.ticker) return;
    gpState.ticker = setInterval(renderProgress, 1000);
  }

  function stopProgressTicker() {
    if (gpState.ticker) {
      clearInterval(gpState.ticker);
      gpState.ticker = null;
    }
  }

  function beginProgress(text) {
    gpState.text = text || '正在整理';
    gpState.pct = null;
    gpState.indet = true;
    gpState.t0 = Date.now();
    if (gpBox) gpBox.classList.remove('hidden');
    tickProgress();
    renderProgress();
  }

  function updateProgress(pct, text) {
    if (text) gpState.text = text;
    if (pct != null) {
      gpState.pct = pct;
      gpState.indet = false;
    }
    if (!gpState.t0) gpState.t0 = Date.now();
    if (gpBox) gpBox.classList.remove('hidden');
    tickProgress();
    renderProgress();
  }

  function finishProgress(text) {
    if (gpBox) gpBox.classList.remove('hidden');
    gpState.text = text || '整理完成';
    gpState.pct = 100;
    gpState.indet = false;
    renderProgress();
    stopProgressTicker();
    setTimeout(() => { if (gpBox) gpBox.classList.add('hidden'); }, 1600);
  }

  function clearGlobalProgress() {
    stopProgressTicker();
    gpState.t0 = 0;
    gpState.pct = null;
    if (gpBox) {
      gpBox.classList.add('hidden');
      gpBox.classList.remove('indeterminate');
    }
  }

  function showServerAlert(text, kind) {
    if (!serverAlert) return;
    serverAlert.classList.remove('hidden', 'recovered', 'failed');
    if (kind) serverAlert.classList.add(kind);
    if (serverAlertText) serverAlertText.textContent = text;
    if (btnServerReload) btnServerReload.classList.toggle('hidden', kind !== 'failed');
  }

  function hideServerAlert() {
    if (serverAlert) serverAlert.classList.add('hidden');
  }

  // 轻量探活：只看本地服务，不调用外部接口
  async function pingServer(timeoutMs = 2500) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch('/api/ping', { signal: ctrl.signal, cache: 'no-store' });
      return res.ok;
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function waitForServer(maxMs = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (await pingServer()) return true;
      await new Promise((r) => setTimeout(r, 1200));
    }
    return false;
  }

  function startServerWatch() {
    if (serverPingTimer) return;
    let checking = false;
    let failures = 0;
    serverPingTimer = setInterval(async () => {
      if (document.hidden || checking) return;
      checking = true;
      try {
        const ok = await pingServer();
        failures = ok ? 0 : failures + 1;
        if (!ok && failures < 3) return;
        if (!ok && !serverDown) {
          serverDown = true;
          serverDownAt = Date.now();
          showServerAlert('暂时无法连接本地服务，正在自动重连…');
        } else if (ok && serverDown) {
          serverDown = false;
          showServerAlert('服务已恢复，正在继续查询处理结果', 'recovered');
          renderProgress();
          setTimeout(() => { if (!serverDown) hideServerAlert(); }, 2600);
        } else if (!ok && serverDown && Date.now() - serverDownAt > 45000) {
          showServerAlert('本地服务仍未响应，正在重连；若窗口已退出，请重新启动程序', 'failed');
        }
      } finally {
        checking = false;
      }
    }, 3000);
  }

  if (btnServerReload) {
    btnServerReload.addEventListener('click', () => location.reload());
  }

  // 把服务端阶段换算成 0-100，用于进度条
  function progressPct(d) {
    if (!d) return null;
    if (d.stage === 'done') return 100;
    if (d.stage === 'error') return null;
    if (d.stage === 'save') return 96;
    if (d.stage === 'notes') return 90;
    if (d.stage === 'article') {
      const total = Number(d.total) || 0;
      const done = Number(d.done) || 0;
      // 分块整理才算得出百分比，单次调用就保持不确定进度
      return total > 1 ? 8 + (done / total) * 78 : null;
    }
    return null;
  }

  // 带重试的 POST：服务重启/网络抖动时多试几次，别一次失败就判死
  async function postJsonRetry(url, payload, tries = 3, gap = 2000) {
    let lastErr = null;
    for (let i = 0; i < tries; i += 1) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && !data.error) return { ok: true, data };
        lastErr = new Error(data.error || `HTTP ${res.status}`);
        if (res.status >= 400 && res.status < 500) return { ok: false, error: lastErr };
      } catch (err) {
        lastErr = err;
      }
      if (i < tries - 1) await new Promise((r) => setTimeout(r, gap * (i + 1)));
    }
    return { ok: false, error: lastErr };
  }

  // ---------------------------------------------------------------- 处理页
  // 三栏：左边选文件，中间读，右边章节导航

  let currentDocPath = '';

  const KIND_CLASS = { '笔记': 'k笔记', '讲稿': 'k讲稿', '转写稿': 'k转写稿' };

  function docKindOf(path, name) {
    const n = name || String(path || '').split(/[\\/]/).pop() || '';
    if (/转写稿/.test(n)) return '转写稿';
    if (/课堂笔记/.test(n)) return '笔记';
    if (/课堂原文|讲稿/.test(n)) return '讲稿';
    return '笔记';
  }

  function renderRightNav(text, kind) {
    const box = $('jpRight');
    if (!box) return;
    if (kind !== '笔记') {
      box.innerHTML = '<h4>时间锚点</h4><div class="nav-empty">转写稿按时间排序，点击可在上方跳转</div>';
      const anchors = [];
      text.split(/\r?\n/).forEach((line) => {
        const m = /^\[(\d{1,3}:\d{2}(?::\d{2})?)\]/.exec(line.trim());
        if (m) anchors.push(m[1]);
      });
      if (anchors.length) {
        // 每 20 个取一个，避免太长
        const step = Math.max(1, Math.floor(anchors.length / 12));
        const picked = anchors.filter((_, i) => i % step === 0).slice(0, 12);
        box.innerHTML = '<h4>时间锚点</h4>'
          + picked.map((t) => `<a data-t="${t}"><b>${t}</b></a>`).join('');
      }
      return;
    }
    const m = /##\s*章节速览\s*\n([\s\S]*?)(?=\n##\s|$)/.exec(text);
    const rows = [];
    if (m) {
      m[1].split(/\r?\n/).forEach((line) => {
        const hit = /^[-*]\s*\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*(.+)$/.exec(line.trim());
        if (hit) rows.push({ t: hit[1], title: hit[2] });
      });
    }
    if (rows.length) {
      box.innerHTML = '<h4>章节速览</h4>'
        + rows.map((r) => `<a data-t="${escHtml(r.t)}"><b>${escHtml(r.t)}</b>${escHtml(r.title)}</a>`).join('');
      return;
    }
    // 没有章节速览就退化成「小标题导航」
    const heads = [];
    text.split(/\r?\n/).forEach((line) => {
      const m2 = /^##\s+(.+)$/.exec(line.trim());
      if (m2 && !/章节速览|摘要/.test(m2[1])) heads.push(m2[1].trim());
    });
    box.innerHTML = heads.length
      ? '<h4>小标题</h4>' + heads.map((h, i) => `<a data-head="${i}">${escHtml(h)}</a>`).join('')
      : '<h4>章节速览</h4><div class="nav-empty">这份笔记没有章节速览</div>';
  }

  // 点右侧小标题，滚到正文对应位置
  function scrollToHeading(idx) {
    const heads = [...document.querySelectorAll('.jp-doc-body h3')];
    const el = heads[Number(idx)];
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1400);
  }

  function renderDocPane(path, text, kind) {
    const pane = $('jpMain');
    if (!pane) return;
    const name = String(path || '').split(/[\\/]/).pop() || '';
    const rawTitle = (/^#\s+(.+)$/m.exec(text) || [])[1] || name.replace(/\.md$/i, '');
    const title = rawTitle
      .replace(/^课堂(笔记|原文)-/, '')
      .replace(/-\d{4}-\d{2}-\d{2}-\d{4}$/, '')
      .trim() || rawTitle;
    const body = text.replace(/^\s*#\s+[^\n]+\r?\n/, '');
    const chars = text.replace(/\s/g, '').length;
    const isTranscript = kind === '转写稿';

    pane.innerHTML = '<div class="jp-doc-head">'
      + `<h2 class="jp-doc-title">${escHtml(title)}</h2>`
      + '<div class="jp-doc-meta">'
      + `<span class="fk ${KIND_CLASS[kind] || ''}">${kind}</span>`
      + `<span>${chars.toLocaleString('zh-CN')} 字</span>`
      + `<span>${escHtml(name)}</span>`
      + '</div>'
      + '<div class="jp-doc-actions">'
      + (isTranscript ? '<button class="primary" id="jpRegen">重新整理成笔记</button>' : '')
      + '<button data-dl="docx">Word</button><button data-dl="pdf">PDF</button><button data-dl="html">HTML</button>'
      + '</div>'
      + '</div>'
      + `<div class="jp-doc-body">${mdToHtml(body)}</div>`;

    const regen = $('jpRegen');
    if (regen) regen.addEventListener('click', () => startRegen(path, regen));
    pane.querySelectorAll('[data-dl]').forEach((btn) => {
      btn.addEventListener('click', () => exportDoc(btn.dataset.dl, path));
    });
    pane.scrollTop = 0;
  }

  const jpRightEl = $('jpRight');
  if (jpRightEl) {
    jpRightEl.addEventListener('click', (e) => {
      const head = e.target.closest('[data-head]');
      if (head) { scrollToHeading(head.dataset.head); return; }
      const ts = e.target.closest('[data-t]');
      if (ts) jumpToTime(ts.dataset.t);
    });
  }

  async function selectFile(path) {
    const kind = docKindOf(path);
    // 列表高亮
    document.querySelectorAll('#histList .file-row').forEach((r) => {
      r.classList.toggle('is-on', r.dataset.path === encodeURIComponent(path));
    });
    const pane = $('jpMain');
    if (pane) pane.innerHTML = '<div class="jp-empty"><p>加载中…</p></div>';
    try {
      const res = await fetch('/api/doc?path=' + encodeURIComponent(path));
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const text = String(data.text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
      currentDocPath = path;
      docText = text;
      regenSource = kind === '转写稿' ? 'doc' : '';
      renderDocPane(path, text, kind);
      renderRightNav(text, kind);
    } catch (err) {
      if (pane) pane.innerHTML = `<div class="jp-empty"><p>打不开：${err.message}</p></div>`;
    }
  }

  // 从列表/气泡/任务卡片打开文档：统一切到处理页
  function openDoc(path) {
    const panel = $('jobsPanel');
    if (!panel || panel.classList.contains('hidden')) setView('jobs');
    return selectFile(path);
  }

  if (elConnAsr) elConnAsr.addEventListener('click', checkHealth);
  if (elConnNotes) elConnNotes.addEventListener('click', checkHealth);

  const setupSave = $('btnSetupSave');
  if (setupSave) {
    setupSave.addEventListener('click', async () => {
      const sf = $('setupSfKey').value.trim();
      const ds = $('setupDsKey').value.trim();
      if (!sf && !ds) { $('setupHint').textContent = '两个都空着，先至少填一个吧。'; return; }
      const body = {};
      if (sf) body.api_key = sf;
      if (ds) body.notes_api_key = ds;
      try {
        const res = await fetch('/api/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const cfg = await res.json();
        if (cfg.error) throw new Error(cfg.error);
        $('setupSfKey').value = '';
        $('setupDsKey').value = '';
        $('setupModal').classList.add('hidden');
        await loadConfig();
        checkHealth();
        hideBanner();
        elFoot.textContent = 'KEY 已保存，正在检测连接…';
      } catch (err) {
        $('setupHint').textContent = '保存失败：' + err.message;
      }
    });
  }
  const setupLater = $('btnSetupLater');
  if (setupLater) setupLater.addEventListener('click', () => $('setupModal').classList.add('hidden'));

  btnSettings.addEventListener('click', () => $('modal').classList.remove('hidden'));
  $('btnCancel').addEventListener('click', () => $('modal').classList.add('hidden'));
  $('btnSaveCfg').addEventListener('click', saveConfig);
  $('btnCopyNotes').addEventListener('click', copyNotes);
  // 笔记弹窗：Word / PDF / HTML
  ['btnDownloadNotes', 'btnDownloadPdf', 'btnDownloadHtml'].forEach((id) => {
    const btn = $(id);
    if (!btn) return;
    btn.addEventListener('click', () => exportDoc(btn.dataset.fmt || 'docx'));
  });

  // 历史记录：打开任意一份文档后，同样给三种格式
  const regenBtn = $('btnRegenNotes');
  if (regenBtn) regenBtn.addEventListener('click', regenNotes);
  const dlGroup = $('dlGroup');
  if (dlGroup) {
    dlGroup.addEventListener('click', (e) => {
      const hit = e.target.closest('button[data-dl]');
      if (hit) exportDoc(hit.dataset.dl, historyDocPath);
    });
  }
  btnRecover.addEventListener('click', () => { recoverStored(); });

  const ballDock = $('ballDock');
  if (ballDock) {
    ballDock.setAttribute('aria-label', '课堂机器人');
    ballDock.addEventListener('click', tapBall);
    ballDock.addEventListener('mouseenter', () => {
      if (!running && mainState === 'idle') flashEmotion('03', '02', 1400);   // 好奇
    });
  }
  if (notesNav) {
    notesNav.addEventListener('click', (e) => {
      const hit = e.target.closest('a[data-t]');
      if (hit) jumpToTime(hit.dataset.t);
    });
  }

  if (notesBody) {
    notesBody.addEventListener('click', (e) => {
      const hit = e.target.closest('.ts-jump');
      if (hit) jumpToTime(hit.dataset.t);
    });
  }
  btnBackfill.addEventListener('click', backfillTranslate);
  document.querySelectorAll('.dir').forEach((b) => {
    b.addEventListener('click', () => setDir(b.dataset.dir));
  });
  tabs.forEach((t) => t.addEventListener('click', () => {
    if (!t.disabled) showTab(t.dataset.tab);
  }));
  const railLog = $('railLog'), railJobs = $('railJobs'), railHistory = $('railHistory');
  if (railLog) railLog.addEventListener('click', () => setView('log'));
  if (railJobs) railJobs.addEventListener('click', () => setView('jobs'));
  if (railHistory) railHistory.addEventListener('click', () => openHistory());
  if (jobsPanel) {
    jobsPanel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-doc]');
      if (btn) openDoc(decodeURIComponent(btn.dataset.doc));
    });
  }
  if (botBubble) {
    botBubble.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'btnBubbleOpen') return;
      hideChatter();
    });
  }

  const courseGo = $('btnCourseGo');
  if (courseGo) courseGo.addEventListener('click', confirmCourse);
  const courseCancel = $('btnCourseCancel');
  if (courseCancel) courseCancel.addEventListener('click', closeCourseModal);
  const courseInput = $('courseInput');
  if (courseInput) {
    courseInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirmCourse(); }
      if (e.key === 'Escape') { e.preventDefault(); closeCourseModal(); }
    });
  }

  const jobsListEl = $('jobsList');
  if (jobsListEl) {
    jobsListEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-doc]');
      if (btn) { openDoc(decodeURIComponent(btn.dataset.doc)); return; }
      const card = e.target.closest('.job-card[data-doc]');
      if (card) openDoc(decodeURIComponent(card.dataset.doc));
    });
  }

  const bubbleBtn = $('btnBubbleOpen');
  if (bubbleBtn) bubbleBtn.addEventListener('click', () => {
    const doc = botBubble.dataset.doc;
    botBubble.classList.add('hidden');
    if (doc) openDoc(decodeURIComponent(doc));
  });
  const histList = $('histList');
  if (histList) {
    histList.addEventListener('click', async (e) => {
      const act = e.target.closest('.row-act');
      if (act && act.dataset.regen) {
        e.preventDefault();
        e.stopPropagation();
        await startRegen(decodeURIComponent(act.dataset.regen), act);
        return;
      }
      const row = e.target.closest('.file-row');
      if (row && row.dataset.path) selectFile(decodeURIComponent(row.dataset.path));
    });
  }

  flashEmotion('05', '02', 1600);   // 加载苏醒

  // 5 分钟没人动就睡了，一动就醒
  let sleepTimer = null;
  function resetIdleSleep() {
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(() => {
      if (!running && mainState === 'idle') setEmotion('00');   // 睡眠
    }, 5 * 60 * 1000);
  }
  ['pointerdown', 'keydown', 'wheel'].forEach((ev) => {
    document.addEventListener(ev, () => { if (!running) resetIdleSleep(); }, { passive: true });
  });
  resetIdleSleep();
  spinIdleBall();
  loadStats();
  initBubbleSound();
  startServerWatch();
  loadJobs();
  jobs.filter((job) => job.status === 'running' && job.serverJob).forEach(resumeNotesJob);
  renderJobs();
  startJobsAutoRefresh();
  window.addEventListener('focus', () => {
    if (currentView === 'jobs') loadFiles();
  });

  // 按钮水波：从鼠标落点扩散
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.btn');
    if (!btn || btn.disabled) return;
    const r = btn.getBoundingClientRect();
    const size = Math.max(r.width, r.height);
    const ink = document.createElement('span');
    ink.className = 'btn-ripple';
    ink.style.width = ink.style.height = size + 'px';
    ink.style.left = (e.clientX - r.left - size / 2) + 'px';
    ink.style.top = (e.clientY - r.top - size / 2) + 'px';
    btn.appendChild(ink);
    setTimeout(() => ink.remove(), 600);
  }, { passive: true });

  scheduleChatter();

  const histBtn = $('btnHistory');
  if (histBtn) histBtn.addEventListener('click', openHistory);
  const histClose = $('btnCloseHistory');
  if (histClose) histClose.addEventListener('click', () => historyModal.classList.add('hidden'));
  if (btnHistoryBack) btnHistoryBack.addEventListener('click', openHistory);
  historyBody.addEventListener('click', (e) => {
    const row = e.target.closest('.hist-row');
    if (row) openDoc(decodeURIComponent(row.dataset.path));
  });
  historyModal.addEventListener('click', (e) => { if (e.target === historyModal) historyModal.classList.add('hidden'); });

  $('btnCloseNotes').addEventListener('click', () => notesModal.classList.add('hidden'));
  notesModal.addEventListener('click', (e) => {
    if (e.target === notesModal) notesModal.classList.add('hidden');
  });
  $('modal').addEventListener('click', (e) => {
    if (e.target === $('modal')) $('modal').classList.add('hidden');
  });

  window.addEventListener('beforeunload', (e) => {
    if (running) { e.preventDefault(); e.returnValue = ''; }
  });

  const heroDate = $('heroDate');
  if (heroDate) heroDate.textContent = new Date().toLocaleDateString('zh-CN');
  // 自测：?selftest=stop 直接造几段内容并跑完「结束」全流程
  if (location.search.includes('selftest=race')) {
    setTimeout(() => {
      running = true;
      [['00:00', '第一节的第一句话。'], ['00:06', '第一节的第二句话。']].forEach(([t, x], i) => {
        const node = addSegmentRow(t);
        node.x.classList.remove('pending');
        node.x.textContent = x;
        segments.push({ seq: i + 1, time: t, text: x, tr: '', trEl: node.tr, translated: false });
      });
      stop();
      setTimeout(() => { start(); }, 900);
    }, 300);
  }

  if (location.search.includes('selftest=stop')) {
    setTimeout(() => {
      running = true;
      startedAt = Date.now();
      [['00:00', '好，我们上课。今天讲二叉树的中序遍历。'],
       ['00:07', '中序遍历就是先左子树，然后根节点，最后右子树。'],
       ['00:14', '二叉搜索树的中序遍历一定递增，这个经常考。']].forEach(([t, x], i) => {
        const node = addSegmentRow(t);
        node.x.classList.remove('pending');
        node.x.textContent = x;
        segments.push({ seq: i + 1, time: t, text: x, tr: '', trEl: node.tr, translated: false });
      });
      updateStats();
      stop();
    }, 300);
  }

  // 自测：?selftest=click 模拟真实点击「开始听课」，看完再点「结束并保存」
  if (location.search.includes('selftest=nomic')) {
    setTimeout(() => {
      try { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); } catch (_) {}
      document.getElementById('btnMain').click();
    }, 600);
  }

  // 自测：用合成音频流替换麦克风，跑通「录音 → 断句 → 识别」整条链路
  // 自测：伪造 AudioContext 与麦克风，驱动真实的录音/状态灯代码
  // 自测：把真实 TTS 语音喂进假音频管线，跑通「录音 → 识别 → 存稿 → 笔记」
  // 自测：把主要交互全跑一遍，任何未声明变量都会立即报出来
  if (location.search.includes('slomo=1')) document.body.classList.add('slow-anim');
  if (location.search.includes('stats=rec')) {
    setTimeout(() => {
      setStatsView('recording');
      segments.push({ seq: 1, time: '00:12', text: '这是演示用的识别内容，用来把实时指标填起来。', tr: '', translated: false });
      segments.push({ seq: 2, time: '00:26', text: '第二段也写点东西，让字数看起来正常。', tr: 'demo translation', translated: true });
      updateStats();
    }, 900);
  }

  if (location.search.includes('morph=rec')) {
    // 录制用：可反复触发分裂
    window.__demo = {
      stats() {
        segments.push({ seq: 1, time: '00:12', text: '这是演示用的识别内容，用来把实时指标填起来。', tr: '', translated: false });
        segments.push({ seq: 2, time: '00:26', text: '第二段也写点东西，让字数看起来正常。', tr: 'demo translation', translated: true });
        setStatsView('recording');
      },
      backToIdle() { setStatsView('idle'); },
      idle() { setMainState('idle'); const p = btnPause; if (p) p.classList.add('is-collapsed'); },
      split() {
        const act = document.querySelector('.actions');
        if (!act) return;
        act.classList.add('is-dividing');
        setMainState('recording');
        const p = btnPause; if (p) p.classList.remove('is-collapsed');
        const n = btnNotes; if (n) { n.classList.remove('is-ghost'); n.classList.add('is-ready'); }
        spawnSplash(btnMain, 5);
        setTimeout(() => act.classList.remove('is-dividing'), 640);
      },
    };
    setTimeout(() => {
      const act = document.querySelector('.actions');
      if (act) { act.classList.add('is-dividing'); setTimeout(() => act.classList.remove('is-dividing'), 3000); }
      setMainState('recording');
      if (btnPause) btnPause.classList.remove('is-collapsed');
      if (btnNotes) {
        btnNotes.disabled = false;
        btnNotes.classList.remove('is-ghost');
        btnNotes.classList.add('is-ready', 'is-budding');
        setTimeout(() => btnNotes.classList.remove('is-budding'), 4000);
      }
    }, 500);
  }

  if (location.search.includes('selftest=jobstages')) {
    setTimeout(() => {
      const now = Date.now();
      jobs.unshift(
        { id: now + 3, title: '示例课程 A', status: 'running', detail: '整理讲稿和笔记…', ts: now },
        { id: now + 2, title: '示例课程 A', status: 'running', detail: '保存转写稿…', ts: now },
        { id: now + 1, title: '示例课程 B', status: 'running', detail: '补识别 3 段…', ts: now },
      );
      renderJobs();
      const b = document.getElementById('railJobs');
      if (b) b.click();
    }, 500);
  }

  if (location.search.includes('selftest=jobclick')) {
    setTimeout(() => {
      const f = 'D:\\Obsidian\\02-笔记\\课堂笔记-示例课程-2026-01-01-1200.md';
      jobs.unshift({ id: Date.now(), title: '自测 任务卡点击', status: 'done',
        detail: '讲稿和笔记都已生成', ts: Date.now(), notes: f });
      renderJobs();
      const b = document.getElementById('railJobs');
      if (b) b.click();
      setTimeout(() => {
        const card = document.querySelector('.job-card[data-doc]');
        if (card) card.click();
      }, 400);
    }, 500);
  }

  if (location.search.includes('selftest=jobs')) {
    setTimeout(() => { const b = document.getElementById('railJobs'); if (b) b.click(); }, 500);
  }

  if (location.search.includes('selftest=done')) {
    setTimeout(() => notice(pickDoneLine(), 'D:\\\\Obsidian\\\\00-收件箱\\\\_收件箱说明.md', 25000), 600);
  }

  if (location.search.includes('selftest=fallback')) {
    setTimeout(() => {
      const orig = window.fetch;
      window.fetch = (url, opts) => String(url).includes('/api/chatter')
        ? Promise.reject(new Error('forced failure'))
        : orig(url, opts);
      pickChatter().then((r) => { showChatter(r.line); document.title = r.line; });
    }, 600);
  }


  // ------------------------------------------------------------ 视觉自检（qa=1）
  // 把几何与对比度数据写进 #qa-json，供 tools 里的 qa.py 用 --dump-dom 读取
  window.runQa = function runQa() {
    const out = { url: location.href, at: new Date().toISOString(), checks: [] };
    const add = (name, ok, detail, skipped) => out.checks.push({ name, ok: !!ok, detail, skipped: !!skipped });
    const px = (v) => Math.round(v * 10) / 10;
    const rectOf = (el) => (el ? el.getBoundingClientRect() : null);
    const visible = (el) => !!el && el.offsetWidth > 0 && el.offsetHeight > 0
      && getComputedStyle(el).visibility !== 'hidden';

    const overlapArea = (a, b) => {
      if (!a || !b) return 0;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return w > 0 && h > 0 ? w * h : 0;
    };

    const lum = (rgb) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
    };
    const parseRgb = (str) => {
      const m = (str || '').match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const q = m[1].split(/[,/ ]+/).map(Number);
      return { rgb: q.slice(0, 3), a: q.length > 3 ? q[3] : 1 };
    };
    const blend = (fg, bg) => fg.rgb.map((c, i) => c * fg.a + bg.rgb[i] * (1 - fg.a));
    const contrast = (a, b) => {
      const l1 = lum(a), l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    // 1. 主按钮：至少 44×44（触摸友好）
    if (visible(btnMain)) {
      add('主按钮尺寸', btnMain.offsetHeight >= 44 && btnMain.offsetWidth >= 44,
        btnMain.offsetWidth + '×' + btnMain.offsetHeight);
    } else {
      add('主按钮尺寸', true, '不可见，跳过', true);
    }

    // 2. 其他按钮高度不低于 32（shadcn 的标准是 36）
    const small = [];
    document.querySelectorAll('.actions .btn, .actions-row .btn').forEach((el) => {
      if (visible(el) && el.offsetHeight < 32) small.push(el.id || el.className);
    });
    add('次级按钮高度', small.length === 0, small.join(',') || 'ok');

    // 3. 气泡不遮机器人
    const bb = rectOf(botBubble);
    const ball = rectOf($('ballDock'));
    if (visible(botBubble)) {
      add('气泡不遮机器人', overlapArea(bb, ball) === 0, '重叠 ' + px(overlapArea(bb, ball)) + ' px²');
    } else {
      add('气泡不遮机器人', true, '气泡未显示，跳过', true);
    }

    // 4. 生成笔记常驻：始终可见，没有内容时禁用
    if (btnNotes) {
      const style = getComputedStyle(btnNotes);
      const shown = parseFloat(style.opacity) > 0.9
        && style.display !== 'none'
        && btnNotes.getBoundingClientRect().height > 20;
      const state = btnNotes.disabled ? '常驻·禁用' : '常驻·可点';
      add('生成笔记常驻', shown, shown ? state : '不可见');
    }

    // 4b. 补识别必须在状态栏，不在动作区
    const backfill = btnRecover;
    const inHead = backfill && backfill.closest('.stats-head');
    add('补识别在状态栏', !!inHead, inHead ? 'ok' : '位置不对');

    // 5. 主按钮文字对比度（半透明背景先叠到页面上）
    if (visible(btnMain)) {
      const cs = getComputedStyle(btnMain);
      const fg = parseRgb(cs.color);
      const bg = parseRgb(cs.backgroundColor);
      const pageBg = parseRgb(getComputedStyle(document.body).backgroundColor)
        || { rgb: [249, 250, 251], a: 1 };
      if (fg && bg) {
        const solid = blend(bg, pageBg);
        const ratio = contrast(blend(fg, { rgb: solid, a: 1 }), solid);
        add('主按钮文字对比度', ratio >= 4.5, ratio.toFixed(2) + ':1');
      }
    }

    // 6. 横向没有溢出
    const over = document.documentElement.scrollWidth - window.innerWidth;
    add('无横向溢出', over <= 1, '溢出 ' + over + ' px');

    // 7. 文字没有被裁
    const clipped = [];
    document.querySelectorAll('.btn, .seg-info, .kpi-big b').forEach((el) => {
      if (visible(el) && el.scrollWidth > el.clientWidth + 2) clipped.push(el.id || el.className.split(' ')[0]);
    });
    // 主按钮里的标签是刻意用 max-width:0 收起的，只看真正显示时的标签
    const bmLabel = document.querySelector('.btn-main .bm-label');
    if (bmLabel && parseFloat(getComputedStyle(bmLabel).opacity) > 0.5
        && bmLabel.scrollWidth > bmLabel.clientWidth + 2) clipped.push('btnMain-label');
    add('文字未被裁切', clipped.length === 0, clipped.join(',') || 'ok');

    const pre = document.createElement('pre');
    pre.id = 'qa-json';
    pre.style.cssText = 'position:fixed;left:-9999px;top:0;';
    pre.textContent = JSON.stringify(out);
    document.body.appendChild(pre);
    return out;
  };

  // 回归测试钩子：验证「转写区被清空后，静音折叠不能再抛 insertBefore 错误」
  window.__foldTest = (detach) => {
    const node = addSegmentRow('00:99');
    if (detach) node.row.remove();
    try {
      foldSilence(node.x, '00:99');
      return 'ok';
    } catch (e) {
      return 'throw:' + e.message;
    }
  };

  if (location.search.includes('qa=1')) {
    // 把气泡摆出来，几何检查才有东西可量
    setTimeout(() => {
      try { showBubble('视觉自检用的气泡', '', 60000); } catch (_) { /* 忽略 */ }
    }, 800);
  }

  // ------------------------------------------------------------ 自检
  // 一次跑完五项，输出一张结果面板，改动前后对照用
  async function runSelfCheck() {
    const results = [];
    const add = (name, ok, extra) => results.push({ name, ok: !!ok, extra: extra || '' });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    await wait(1200);
    add('脚本错误', !window.__lastError, window.__lastError || '无');

    const ids = ['railLog', 'railJobs', 'jobsPanel', 'histList', 'btnMain', 'ball', 'waveCanvas'];
    const missing = ids.filter((id) => !document.getElementById(id));
    add('关键元素', missing.length === 0, missing.length ? '缺: ' + missing.join(',') : ids.length + '/' + ids.length);

    try {
      notice('自检：气泡显示正常', '', 3000);
      await wait(400);
      // 用布局尺寸，不受动画缩放影响
      const w = botBubble.offsetWidth, h = botBubble.offsetHeight;
      add('气泡显示', w > 60 && h > 20, w + '×' + h);
      hideChatter();
    } catch (e) {
      add('气泡显示', false, e.message);
    }

    try {
      const r1 = botBubble.getBoundingClientRect();
      const ballEl = document.getElementById('ballDock');
      const r2 = ballEl.getBoundingClientRect();
      const overlap = Math.max(0, Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left))
                    * Math.max(0, Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top));
      add('不遮机器人', overlap === 0, overlap ? '重叠 ' + Math.round(overlap) + ' px²' : '无重叠');
    } catch (e) {
      add('不遮机器人', false, e.message);
    }

    try {
      const jb = document.getElementById('railJobs');
      if (jb) jb.click();
      await wait(1400);
      const rows = document.querySelectorAll('#histList .file-row').length;
      add('处理页', rows > 0, '文件 ' + rows + ' 行');
    } catch (e) {
      add('处理页', false, e.message);
    }

    try {
      const first = document.querySelector('#histList .file-row');
      if (!first) throw new Error('列表为空');
      first.click();
      await wait(1200);
      const body = document.getElementById('historyBody');
      const len = ((body && body.textContent) || '').trim().length;
      add('打开文档', len > 50, '正文 ' + len + ' 字');
      const close = document.getElementById('btnCloseHistory');
      if (close) close.click();
    } catch (e) {
      add('打开文档', false, e.message);
    }

    const bad = results.filter((r) => !r.ok).length;
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;left:12px;top:12px;z-index:9999;margin:0;padding:12px 14px;'
      + 'background:#111;color:#7ee787;font:12px/1.7 ui-monospace,Consolas,monospace;'
      + 'border-radius:10px;max-width:560px;white-space:pre-wrap;box-shadow:0 10px 30px rgba(0,0,0,.4)';
    box.textContent = '自检结果  v' + (window.__ver || '?') + '\n'
      + results.map((r) => (r.ok ? '✓ ' : '✗ ') + r.name + '  ' + r.extra).join('\n')
      + '\n' + (bad ? '✗ ' + bad + ' 项失败' : '✓ 全部通过');
    document.body.appendChild(box);
    document.title = bad ? '自检 ' + bad + ' 项失败' : '自检全部通过';
    return results;
  }

  if (location.search.includes('notesdemo=1')) {
    setTimeout(() => {
      lastNotes = [
        '- 主题：人工智能法律治理', '- 主讲：老师', '- 时长：44:45', '- 章节：2 段', '',
        '## 摘要', '本节讨论 AI 治理从要素规制转向内容安全与权利平衡。', '',
        '## 章节速览', '- [00:00] 探讨人工智能在法律治理中的应用', '- [05:25] 人工智能的发展路径与挑战', '- [11:12] 人工智能与人的科学范畴', '',
        '## 一、哲学定位与人机关系重构 [00:00]',
        '- **定义演变**（理论）：从模仿人类思维转向理性思考与行动。',
        '- **交互形态**（现状）：坚持人在环路，AI 只作辅助。',
        '', '## 待办', '- [ ] 读第三章', '', '## 术语', '- **嵌入性**：智能体与环境的耦合程度。',
      ].join('\n');
      lastArticle = '（示例原文）具身智能是不是？家里会不会出现所谓人形形态……';
      // 演示态也给一个真实文件，这样三个导出按钮能真跑通
      fetch('/api/history').then((r) => r.json()).then((d) => {
        const first = (d.items || [])[0];
        if (first) { lastNotesPath = first.path; lastArticlePath = first.path; }
      }).catch(() => {});
      notesModal.classList.remove('hidden');
      showTab('notes');
    }, 700);
  }

  if (location.search.includes('selftest=check')) {
    setTimeout(() => runSelfCheck(), 600);
  }

  if (location.search.includes('selftest=focus')) {
    setTimeout(() => { window.dispatchEvent(new Event('focus')); }, 800);
  }

  if (location.search.includes('selftest=course')) {
    setTimeout(() => { const b = document.getElementById('btnStart'); if (b) b.click(); }, 600);
  }

  if (location.search.includes('selftest=chatter')) {
    setTimeout(() => pickChatter().then(speakIfStateMatches), 700);
    setTimeout(() => pickChatter().then(speakIfStateMatches), 2600);
  }

  if (location.search.includes('selftest=smoke')) {
    setTimeout(async () => {
      const steps = [];
      const step = async (name, fn) => {
        try { await fn(); steps.push('✓ ' + name); }
        catch (e) { steps.push('✗ ' + name + ' → ' + (e && e.message)); }
      };
      await step('切处理页', () => setView('jobs'));
      await step('切历史页', () => setView('history'));
      await step('切记录页', () => setView('log'));
      await step('打开历史', () => openHistory());
      await step('关闭历史', () => $('btnCloseHistory').click());
      await step('打开设置', () => $('btnSettings').click());
      await step('关闭设置', () => $('btnCloseSettings').click());
      await step('切换翻译方向', () => $('dirEn') && $('dirEn').click());
      await step('切回原文', () => $('dirSrc') && $('dirSrc').click());
      await step('暂停跟随', () => $('chkFollow').click());
      await step('恢复跟随', () => $('chkFollow').click());
      await step('恢复会话', () => restoreSession());
      await step('统计刷新', () => updateStats());
      await step('状态灯刷新', () => updateModeChip());
      await step('关键词', () => renderTags());
      await step('处理列表', () => renderJobs());
      await step('保存会话', () => persistSession());
      const box = document.createElement('pre');
      box.style.cssText = 'position:fixed;left:8px;top:70px;z-index:9999;background:#000;color:#4ade80;'
        + 'font:12px/1.6 monospace;padding:10px;border-radius:8px;margin:0;max-height:70vh;overflow:auto';
      box.textContent = steps.join('\n') + '\n\nlastError: ' + (window.__lastError || '-');
      document.body.appendChild(box);
    }, 900);
  }

  if (location.search.includes('selftest=speech')) {
    class FakeCtx2 {
      constructor() {
        this.sampleRate = 16000;
        this.destination = { connect() {}, disconnect() {} };
      }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() {
        const proc = { _cb: null, connect() {}, disconnect() {},
          set onaudioprocess(fn) { this._cb = fn; },
          get onaudioprocess() { return this._cb; } };
        window.__proc = proc;
        return proc;
      }
      createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
      createAnalyser() {
        return { fftSize: 1024, smoothingTimeConstant: 0, frequencyBinCount: 512,
          connect() {}, disconnect() {}, getByteFrequencyData() {} };
      }
      close() {}
    }
    window.AudioContext = FakeCtx2;
    window.webkitAudioContext = FakeCtx2;
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });

    (async () => {
      const res = await fetch('/samples.wav');
      const buf = await res.arrayBuffer();
      const dv = new DataView(buf);
      // 找到 data 块
      let off = 12, dataOff = 0, dataLen = 0;
      while (off + 8 <= dv.byteLength) {
        const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
        const size = dv.getUint32(off + 4, true);
        if (id === 'data') { dataOff = off + 8; dataLen = size; break; }
        off += 8 + size + (size % 2);
      }
      const n = Math.floor(dataLen / 2);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(dataOff + i * 2, true) / 32768;

      setTimeout(() => {
        document.getElementById('btnMain').click();
        let pos = 0;
        const silence = new Float32Array(4096);
        setInterval(() => {
          const proc = window.__proc;
          if (!proc || !proc.onaudioprocess) return;
          let chunk;
          if (pos < pcm.length) {
            chunk = pcm.subarray(pos, Math.min(pos + 4096, pcm.length));
            pos += 4096;
            if (chunk.length < 4096) {
              const padded = new Float32Array(4096);
              padded.set(chunk);
              chunk = padded;
            }
          } else {
            chunk = silence;      // 语音喂完后给静音，触发断句
          }
          proc.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } });
        }, 60);
        // 语音约 8 秒 + 3 秒尾巴，然后收尾
        setTimeout(() => document.getElementById('btnStop').click(), 14000);
      }, 500);
    })();
  }

  if (location.search.includes('selftest=full')) {
    setTimeout(() => { document.getElementById('btnMain').click(); }, 500);
    setTimeout(() => { document.getElementById('btnStop').click(); }, 9000);
  }

  if (location.search.includes('selftest=fakeaudio') || location.search.includes('selftest=full')) {
    class FakeCtx {
      constructor() {
        this.sampleRate = 48000;
        this.state = 'running';
        this.currentTime = 0;
        this.destination = { connect() {}, disconnect() {} };
      }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() {
        const proc = { _cb: null, connect() {}, disconnect() {},
          set onaudioprocess(fn) { this._cb = fn; },
          get onaudioprocess() { return this._cb; } };
        window.__proc = proc;
        return proc;
      }
      createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
      createAnalyser() {
        return { fftSize: 1024, smoothingTimeConstant: 0, frequencyBinCount: 512,
          connect() {}, disconnect() {}, getByteFrequencyData() {} };
      }
      close() {}
    }
    window.AudioContext = FakeCtx;
    window.webkitAudioContext = FakeCtx;
    const fakeStream = { getTracks: () => [{ stop() {} }] };
    navigator.mediaDevices.getUserMedia = async () => fakeStream;

    setTimeout(() => {
      sessionTitle = '自测课';
      document.getElementById('btnMain').click();
      const buf = new Float32Array(4096);
      let tick = 0;
      setInterval(() => {
        const proc = window.__proc;
        if (!proc || !proc.onaudioprocess) return;
        tick++;
        // 2 秒说话、1 秒静音，循环；用不同频率的正弦模拟人声能量
        const speaking = (tick % 35) < 24;
        for (let i = 0; i < buf.length; i++) {
          buf[i] = speaking ? 0.05 * Math.sin((tick * 4096 + i) * 0.05) : 0.0004;
        }
        proc.onaudioprocess({ inputBuffer: { getChannelData: () => buf } });
      }, 85);
    }, 500);
  }

  if (location.search.includes('selftest=mockmic')) {
    setTimeout(() => {
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const dest = ctx.createMediaStreamDestination();
        osc.frequency.value = 220;
        gain.gain.value = 0.35;
        osc.connect(gain); gain.connect(dest); osc.start();
        // 周期性静音，制造「停顿」，让断句逻辑真的触发
        setInterval(() => {
          const t = ctx.currentTime;
          gain.gain.setValueAtTime(0.35, t);
          gain.gain.setValueAtTime(0.0001, t + 2.2);
          gain.gain.setValueAtTime(0.35, t + 3.0);
        }, 3000);
        navigator.mediaDevices.getUserMedia = async () => dest.stream;
        document.getElementById('btnMain').click();
      } catch (e) {
        document.title = 'mockmic failed: ' + e.message;
      }
    }, 600);
  }

  if (location.search.includes('selftest=click')) {
    setTimeout(() => {
      document.getElementById('btnStop').click();
      setTimeout(() => document.getElementById('btnStart').click(), 100);
    }, 500);
  }

  // 诊断面板：地址加 ?diag=1 打开，直接看内部状态，不用猜
  if (location.search.includes('measure=1')) {
    setTimeout(() => {
      const items = [
        ['自动跟随', document.querySelector('.tools-right .switch')],
        ['复制', document.getElementById('btnCopy')],
        ['生成笔记', document.getElementById('btnNotes')],
      ];
      const lines = [];
      items.forEach(([name, el]) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const line = document.createElement('div');
        line.style.cssText = 'position:fixed;height:1px;background:#ff3b30;z-index:9999;'
          + 'left:' + r.left + 'px;width:' + r.width + 'px;top:' + (r.top + r.height / 2) + 'px';
        document.body.appendChild(line);
        lines.push(name + ' top=' + r.top.toFixed(1) + ' h=' + r.height.toFixed(1)
          + ' center=' + (r.top + r.height / 2).toFixed(1));
      });
      const box = document.createElement('pre');
      box.style.cssText = 'position:fixed;right:10px;top:70px;z-index:9999;background:#000;color:#4ade80;'
        + 'font:11px/1.5 monospace;padding:8px;border-radius:6px;margin:0';
      box.textContent = lines.join('\\n');
      document.body.appendChild(box);
    }, 900);
  }

  if (location.search.includes('diag=1')) {
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;margin:0;padding:8px 10px;'
      + 'background:rgba(0,0,0,.82);color:#9fe3b0;font:11px/1.6 ui-monospace,Consolas,monospace;'
      + 'border-radius:8px;max-width:520px;white-space:pre-wrap;pointer-events:none';
    document.body.appendChild(box);
    pollWatchdogForDiag();
    setInterval(() => {
      const rows = document.querySelectorAll('#transcript .seg').length;
      const withText = segments.filter((x) => (x.text || '').trim()).length;
      box.textContent = [
        '按钮        ' + mainState + ' / running=' + running + ' paused=' + paused + ' / ' + (btnMain ? btnMain.dataset.state : '?'),
        '版本       ' + (window.__ver || '?') + ' / 构建 ' + (window.__build || '?'),
        'running    ' + running,
        'segments   ' + segments.length + '（有文字 ' + withText + '）',
        'DOM 行数   ' + rows,
        'inflight   ' + inflight + ' / 队列 ' + fireQueue.length,
        'mode       ' + mode + ' / stored ' + stored.length,
        'notesReady ' + notesReady + ' / toneFollow ' + toneFollow,
        'clock      ' + elClock.textContent + ' / recordedSec ' + recordedSec.toFixed(1),
        'lastErr    ' + (lastRecogErr || '-'),
        '看门狗     ' + (window.__watchdogText || '查询中…'),
        '脚本错误   ' + (window.__lastError || '-'),
        '最近提示   ' + (lastNoticeText || '-'),
        '箭头       ' + (function(){ const a = document.getElementById('bubbleArrow'); if (!a) return '无元素'; const r = a.getBoundingClientRect(); return (a.classList.contains('hidden') ? 'hidden ' : 'shown ') + 'x=' + Math.round(r.left) + ' y=' + Math.round(r.top) + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height); })(),
        '变换       ' + (botBubble ? getComputedStyle(botBubble).transform.slice(0, 90) : '无'),
        '气泡       ' + (botBubble ? ['x='+Math.round(botBubble.offsetLeft),'y='+Math.round(botBubble.offsetTop),'w='+botBubble.offsetWidth,'h='+botBubble.offsetHeight,'cls='+botBubble.className].join(' ') : '无'),
        '闲聊       ' + chatterShown + ' 次 / 上次 ' + (lastChatterAt ? Math.round((Date.now()-lastChatterAt)/1000) + 's 前' : '未说过'),
        'localStore ' + (localStorage.getItem(STORE_KEY) ? '有存档' : '无'),
        '笔记按钮   ' + (btnNotes ? (btnNotes.disabled ? '禁用' : '可用') : '无'),
        '球节点     ' + document.querySelectorAll('#ball svg').length + ' 个 svg / ' + document.querySelectorAll('.ball-dock').length + ' 个 dock',
      ].join('\n');
    }, 500);
  }

  if (location.search.includes('bubbleanim=slow')) document.body.classList.add('slow-bubble');
  if (location.search.includes('bubbleanim=off')) document.body.classList.add('no-anim');
  if (location.search.includes('persp=near')) document.body.classList.add('persp-near-tail');

  const restored = restoreSession();
  updateStats();
  if (!ball) initBall();
  loadConfig();
  if (restored) {
    showBanner(`接回了上次没整理的 ${restored} 段转写稿。可以直接点「生成笔记」，或点「开始听课」开新的一节。`);
    syncNotesButton();
  }

  // 自测用：浏览器带假麦克风时，?selftest=1 直接开录，用来回归验证界面
  if (location.search.includes('selftest=1')) {
    setTimeout(() => { start(); }, 400);
  }
})();
