const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, globalShortcut, clipboard, session, shell, desktopCapturer, protocol, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const config = require('./lib/config');
const { streamAnswer } = require('./lib/llm');
const { isQuestion } = require('./lib/question');
const updater = require('./lib/updater');
const harness = require('./test/harness');

app.disableHardwareAcceleration();

protocol.registerSchemesAsPrivileged([
  { scheme: 'ghostit', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

const AUTH_URL = process.env.GHOSTIT_AUTH_URL || 'https://ghostqa-bot.fog-map-concept.workers.dev';
app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
app.commandLine.appendSwitch('allow-http-screen-capture');

const SMOKE = process.argv.includes('--smoke');
const UITEST = process.argv.includes('--uitest');
const DOMTEST = process.argv.includes('--domtest');
const E2ETEST = process.argv.includes('--e2etest');
const UPDATETEST = process.argv.includes('--updatetest');
const AUDIOTEST = process.argv.includes('--audiotest');

let win = null;
let tray = null;
let quitting = false;
let recording = false;
let hotkeyMode = 'hold';
let worker = null;
let msgId = 0;
let recordingTimer = null;
const pending = new Map();
let history = [];
let currentAbort = null;
let mockPrompt = null;
let mockPrevHistory = null;

function buildMockPrompt(topic) {
  const role = topic || 'Middle QA Engineer';
  return 'Ты — доброжелательный, но требовательный интервьюер на позицию: ' + role + ' (IT-собеседование, русский язык). ' +
    'Формат строго: одно сообщение = РОВНО ОДИН вопрос, без прелюдий и без перечисления будущих тем. ' +
    'После ответа кандидата: 1–2 предложения оценки (что сильно, чего не хватило), при необходимости краткий эталон ответа (3–6 пунктов), затем следующий вопрос чуть сложнее. ' +
    'Если кандидат ответил «не знаю» — дай компактный эталон и следующий вопрос по другой теме. ' +
    'Темы двигай от базы к специализации и практическим задачам. Пиши коротко: ответ интервьюера максимум 60 слов. ' +
    'Начни с одной фразы приветствия и первого вопроса.';
}
let uiohookRef = null;
let talkHandlers = null;

function log(...args) {
  console.log('[ghostit]', ...args);
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function sendStatus(state, text) {
  sendToRenderer('status', { state, text });
}

function prettyCombo(combo) {
  return String(combo || '')
    .split(/[+\s]+/)
    .filter(Boolean)
    .map((part) => {
      const low = part.toLowerCase();
      if (low === 'ctrl' || low === 'control') return 'Ctrl';
      if (low === 'shift') return 'Shift';
      if (low === 'alt') return 'Alt';
      if (low === 'space') return 'Space';
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('+');
}

function idleText() {
  const cfg = config.load();
  const mode = hotkeyMode || cfg.hotkey.mode || 'hold';
  const auto = !!(cfg.autoListen && cfg.autoListen.enabled);
  if (auto) return 'Готов. 👂 Слушаю в фоне — задай вопрос голосом';
  if (mode === 'hold') return 'Готов. Зажми ' + prettyCombo(cfg.hotkey.combo) + ' и задай вопрос';
  if (mode === 'toggle') return 'Готов. Нажми ' + prettyCombo(cfg.hotkey.combo) + ' — говори, нажми ещё раз';
  return 'Готов';
}

function setupProtocol() {
  const rootDir = path.join(__dirname, 'renderer');
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.json': 'application/json'
  };
  protocol.handle('ghostit', async (request) => {
    try {
      const urlPath = decodeURIComponent(new URL(request.url).pathname);
      const relative = urlPath === '/' || urlPath === '' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const filePath = path.normalize(path.join(rootDir, relative));
      const relCheck = path.relative(rootDir, filePath);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        return new Response('forbidden', { status: 403 });
      }
      const data = await fs.promises.readFile(filePath);
      return new Response(data, {
        headers: { 'Content-Type': mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream' }
      });
    } catch {
      return new Response('bad request', { status: 400 });
    }
  });
}

function createWindow() {
  const cfg = config.load();
  const area = screen.getPrimaryDisplay().workArea;
  const width = 500;
  const height = 440;
  let x = area.x + area.width - width - 24;
  let y = area.y + area.height - height - 24;
  if (Number.isFinite(cfg.ui.x) && Number.isFinite(cfg.ui.y)) {
    const onVisible = screen.getAllDisplays().some((display) => {
      const a = display.workArea;
      return (
        cfg.ui.x >= a.x - width + 120 &&
        cfg.ui.x <= a.x + a.width - 120 &&
        cfg.ui.y >= a.y - 60 &&
        cfg.ui.y <= a.y + a.height - 80
      );
    });
    if (onVisible) {
      x = cfg.ui.x;
      y = cfg.ui.y;
    }
  }

  win = new BrowserWindow({
    width,
    height,
    minWidth: 360,
    minHeight: 240,
    x,
    y,
    frame: false,
    transparent: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#14171f',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  if (typeof win.setVisibleOnAllWorkspaces === 'function') {
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  }
  win.setOpacity(cfg.ui.opacity);
  win.setContentProtection(cfg.ui.protectCapture === true);
  if (cfg.ui.clickThrough) win.setIgnoreMouseEvents(true, { forward: true });

  win.loadURL('ghostit://app/index.html');

  let moveTimer = null;
  win.on('move', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [wx, wy] = win.getPosition();
      config.save({ ui: { x: wx, y: wy } });
    }, 500);
  });

  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.webContents.on('did-finish-load', () => {
    sendToRenderer('config-updated', config.load());
    sendToRenderer('auto-listen', !!(config.load().autoListen && config.load().autoListen.enabled));
    sendToRenderer('history-count', Math.floor(history.length / 2));
    sendStatus('idle', idleText());
  });

  win.once('ready-to-show', () => {
    win.showInactive();
  });
}

function createTrayIcon() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  try {
    if (fs.existsSync(iconPath)) {
      const image = nativeImage.createFromPath(iconPath);
      if (!image.isEmpty()) return image.resize({ width: 32, height: 32 });
    }
  } catch {}
  const size = 32;
  const buffer = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size / 2 - 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - center, y - center);
      const index = (y * size + x) * 4;
      if (distance <= radius) {
        const glow = 1 - distance / radius;
        buffer[index] = 138;
        buffer[index + 1] = 92 + Math.round(60 * glow);
        buffer[index + 2] = 246;
        buffer[index + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('GhostIT — ассистент на собеседовании');
  const rebuildMenu = () => {
    const cfg = config.load();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Показать / скрыть', accelerator: 'Ctrl+Shift+H', click: () => toggleWindow() },
      { label: 'Настройки', click: () => { showWindow(); sendToRenderer('open-settings'); } },
      { type: 'separator' },
      { label: 'Автослушание', type: 'checkbox', checked: !!(cfg.autoListen && cfg.autoListen.enabled), click: (item) => setAutoListen(item.checked) },
      { label: 'Клик сквозь окно', type: 'checkbox', checked: cfg.ui.clickThrough, click: (item) => setClickThrough(item.checked) },
      { label: 'Скрывать от записи экрана', type: 'checkbox', checked: cfg.ui.protectCapture === true, click: (item) => applyProtection(item.checked) },
      { type: 'separator' },
      { label: 'Выход', click: () => { quitting = true; app.quit(); } }
    ]));
  };
  rebuildMenu();
  tray.on('click', () => toggleWindow());
  tray.rebuildMenu = rebuildMenu;
}

function applyProtection(enabled) {
  config.save({ ui: { protectCapture: !!enabled } });
  if (win && !win.isDestroyed()) win.setContentProtection(!!enabled);
  if (tray && tray.rebuildMenu) tray.rebuildMenu();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else showWindow();
}

function showWindow() {
  if (!win) return;
  win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver');
}

function setClickThrough(value) {
  config.save({ ui: { clickThrough: !!value } });
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!value, { forward: true });
  if (tray && tray.rebuildMenu) tray.rebuildMenu();
  sendToRenderer('config-updated', config.load());
}

function setAutoListen(enabled) {
  config.save({ autoListen: { enabled: !!enabled } });
  sendToRenderer('auto-listen', !!enabled);
  if (tray && tray.rebuildMenu) tray.rebuildMenu();
  sendStatus('idle', idleText());
}

function syncAutoFromConfig(cfg) {
  const mode = cfg.hotkey.mode || 'hold';
  const wantAuto = mode === 'auto' || mode === 'hold+auto' ? true : !!(cfg.autoListen && cfg.autoListen.enabled);
  if (!!(cfg.autoListen && cfg.autoListen.enabled) !== wantAuto) {
    config.save({ autoListen: { enabled: wantAuto } });
  }
  sendToRenderer('auto-listen', wantAuto);
}

function startListening() {
  if (recording) return;
  recording = true;
  sendToRenderer('recording', true);
  clearTimeout(recordingTimer);
  recordingTimer = setTimeout(() => stopListening(), 60000);
}

function stopListening() {
  if (!recording) return;
  recording = false;
  clearTimeout(recordingTimer);
  sendToRenderer('recording', false);
}

function toggleRecording() {
  if (recording) stopListening();
  else startListening();
}

function toggleAuto() {
  const cfg = config.load();
  setAutoListen(!(cfg.autoListen && cfg.autoListen.enabled));
}

function comboToAccelerator(combo) {
  const parts = String(combo || '').toLowerCase().split(/[+\s]+/).filter(Boolean);
  const modNames = { ctrl: 'CommandOrControl', control: 'CommandOrControl', shift: 'Shift', alt: 'Alt' };
  const keyNames = { space: 'Space', enter: 'Return', tab: 'Tab', escape: 'Escape', backspace: 'Backspace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right' };
  let accel = '';
  let trigger = '';
  for (const part of parts) {
    if (modNames[part]) accel += modNames[part] + '+';
    else if (keyNames[part]) trigger = keyNames[part];
    else if (/^[a-z]$/.test(part)) trigger = part.toUpperCase();
    else if (/^[0-9]$/.test(part)) trigger = part;
    else if (/^f([0-9]{1,2})$/i.test(part)) trigger = 'F' + part.slice(1).toUpperCase();
    else trigger = part.toUpperCase();
  }
  if (!trigger) return null;
  if (!accel) accel = 'CommandOrControl+';
  return accel + trigger;
}

function clearTalkHandlers() {
  if (talkHandlers && uiohookRef && uiohookRef.uIOhook) {
    uiohookRef.uIOhook.removeListener('keydown', talkHandlers.onDown);
    uiohookRef.uIOhook.removeListener('keyup', talkHandlers.onUp);
  }
  talkHandlers = null;
  globalShortcut.unregisterAll();
}

function registerTalkHotkey(behavior) {
  const cfg = config.load();
  const combo = cfg.hotkey.combo;

  try {
    const uiohook = require('uiohook-napi');
    uiohookRef = uiohook;
    const { UiohookKey } = uiohook;
    const MOD_CODES = {
      ctrl: [UiohookKey.Ctrl, UiohookKey.CtrlRight],
      shift: [UiohookKey.Shift, UiohookKey.ShiftRight],
      alt: [UiohookKey.Alt, UiohookKey.AltRight]
    };
    const isMod = (code) => Object.values(MOD_CODES).some((arr) => arr.includes(code));
    const keyMap = {};
    for (const name of Object.keys(UiohookKey)) keyMap[name.toLowerCase()] = UiohookKey[name];

    const parts = String(combo).toLowerCase().split(/[+\s]+/).filter(Boolean);
    const mods = { ctrl: false, shift: false, alt: false };
    let trigger = null;
    for (const part of parts) {
      if (part === 'ctrl' || part === 'control') mods.ctrl = true;
      else if (part === 'shift') mods.shift = true;
      else if (part === 'alt' || part === 'option') mods.alt = true;
      else {
        const code = keyMap[part] != null ? keyMap[part] : keyMap['num' + part];
        if (code != null && !isMod(code)) trigger = code;
      }
    }
    if (trigger == null) {
      log('combo parse failed, fallback to ctrl+shift+space: ' + combo);
      trigger = UiohookKey.Space;
      mods.ctrl = true;
      mods.shift = true;
    }

    const heldMods = { ctrl: false, shift: false, alt: false };
    const modsOk = () =>
      (!mods.ctrl || heldMods.ctrl) && (!mods.shift || heldMods.shift) && (!mods.alt || heldMods.alt);
    const track = (code, value) => {
      for (const [m, arr] of Object.entries(MOD_CODES)) if (arr.includes(code)) heldMods[m] = value;
    };

    const onDown = (event) => {
      if (!event || event.keycode == null) return;
      track(event.keycode, true);
      if (event.keycode !== trigger || !modsOk()) return;
      if (behavior === 'hold') startListening();
      else if (behavior === 'toggle-rec') toggleRecording();
      else if (behavior === 'toggle-auto') toggleAuto();
    };
    const onUp = (event) => {
      if (!event || event.keycode == null) return;
      track(event.keycode, false);
      if (behavior === 'hold' && (event.keycode === trigger || isMod(event.keycode))) stopListening();
    };

    uiohook.uIOhook.on('keydown', onDown);
    uiohook.uIOhook.on('keyup', onUp);
    talkHandlers = { onDown, onUp };
    try { uiohook.uIOhook.start(); } catch {}
    log('talk hotkey registered via uiohook: ' + combo + ' (' + behavior + ')');
    return;
  } catch (error) {
    log('uiohook unavailable:', error.message);
  }

  const accel = comboToAccelerator(combo);
  if (accel) {
    globalShortcut.register(accel, () => {
      if (behavior === 'hold') { if (!recording) startListening(); }
      else if (behavior === 'toggle-rec') toggleRecording();
      else if (behavior === 'toggle-auto') toggleAuto();
    });
    log('talk hotkey registered via globalShortcut: ' + accel);
  }
}

function setupHotkeys() {
  clearTalkHandlers();
  const cfg = config.load();
  const mode = cfg.hotkey.mode || 'hold';
  let behavior = 'toggle-rec';
  if (mode === 'hold' || mode === 'hold+auto') behavior = 'hold';
  else if (mode === 'auto') behavior = 'toggle-auto';
  registerTalkHotkey(behavior);
  globalShortcut.register('CommandOrControl+Shift+H', () => toggleWindow());
  globalShortcut.register('CommandOrControl+Shift+K', () => {
    const current = config.load();
    setClickThrough(!current.ui.clickThrough);
  });
  hotkeyMode = mode;
  log('hotkeys: mode=' + mode + ' combo=' + cfg.hotkey.combo);
}

function ensureWorker() {
  if (worker && !worker.killed) return worker;
  worker = spawn(process.execPath, [path.join(__dirname, 'worker', 'stt.js')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MODEL_CACHE_DIR: path.join(app.getPath('userData'), 'models')
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  let buffer = '';
  worker.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handleWorkerMessage(line);
    }
  });
  worker.stderr.on('data', (chunk) => log('stt:', chunk.toString('utf8').trim()));
  worker.on('exit', (code) => {
    log('stt worker exited:', code);
    worker = null;
    for (const [id, item] of pending) {
      item.reject(new Error('Процесс распознавания остановился'));
      pending.delete(id);
    }
  });

  return worker;
}

function handleWorkerMessage(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.type === 'progress' && message.data) {
    const data = message.data;
    if (data.status === 'progress' && data.file) {
      const percent = data.total ? Math.round((data.loaded / data.total) * 100) : 0;
      sendStatus('transcribe', `⬇️ Загружаю модель: ${data.file} — ${percent}%`);
    }
    return;
  }

  if (message.type === 'download-progress') {
    sendStatus('transcribe', `⬇️ Скачиваю модель с ModelScope: ${message.file} — ${message.percent}%`);
    return;
  }

  if (message.type === 'loaded' && !message.id) {
    return;
  }

  if (message.type === 'fatal') {
    sendStatus('error', `Ошибка распознавания: ${message.message}`);
    return;
  }

  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.type === 'result') item.resolve(message.text);
  else if (message.type === 'error') item.reject(new Error(message.message));
  else item.resolve(message);
}

const CALL_TIMEOUTS = {
  ping: 30000,
  check: 30000,
  load: 30 * 60 * 1000,
  transcribe: 5 * 60 * 1000
};

function workerCall(type, payload) {
  ensureWorker();
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const { audio, ...rest } = payload || {};
    const header = { id, type, ...rest };
    let line = JSON.stringify(header);
    let binary = null;
    if (audio instanceof Float32Array) {
      header.audioBytes = audio.byteLength;
      line = JSON.stringify(header);
      binary = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
    }
    worker.stdin.write(line + '\n');
    if (binary) worker.stdin.write(binary);
    const timeoutMs = CALL_TIMEOUTS[type] || 180000;
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('Таймаут распознавания'));
      }
    }, timeoutMs);
  });
}

async function transcribe(pcm) {
  const cfg = config.load();
  const result = await workerCall('transcribe', {
    audio: pcm,
    model: cfg.whisper.model,
    language: cfg.whisper.language,
    cacheDir: path.join(app.getPath('userData'), 'models')
  });
  return result;
}

async function ask(question) {
  const cfg = config.load();
  if (!cfg.api.apiKey) {
    sendStatus('error', 'Нет API-ключа — открой настройки (⚙) и вставь ключ');
    return null;
  }

  if (currentAbort) currentAbort.abort();
  const abort = new AbortController();
  currentAbort = abort;

  sendStatus('thinking', '💭 Думаю…');
  let firstChunk = true;
  try {
    const answer = await streamAnswer({
      baseUrl: cfg.api.baseUrl,
      apiKey: cfg.api.apiKey,
      model: cfg.api.model,
      temperature: cfg.api.temperature,
      maxTokens: cfg.api.maxTokens,
      systemPrompt: mockPrompt || cfg.prompt,
      history,
      question,
      signal: abort.signal
    }, {
      onDelta: (delta) => {
        if (firstChunk) {
          firstChunk = false;
          sendStatus('streaming', '✍️ Отвечаю…');
        }
        sendToRenderer('answer-chunk', delta);
      },
      onDone: () => {}
    });

    history.push({ role: 'user', content: question });
    history.push({ role: 'assistant', content: answer });
    if (history.length > 60) history = history.slice(-60);
    saveHistory();
    sendToRenderer('history-count', Math.floor(history.length / 2));

    sendToRenderer('answer-done', answer);
    sendStatus('idle', idleText());
    return answer;
  } catch (error) {
    if (error.name === 'AbortError') {
      sendToRenderer('answer-done', null);
      sendStatus('idle', 'Остановлено');
      return null;
    }
    sendStatus('error', `Ошибка: ${error.message}`);
    sendToRenderer('answer-error', error.message);
    return null;
  } finally {
    if (currentAbort === abort) currentAbort = null;
  }
}

function historyFile() {
  return path.join(app.getPath('userData'), 'history.json');
}

function loadHistory() {
  try {
    const raw = fs.readFileSync(historyFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.slice(-60);
  } catch {}
  return [];
}

function saveHistory() {
  try {
    fs.writeFileSync(historyFile(), JSON.stringify(history.slice(-60)), 'utf8');
  } catch {}
}

function registerIpc() {
  ipcMain.handle('get-config', () => config.load());

  ipcMain.handle('tg-auth-start', async () => {
    try {
      const os = require('os');
      const res = await fetch(AUTH_URL + '/v1/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: os.hostname() })
      });
      if (!res.ok) throw new Error('auth http ' + res.status);
      return await res.json();
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('tg-auth-poll', async (event, sid) => {
    try {
      const res = await fetch(AUTH_URL + '/v1/session/' + encodeURIComponent(String(sid || '')));
      if (!res.ok) throw new Error('poll http ' + res.status);
      return await res.json();
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('tg-auth-me', async () => {
    try {
      const cfg = config.load();
      if (!cfg.api.apiKey) return { error: 'no key' };
      const res = await fetch(AUTH_URL + '/v1/me', {
        headers: { Authorization: 'Bearer ' + cfg.api.apiKey }
      });
      if (!res.ok) throw new Error('me http ' + res.status);
      return await res.json();
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('tg-unlink', async () => {
    const cfg = config.load();
    const key = cfg.api.apiKey || '';
    let serverRevoked = true;
    try {
      const res = await fetch(AUTH_URL + '/v1/me', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok && res.status !== 401 && res.status !== 404) serverRevoked = false;
    } catch {
      serverRevoked = false;
    }
    const updated = config.save({ api: { baseUrl: '', apiKey: '', model: '' } });
    sendToRenderer('config-updated', updated);
    log('TG_UNLINK serverRevoked=' + serverRevoked);
    return { ok: true, serverRevoked };
  });

  ipcMain.handle('save-config', (event, patch) => {
    const updated = config.save(patch);
    if (win && !win.isDestroyed()) {
      win.setOpacity(updated.ui.opacity);
      win.setContentProtection(updated.ui.protectCapture === true);
    }
    if (tray && tray.rebuildMenu) tray.rebuildMenu();
    setupHotkeys();
    syncAutoFromConfig(updated);
    sendToRenderer('config-updated', updated);
    return updated;
  });

ipcMain.handle('transcribe', async (event, pcm, options) => {
    try {
      sendStatus('transcribe', '⏳ Распознаю речь…');
      const text = await transcribe(pcm);
      if (!text) {
        sendStatus('idle', idleText());
        return { text: '', asked: false };
      }
      const isAuto = !!(options && options.auto);
      if (isAuto && !isQuestion(text)) {
        sendToRenderer('auto-skipped', text);
        sendStatus('idle', idleText());
        return { text, asked: false };
      }
      sendToRenderer('question', text);
      ask(text);
      return { text, asked: true };
    } catch (error) {
      sendStatus('error', `Ошибка распознавания: ${error.message}`);
      return { text: '', asked: false };
    }
  });

  ipcMain.handle('mock-toggle', (event, topic) => {
    if (mockPrompt) {
      mockPrompt = null;
      if (mockPrevHistory) { history = mockPrevHistory; mockPrevHistory = null; }
      sendToRenderer('mock-state', { active: false });
      sendStatus('idle', idleText());
      return { active: false };
    }
    const cleanTopic = String(topic || '').trim().slice(0, 120);
    mockPrevHistory = history;
    history = [];
    mockPrompt = buildMockPrompt(cleanTopic);
    sendToRenderer('history-count', 0);
    sendToRenderer('mock-state', { active: true, topic: cleanTopic });
    ask('Начинай: одна фраза приветствия и первый вопрос.');
    return { active: true, topic: cleanTopic };
  });

  ipcMain.handle('ask-text', (event, text) => {
    const question = String(text || '').trim();
    if (!question) return null;
    sendToRenderer('question', question);
    ask(question);
    return question;
  });

  ipcMain.handle('stop-answer', () => {
    if (currentAbort) currentAbort.abort();
    return true;
  });

  ipcMain.handle('copy-text', (event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  ipcMain.handle('hide-overlay', () => {
    if (win && !win.isDestroyed()) win.hide();
    return true;
  });

  ipcMain.handle('set-click-through', (event, value) => {
    setClickThrough(value);
    return true;
  });

  ipcMain.handle('show-overlay', () => {
    showWindow();
    return true;
  });

  ipcMain.handle('quit', () => {
    quitting = true;
    app.quit();
    return true;
  });

  ipcMain.handle('update-check', async () => {
    try {
      const info = await updater.checkLatest(app.getVersion());
      return { ok: true, current: app.getVersion(), ...info };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('update-download', async (event, url, digest) => {
    const dest = path.join(app.getPath('temp'), 'GhostIT-new.exe');
    try {
      await updater.downloadUpdate(url, dest, (percent) => {
        sendToRenderer('update-progress', { phase: 'download', percent });
      }, digest);
      sendToRenderer('update-progress', { phase: 'done' });
      return { ok: true, file: dest };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('update-install', () => {
    const dest = path.join(app.getPath('temp'), 'GhostIT-new.exe');
    if (!fs.existsSync(dest)) return { ok: false, error: 'Скачанный файл не найден' };
    if (!process.env.PORTABLE_EXECUTABLE_FILE) {
      shell.openExternal(updater.RELEASES_PAGE);
      return { ok: false, fallback: 'open-page', error: 'Открыта страница релизов — скачайте установщик' };
    }
    updater.installUpdate(dest);
    quitting = true;
    setTimeout(() => app.exit(0), 500);
    return { ok: true };
  });

  ipcMain.handle('open-external', (event, url) => {
    if (/^https:\/\//i.test(String(url))) shell.openExternal(url);
    return true;
  });

  ipcMain.handle('hotkey-mode', () => hotkeyMode);

  ipcMain.handle('toggle-recording', () => {
    toggleRecording();
    return recording;
  });

  ipcMain.handle('toggle-auto', () => {
    toggleAuto();
    return !!(config.load().autoListen && config.load().autoListen.enabled);
  });

  ipcMain.handle('download-model', async () => {
    const cfg = config.load();
    try {
      await workerCall('load', {
        model: cfg.whisper.model,
        cacheDir: path.join(app.getPath('userData'), 'models')
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('get-history', () => ({
    count: Math.floor(history.length / 2),
    file: historyFile()
  }));

  ipcMain.handle('get-history-items', () => history.slice(-60));

  ipcMain.handle('clear-history', () => {
    history = [];
    saveHistory();
    sendToRenderer('history-count', 0);
    return true;
  });

  ipcMain.handle('export-history', async () => {
    const lines = [];
    lines.push('GhostIT — история сессии');
    lines.push('Сохранено: ' + new Date().toLocaleString('ru-RU'));
    lines.push('');
    const turns = Math.floor(history.length / 2);
    for (let i = 0; i < turns; i++) {
      lines.push('Вопрос ' + (i + 1) + ':');
      lines.push(history[i * 2].content);
      lines.push('Ответ:');
      lines.push(history[i * 2 + 1].content);
      lines.push('');
    }
    const documents = app.getPath('documents');
    const defaultFile = path.join(documents, 'GhostIT-история.txt');
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Сохранить историю',
      defaultPath: defaultFile,
      filters: [{ name: 'Текст', extensions: ['txt'] }]
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    return filePath;
  });
}

function cleanupStaleUpdateFiles() {
  const candidates = ['GhostIT-new.exe', 'GhostIT-new.exe.part', 'ghostit-update-helper.js', 'ghostit-update.log'];
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const name of candidates) {
    const p = path.join(app.getPath('temp'), name);
    try {
      if (fs.existsSync(p) && fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {}
  }
}

async function boot() {
  app.setAppUserModelId('GhostIT');
  const legacy = config.migrateLegacy();
  if (legacy.migrated.length || legacy.removed.length) log('LEGACY_MIGRATE ' + JSON.stringify(legacy));
  const cfg = config.load();
  history = loadHistory();
  setupProtocol();
  createWindow();
  createTray();
  setupHotkeys();
  registerIpc();
  syncAutoFromConfig(cfg);

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture');
  });

  cleanupStaleUpdateFiles();

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 }
      });
      if (sources.length) callback({ video: sources[0], audio: 'loopback' });
      else callback({});
    } catch (error) {
      log('displayMediaRequestHandler failed:', error.message);
      callback({});
    }
  }, { useSystemPicker: false });

  setTimeout(async () => {
    try {
      const info = await updater.checkLatest(app.getVersion());
      if (info.hasUpdate) {
        sendToRenderer('update-available', { current: app.getVersion(), ...info });
      }
    } catch {}
  }, 6000);

  const exitApp = () => { quitting = true; app.exit(0); };
  const modelsDir = path.join(app.getPath('userData'), 'models');

  if (SMOKE) harness.runSmoke({ win, hotkeyMode, modelsDir, config, workerCall, log, exitApp });

  if (E2ETEST) {
    win.webContents.once('did-finish-load', () => setTimeout(() => harness.runE2E({ win, config, sendToRenderer, log, exitApp }), 400));
  }

  if (AUDIOTEST) harness.runAudioTest({ win, log, exitApp });

  if (DOMTEST) harness.runDomTest({ win, log, exitApp });

  if (UPDATETEST) {
    win.webContents.once('did-finish-load', () => harness.runUpdateTest({ win, updater, sendToRenderer, log, exitApp }));
  }

  if (UITEST) harness.runUiTest({ win, sendToRenderer, log, exitApp });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(boot);
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (worker && !worker.killed) worker.kill();
  });
}