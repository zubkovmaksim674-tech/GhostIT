const qEl = document.getElementById('question');
const answerEl = document.getElementById('answer');
const answerText = document.getElementById('answer-text');
const answerCursor = document.getElementById('answer-cursor');
const statusDot = document.getElementById('status-dot');
const sessionDot = document.getElementById('session-dot');
const statusText = document.getElementById('status-text');
const actionsEl = document.getElementById('answer-actions');
const settingsEl = document.getElementById('settings');
const historyEl = document.getElementById('history');
const modeBadge = document.getElementById('mode-badge');
const holdBtn = document.getElementById('btn-hold');
const recordBtn = document.getElementById('btn-record');
const waveBtn = document.getElementById('btn-wave');
const waveBars = Array.from(document.querySelectorAll('#wave-bars .waveform-bar'));

let config = null;
let answerFull = '';
let recording = false;
let clickThrough = false;
let autoOn = false;

const waveLevels = new Array(waveBars.length).fill(3);

function pushWave(level) {
  waveLevels.shift();
  waveLevels.push(Math.max(3, Math.min(18, 3 + level * 60)));
  for (let i = 0; i < waveBars.length; i++) waveBars[i].style.height = waveLevels[i] + 'px';
}

function resetWave() {
  for (let i = 0; i < waveBars.length; i++) {
    waveLevels[i] = 3;
    waveBars[i].style.height = '3px';
  }
}

const rec = {
  active: false,
  ctx: null,
  source: null,
  node: null,
  stream: null,
  chunks: [],
  len: 0,
  startedAt: 0
};

const vad = {
  active: false,
  ctx: null,
  source: null,
  node: null,
  stream: null,
  tail: [],
  tailSamples: 0,
  energies: [],
  speechActive: false,
  speechStartPos: 0,
  lastSpeechMs: 0,
  threshold: 0.02,
  silenceMs: 1300,
  minSpeechMs: 700,
  busy: false,
  pending: null,
  suppressUntil: 0
};

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderAnswer(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<span class="b">$1</span>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  return html;
}

function setStatus(state, text) {
  statusDot.className = 'status-indicator';
  if (state === 'rec') {
    statusDot.classList.add('rec');
    waveBtn.classList.add('session-active', 'recording');
    recordBtn.classList.add('active');
    recordBtn.textContent = '⏸';
    sessionDot.classList.add('active');
  } else if (state === 'auto') {
    statusDot.classList.add('auto');
    waveBtn.classList.add('session-active');
    waveBtn.classList.remove('recording');
    recordBtn.classList.remove('active');
    recordBtn.textContent = '▶';
    sessionDot.classList.add('active');
  } else {
    if (state === 'err') statusDot.classList.add('err');
    else if (state === 'busy' || state === 'transcribe') statusDot.classList.add('transcribe');
    else if (state === 'thinking' || state === 'streaming') statusDot.classList.add('streaming');
    else if (state === 'ok') statusDot.classList.add('ok');
    else statusDot.classList.add('idle');
    if (!recording) {
      waveBtn.classList.remove('session-active', 'recording');
      recordBtn.classList.remove('active');
      recordBtn.textContent = '▶';
      sessionDot.classList.remove('active');
      resetWave();
    }
  }
  statusText.textContent = text;
}

function autoIdleText() {
  return '👂 Слушаю в фоне — задай вопрос голосом (или напиши внизу)';
}

function showQuestion(text) {
  qEl.textContent = '❓ ' + text;
  qEl.classList.remove('hidden');
}

function resetAnswer() {
  if (streamTimer) {
    clearTimeout(streamTimer);
    streamTimer = null;
  }
  streamBuffer = '';
  answerFull = '';
  answerText.classList.add('placeholder');
  answerText.textContent = '…';
  answerCursor.classList.add('hidden');
  actionsEl.classList.add('hidden');
}

let streamBuffer = '';
let streamTimer = null;

function flushStream() {
  streamTimer = null;
  if (!streamBuffer) return;
  answerFull += streamBuffer;
  streamBuffer = '';
  answerText.classList.remove('placeholder');
  answerText.innerHTML = renderAnswer(answerFull);
  answerCursor.classList.remove('hidden');
  answerEl.scrollTop = answerEl.scrollHeight;
}

function appendAnswer(delta) {
  if (!delta) return;
  streamBuffer += delta;
  if (!streamTimer) {
    streamTimer = setTimeout(flushStream, 90);
  }
}

function flushStreamNow() {
  if (streamTimer) {
    clearTimeout(streamTimer);
    streamTimer = null;
  }
  flushStream();
}

function finishAnswer() {
  flushStreamNow();
  answerCursor.classList.add('hidden');
  actionsEl.classList.remove('hidden');
  if (config && config.ui && config.ui.tts && answerFull) speak(answerFull);
}

function clearAll() {
  flushStreamNow();
  answerFull = '';
  qEl.classList.add('hidden');
  answerText.classList.add('placeholder');
  answerText.textContent = 'Зажми Ctrl+Shift+Space и задай вопрос голосом — ответ появится здесь. Либо напиши вопрос в поле ниже.';
  answerCursor.classList.add('hidden');
  actionsEl.classList.add('hidden');
}

function concatChunks(chunks, length) {
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function resample(data, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.max(1, Math.round(data.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, data.length - 1);
    const frac = pos - i0;
    out[i] = data[i0] * (1 - frac) + data[i1] * frac;
  }
  return out;
}

function rms(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

function suppressMs() {
  return (config && config.autoListen && config.autoListen.suppressMs) || 15000;
}

function sendSegment(pcm) {
  const inRate = vad.ctx.sampleRate;
  const pcm16 = inRate === 16000 ? pcm : resample(pcm, inRate, 16000);
  vad.busy = true;
  setStatus('transcribe', '⏳ Распознаю речь…');
  window.ghost.transcribe(pcm16, { auto: true }).then((res) => {
    const text = res && res.text;
    if (res && res.asked) {
      vad.suppressUntil = Date.now() + suppressMs();
    } else if (res && res.asked === false && autoOn) {
      setStatus('idle', '🔇 Не вопрос — пропущен');
      setTimeout(() => { if (autoOn && !recording) setStatus('auto', autoIdleText()); }, 1400);
    } else if (!text) {
      if (!autoOn) setStatus('idle', 'Не расслышал — попробуй ещё раз');
    }
  }).catch(() => {
    if (!autoOn) setStatus('idle', 'Не расслышал — попробуй ещё раз');
  }).finally(() => {
    vad.busy = false;
    flushPendingSegment();
  });
}

function flushPendingSegment() {
  if (vad.pending && !vad.busy) {
    const next = vad.pending;
    vad.pending = null;
    sendSegment(next);
  }
}

async function openAudioStream(listenSource) {
  if (listenSource === 'system') {
    // видео-трек держим (1 fps) — если его остановить, Chromium рвёт и audio loopback-сессию
    return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: true });
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
}

async function startRecording() {
  if (rec.active) return;
  try {
    const stream = await openAudioStream('mic');
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(8192, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;

    rec.stream = stream;
    rec.ctx = ctx;
    rec.source = source;
    rec.node = node;
    rec.chunks = [];
    rec.len = 0;
    rec.active = true;
    rec.startedAt = Date.now();
    recording = true;
    vad.paused = true;

    node.onaudioprocess = (event) => {
      if (!rec.active) return;
      const data = event.inputBuffer.getChannelData(0);
      rec.chunks.push(new Float32Array(data));
      rec.len += data.length;
      pushWave(Math.min(1, rms(data) * 12));
      if (Date.now() - rec.startedAt > 60000) stopRecording();
    };

    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    setStatus('rec', '🔴 Слушаю… Отпусти клавишу, когда закончишь');
  } catch (error) {
    setStatus('err', 'Нет доступа к микрофону: ' + error.message);
  }
}

async function stopRecording() {
  if (!rec.active) return;
  rec.active = false;
  recording = false;
  vad.paused = false;
  const inRate = rec.ctx.sampleRate;
  try {
    rec.node.disconnect();
    rec.source.disconnect();
  } catch {}
  rec.stream.getTracks().forEach((track) => track.stop());
  try { await rec.ctx.close(); } catch {}

  const raw = concatChunks(rec.chunks, rec.len);
  rec.chunks = [];
  rec.len = 0;

  if (raw.length < inRate * 0.35) {
    if (!autoOn) setStatus('idle', 'Слишком коротко — повтори вопрос');
    return;
  }

  const pcm16 = inRate === 16000 ? raw : resample(raw, inRate, 16000);
  setStatus('busy', '⏳ Распознаю речь…');
  vad.suppressUntil = 0;
  try {
    const res = await window.ghost.transcribe(pcm16);
    const text = res && res.text;
    if (!text && !autoOn) setStatus('idle', 'Не расслышал — попробуй ещё раз');
  } catch {
    if (!autoOn) setStatus('idle', 'Не расслышал — попробуй ещё раз');
  }
}

async function startAutoListen() {
  if (vad.active) return;
  const listenSource = (config && config.audio && config.audio.listenSource) || 'system';
  try {
    const stream = await openAudioStream(listenSource);
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(8192, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;

    vad.ctx = ctx;
    vad.source = source;
    vad.node = node;
    vad.stream = stream;
    vad.tail = [];
    vad.tailSamples = 0;
    vad.energies = [];
    vad.speechActive = false;
    vad.speechStartPos = 0;
    vad.threshold = thresholdFromConfig();

    node.onaudioprocess = (event) => {
      if (!vad.active || recording) return;
      if (Date.now() < vad.suppressUntil) return;
      const data = event.inputBuffer.getChannelData(0);
      vad.tail.push(new Float32Array(data));
      vad.tailSamples += data.length;

      const maxTail = Math.floor(ctx.sampleRate * 8);
      while (vad.tailSamples > maxTail) {
        vad.tailSamples -= vad.tail[0].length;
        vad.tail.shift();
      }

      const energy = rms(data);
      pushWave(vad.speechActive ? Math.min(1, energy * 10) : Math.min(1, energy * 4));
      vad.energies.push(energy);
      if (vad.energies.length > 90) vad.energies.shift();

      let thr = vad.threshold;
      vad.floorTick = (vad.floorTick || 0) + 1;
      if (vad.floorTick % 8 === 0) {
        const sorted = [...vad.energies].sort((a, b) => a - b);
        const floor = sorted[Math.floor(sorted.length * 0.25)] || 0;
        thr = Math.max(vad.threshold, floor * 2.2);
        vad.currentThr = thr;
      } else if (vad.currentThr !== undefined) {
        thr = vad.currentThr;
      }
      const speechNow = energy > thr;
      const now = performance.now();

      if (!vad.speechActive && speechNow) {
        vad.speechActive = true;
        vad.speechStartPos = Math.max(0, vad.tail.length - 3);
        vad.lastSpeechMs = now;
      } else if (vad.speechActive && speechNow) {
        vad.lastSpeechMs = now;
      } else if (vad.speechActive && !speechNow) {
        if (now - vad.lastSpeechMs >= vad.silenceMs) finalizeSegment();
      }
    };

    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    vad.active = true;
    setStatus('auto', autoIdleText());
  } catch (error) {
    setStatus('err', 'Автослушание: ' + error.message);
  }
}

function thresholdFromConfig() {
  const sensitivity = config && config.autoListen ? config.autoListen.sensitivity : 35;
  return (sensitivity / 100) * 0.06;
}

function finalizeSegment() {
  const endPos = vad.tail.length;
  const from = Math.min(vad.speechStartPos, endPos);
  let samples = 0;
  for (let i = from; i < endPos; i++) samples += vad.tail[i].length;
  vad.speechActive = false;

  if (samples < vad.ctx.sampleRate * (vad.minSpeechMs / 1000)) return;

  const pcm = new Float32Array(samples);
  let offset = 0;
  for (let i = from; i < endPos; i++) {
    pcm.set(vad.tail[i], offset);
    offset += vad.tail[i].length;
  }
  vad.tail = vad.tail.slice(endPos);
  vad.tailSamples = vad.tail.reduce((sum, chunk) => sum + chunk.length, 0);

  if (vad.busy) {
    vad.pending = pcm;
    return;
  }
  sendSegment(pcm);
}

async function stopAutoListen() {
  if (!vad.active) return;
  vad.active = false;
  try {
    vad.node.disconnect();
    vad.source.disconnect();
  } catch {}
  if (vad.stream) vad.stream.getTracks().forEach((track) => track.stop());
  try { if (vad.ctx) await vad.ctx.close(); } catch {}
  vad.tail = [];
  vad.tailSamples = 0;
  vad.energies = [];
  vad.speechActive = false;
  vad.busy = false;
  vad.pending = null;
}

function applyAutoState() {
  const shouldBeOn = autoOn;
  if (shouldBeOn && !vad.active) startAutoListen();
  if (!shouldBeOn && vad.active) stopAutoListen();
}

function speak(text) {
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const lang = config && config.whisper && config.whisper.language === 'ru' ? 'ru-RU' : 'en-US';
    utterance.lang = lang;
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  } catch {}
}

function fillSettings() {
  if (!config) return;
  document.getElementById('s-baseurl').value = config.api.baseUrl || '';
  document.getElementById('s-apikey').value = config.api.apiKey || '';
  document.getElementById('s-model').value = config.api.model || '';
  document.getElementById('s-prompt').value = config.prompt || '';
  document.getElementById('s-mode').value = config.hotkey.mode || 'hold';
  document.getElementById('s-combo').value = config.hotkey.combo || 'ctrl+shift+space';
  document.getElementById('s-whisper').value = config.whisper.model || 'Xenova/whisper-small';
  document.getElementById('s-lang').value = config.whisper.language || 'ru';
  document.getElementById('s-listen').value = (config.audio && config.audio.listenSource) || 'system';
  document.getElementById('s-tts').checked = !!(config.ui && config.ui.tts);
  document.getElementById('s-protect').checked = config.ui.protectCapture === true;
  document.getElementById('s-auto').checked = autoOn;
  document.getElementById('s-sens').value = (config.autoListen && config.autoListen.sensitivity) || 35;
  document.getElementById('s-opacity').value = Math.round((config.ui.opacity || 0.95) * 100);
}

function openSettings() {
  fillSettings();
  settingsEl.classList.remove('hidden');
  historyEl.classList.add('hidden');
}

function closeSettings() {
  settingsEl.classList.add('hidden');
}

async function saveSettings() {
  const opacity = Math.max(50, Math.min(100, Number(document.getElementById('s-opacity').value) || 95)) / 100;
  const sensitivity = Math.max(5, Math.min(90, Number(document.getElementById('s-sens').value) || 35));
  const prevListen = (config && config.audio && config.audio.listenSource) || 'system';
  const patch = {
    api: {
      baseUrl: document.getElementById('s-baseurl').value.trim(),
      apiKey: document.getElementById('s-apikey').value.trim(),
      model: document.getElementById('s-model').value.trim()
    },
    whisper: {
      model: document.getElementById('s-whisper').value,
      language: document.getElementById('s-lang').value
    },
    audio: {
      listenSource: document.getElementById('s-listen').value
    },
    hotkey: {
      mode: document.getElementById('s-mode').value,
      combo: document.getElementById('s-combo').value.trim() || 'ctrl+shift+space'
    },
    autoListen: {
      enabled: document.getElementById('s-auto').checked,
      sensitivity
    },
    ui: {
      tts: document.getElementById('s-tts').checked,
      protectCapture: document.getElementById('s-protect').checked,
      opacity
    },
    prompt: document.getElementById('s-prompt').value.trim()
  };
  config = await window.ghost.saveConfig(patch);
  updateModeBadge();
  closeSettings();
  setStatus('ok', 'Настройки сохранены');
  if (vad.active && config.audio.listenSource !== prevListen) {
    await stopAutoListen();
    startAutoListen();
  }
  setTimeout(() => setStatus('idle', autoOn ? autoIdleText() : 'Готов'), 1600);
}

function openHistory() {
  settingsEl.classList.add('hidden');
  historyEl.classList.remove('hidden');
  refreshHistory();
}

function closeHistory() {
  historyEl.classList.add('hidden');
}

async function refreshHistory() {
  const items = await window.ghost.getHistoryItems();
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  const turns = Math.floor(items.length / 2);
  for (let i = turns - 1; i >= 0; i--) {
    const q = items[i * 2].content;
    const a = items[i * 2 + 1].content;
    const div = document.createElement('div');
    div.className = 'hist-item';
    const qDiv = document.createElement('div');
    qDiv.className = 'q';
    qDiv.textContent = '❓ ' + q;
    const aDiv = document.createElement('div');
    aDiv.className = 'a';
    aDiv.innerHTML = renderAnswer(a);
    div.appendChild(qDiv);
    div.appendChild(aDiv);
    list.appendChild(div);
  }
  if (turns === 0) list.innerHTML = '<div class="muted small">Пока пусто. Задай вопрос — история появится здесь.</div>';
}

async function updateModeBadge() {
  const m = await window.ghost.hotkeyMode();
  const label = {
    hold: 'hold',
    toggle: 'toggle',
    auto: 'автослушание',
    'hold+auto': 'hold+авто'
  }[m] || m;
  if (modeBadge) {
    modeBadge.textContent = label;
    modeBadge.classList.remove('hidden');
  }
}

document.getElementById('btn-record').addEventListener('click', () => window.ghost.toggleRecording());

document.getElementById('btn-hold').addEventListener('click', async () => {
  const enabled = await window.ghost.toggleAuto();
  setAutoUi(enabled);
});

document.getElementById('btn-history').addEventListener('click', openHistory);
document.getElementById('btn-pin').addEventListener('click', async () => {
  clickThrough = !clickThrough;
  await window.ghost.setClickThrough(clickThrough);
  applyClickThroughUi();
});
document.getElementById('btn-hide').addEventListener('click', () => window.ghost.hide());
document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('btn-settings-close').addEventListener('click', closeSettings);
document.getElementById('btn-save').addEventListener('click', saveSettings);
document.getElementById('btn-copy').addEventListener('click', () => window.ghost.copy(answerFull));
document.getElementById('btn-context').addEventListener('click', async () => {
  await window.ghost.clearHistory();
  setStatus('ok', 'Контекст очищен');
  setTimeout(() => setStatus('idle', autoOn ? autoIdleText() : 'Готов'), 1400);
});
document.getElementById('btn-clear').addEventListener('click', clearAll);
document.getElementById('btn-stop').addEventListener('click', () => window.ghost.stop());
document.getElementById('btn-send').addEventListener('click', sendManual);
document.getElementById('manual-q').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendManual();
});
document.getElementById('btn-mock').addEventListener('click', async () => {
  const input = document.getElementById('manual-q');
  const btn = document.getElementById('btn-mock');
  if (btn.classList.contains('on')) {
    await window.ghost.mockToggle('');
    return;
  }
  const topic = input.value.trim();
  input.value = '';
  const r = await window.ghost.mockToggle(topic);
  if (r && r.active) {
    input.placeholder = 'Ответ на вопрос интервьюера:';
    setStatus('auto', '🎓 Мок-интервью: слушаю и отвечаю по ходу');
  }
});
window.ghost.on('mock-state', (state) => {
  const btn = document.getElementById('btn-mock');
  btn.classList.toggle('on', !!state.active);
  document.getElementById('manual-q').placeholder = state.active ? 'Ответ на вопрос интервьюера:' : 'Вопрос или тема:';
});
document.getElementById('btn-dl-model').addEventListener('click', async () => {
  setStatus('busy', '⬇️ Скачиваю модель Whisper… Это займёт несколько минут');
  const result = await window.ghost.downloadModel();
  if (result.ok) {
    setStatus('ok', 'Модель готова!');
    setTimeout(() => setStatus('idle', autoOn ? autoIdleText() : 'Готов'), 1800);
  } else {
    setStatus('err', 'Ошибка скачивания: ' + result.message);
  }
});

const PROXY_BASE_URL = 'https://ghostqa-proxy.fog-map-concept.workers.dev/v1';
const tgAuth = { timer: null };

function stopTgAuthPoll() {
  if (tgAuth.timer) clearInterval(tgAuth.timer);
  tgAuth.timer = null;
}

async function startTgAuth() {
  const state = document.getElementById('tg-auth-state');
  const box = document.getElementById('tg-auth-box');
  const qrEl = document.getElementById('tg-qr');
  stopTgAuthPoll();
  state.textContent = 'создаю сессию…';
  const s = await window.ghost.tgAuthStart();
  if (s.error) {
    state.textContent = 'ошибка: ' + s.error;
    return;
  }
  box.classList.remove('hidden');
  qrEl.innerHTML = '';
  new QRCode(qrEl, { text: s.qr, width: 170, height: 170, correctLevel: QRCode.CorrectLevel.M });
  document.getElementById('tg-auth-code').textContent = 'или нажми «🤝 Подключить GhostIT» в боте, код: ' + s.code;
  state.textContent = 'ожидание Telegram…';
  const t0 = Date.now();
  tgAuth.timer = setInterval(async () => {
    const p = await window.ghost.tgAuthPoll(s.sid);
    if (p.error) return;
    if (Date.now() - t0 > 9 * 60 * 1000) {
      stopTgAuthPoll();
      state.textContent = 'время вышло — нажми ещё раз';
      return;
    }
    if (p.status === 'linked' && p.token) {
      stopTgAuthPoll();
      config = await window.ghost.saveConfig({
        api: { baseUrl: PROXY_BASE_URL, apiKey: p.token, model: 'groq' }
      });
      fillSettings();
      state.textContent = '✅ подключено, тариф: ' + (p.plan || 'demo');
      box.classList.add('hidden');
      setStatus('ok', 'Telegram-аккаунт привязан');
      setTimeout(() => setStatus('idle', autoOn ? autoIdleText() : 'Готов'), 2000);
    }
  }, 2500);
}

document.getElementById('btn-tg-auth').addEventListener('click', startTgAuth);
document.getElementById('btn-hist-close').addEventListener('click', closeHistory);
document.getElementById('btn-hist-clear').addEventListener('click', async () => {
  await window.ghost.clearHistory();
  refreshHistory();
});
document.getElementById('btn-hist-export').addEventListener('click', async () => {
  const file = await window.ghost.exportHistory();
  if (file) setStatus('ok', 'История сохранена: ' + file);
});

function setAutoUi(enabled) {
  autoOn = enabled;
  holdBtn.classList.toggle('on', enabled);
  holdBtn.title = enabled ? 'Автослушание ВКЛ' : 'Автослушание';
  applyAutoState();
  if (enabled) setStatus('auto', autoIdleText());
}

async function sendManual() {
  const input = document.getElementById('manual-q');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  resetAnswer();
  await window.ghost.askText(text);
}

window.ghost.on('status', (payload) => {
  if (!payload || !payload.state || !payload.text) return;
  if (payload.state === 'idle' && autoOn) {
    setStatus('auto', autoIdleText());
    return;
  }
  setStatus(payload.state, payload.text);
});

window.ghost.on('recording', (active) => {
  if (active) startRecording();
  else stopRecording();
});

window.ghost.on('auto-listen', (enabled) => {
  setAutoUi(!!enabled);
});

window.ghost.on('question', (text) => {
  if (text) {
    resetAnswer();
    showQuestion(text);
  }
});

window.ghost.on('answer-chunk', (delta) => {
  if (delta) appendAnswer(delta);
});

window.ghost.on('answer-done', () => {
  if (answerFull) finishAnswer();
  flushPendingSegment();
  if (!autoOn) setStatus('idle', 'Готов');
});

window.ghost.on('answer-error', (message) => {
  vad.busy = false;
  flushPendingSegment();
  if (message) setStatus('err', 'Ошибка: ' + message);
});

window.ghost.on('open-settings', openSettings);

const updateBar = document.getElementById('update-bar');
const updateText = document.getElementById('update-text');
const btnUpdate = document.getElementById('btn-update');
const updateVersionEl = document.getElementById('update-version');
const updateInfoEl = document.getElementById('update-info');
const btnCheckUpdate = document.getElementById('btn-check-update');

let updateInfoData = null;
let updatePhase = 'idle';

function fmtSize(bytes) {
  if (!bytes) return '';
  return (bytes / 1048576).toFixed(0) + ' МБ';
}

function showUpdateBar(info) {
  updateInfoData = info;
  updatePhase = 'idle';
  updateText.textContent = 'Доступно обновление: v' + info.version + ' (' + fmtSize(info.size) + ')';
  btnUpdate.textContent = 'Обновить';
  btnUpdate.disabled = false;
  updateBar.classList.remove('hidden');
  if (updateInfoEl) updateInfoEl.textContent = 'Доступна новая версия v' + info.version + ' — нажми «Обновить».';
}

async function startUpdateDownload() {
  if (!updateInfoData || updatePhase !== 'idle') return;
  updatePhase = 'downloading';
  btnUpdate.textContent = '…';
  btnUpdate.disabled = true;
  const result = await window.ghost.downloadUpdate(updateInfoData.url, updateInfoData.digest);
  if (!result || !result.ok) {
    updatePhase = 'idle';
    btnUpdate.textContent = 'Обновить';
    btnUpdate.disabled = false;
    updateText.textContent = 'Ошибка скачивания: ' + (result && result.error || 'неизвестно');
  }
}

window.ghost.on('update-progress', (payload) => {
  if (!payload) return;
  if (payload.phase === 'download') {
    updateText.textContent = 'Скачиваю обновление… ' + payload.percent + '%';
  } else if (payload.phase === 'done') {
    updatePhase = 'ready';
    updateText.textContent = 'Обновление v' + updateInfoData.version + ' скачано — приложение перезапустится';
    btnUpdate.textContent = 'Перезапустить';
    btnUpdate.disabled = false;
  }
});

btnUpdate.addEventListener('click', async () => {
  if (updatePhase === 'idle') {
    startUpdateDownload();
  } else if (updatePhase === 'ready') {
    const res = await window.ghost.installUpdate();
    if (res && !res.ok) {
      updateText.textContent = res.error || 'Не удалось установить обновление';
      btnUpdate.textContent = res.fallback === 'open-page' ? 'На странице релизов' : 'Показать файл';
      updatePhase = 'show';
    }
  } else if (updatePhase === 'show') {
    window.ghost.installUpdate();
  }
});

async function manualCheckUpdate() {
  if (!btnCheckUpdate) return;
  updateInfoEl.textContent = 'Проверяю…';
  const res = await window.ghost.checkUpdate();
  if (!res.ok) {
    updateInfoEl.textContent = 'Не удалось проверить: ' + res.error;
    return;
  }
  updateVersionEl.textContent = 'Текущая версия: v' + res.current;
  if (res.hasUpdate) {
    showUpdateBar(res);
  } else {
    updateInfoEl.textContent = 'Уже установлена актуальная версия v' + res.current + '.';
  }
}
if (btnCheckUpdate) btnCheckUpdate.addEventListener('click', manualCheckUpdate);

window.ghost.on('update-available', (info) => {
  if (updateVersionEl) updateVersionEl.textContent = 'Текущая версия: v' + info.current;
  showUpdateBar(info);
});

window.ghost.on('history-count', (count) => {
  const el = document.getElementById('history-count');
  if (el) el.textContent = count + ' вопросов';
});

function applyClickThroughUi() {
  const pin = document.getElementById('btn-pin');
  if (pin) {
    pin.title = clickThrough ? 'Клик сквозь окно ВКЛ (Ctrl+Shift+K)' : 'Клик сквозь окно (Ctrl+Shift+K)';
    pin.style.opacity = clickThrough ? '0.5' : '1';
  }
  const hint = document.getElementById('clickthrough-hint');
  if (hint) hint.classList.toggle('hidden', !clickThrough);
}

window.ghost.on('config-updated', (cfg) => {
  config = cfg;
  clickThrough = !!(cfg.ui && cfg.ui.clickThrough);
  applyClickThroughUi();
  if (vad.active || autoOn) {
    vad.threshold = thresholdFromConfig();
    vad.silenceMs = (cfg.autoListen && cfg.autoListen.silenceMs) || 1300;
    vad.minSpeechMs = (cfg.autoListen && cfg.autoListen.minSpeechMs) || 700;
  }
});

async function init() {
  config = await window.ghost.getConfig();
  autoOn = !!(config.autoListen && config.autoListen.enabled);
  vad.threshold = thresholdFromConfig();
  vad.silenceMs = (config.autoListen && config.autoListen.silenceMs) || 1300;
  vad.minSpeechMs = (config.autoListen && config.autoListen.minSpeechMs) || 700;
  await updateModeBadge();
  clickThrough = !!(config.ui && config.ui.clickThrough);
  applyClickThroughUi();
  setAutoUi(autoOn);
  setStatus('idle', autoOn ? autoIdleText() : 'Готов');
}

init();