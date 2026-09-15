const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, globalShortcut, clipboard, session, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const config = require('./lib/config');
const { streamAnswer } = require('./lib/llm');
const updater = require('./lib/updater');

app.disableHardwareAcceleration();
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
let server = null;
let quitting = false;
let recording = false;
let hotkeyMode = 'hold';
let worker = null;
let workerReady = false;
let msgId = 0;
let recordingTimer = null;
const pending = new Map();
let history = [];
let currentAbort = null;
let uiohookRef = null;
let talkHandlers = null;

function log(...args) {
  console.log('[ghostqa]', ...args);
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
  if (auto) return 'Р“РѕС‚РѕРІ. рџ‘‚ РЎР»СѓС€Р°СЋ РІ С„РѕРЅРµ вЂ” Р·Р°РґР°Р№ РІРѕРїСЂРѕСЃ РіРѕР»РѕСЃРѕРј';
  if (mode === 'hold') return 'Р“РѕС‚РѕРІ. Р—Р°Р¶РјРё ' + prettyCombo(cfg.hotkey.combo) + ' Рё Р·Р°РґР°Р№ РІРѕРїСЂРѕСЃ';
  if (mode === 'toggle') return 'Р“РѕС‚РѕРІ. РќР°Р¶РјРё ' + prettyCombo(cfg.hotkey.combo) + ' вЂ” РіРѕРІРѕСЂРё, РЅР°Р¶РјРё РµС‰С‘ СЂР°Р·';
  return 'Р“РѕС‚РѕРІ';
}

function startServer() {
  return new Promise((resolve, reject) => {
    const rootDir = path.join(__dirname, 'renderer');
    server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const filePath = path.join(rootDir, relative);
      if (!filePath.startsWith(rootDir)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      fs.readFile(filePath, (error, data) => {
        if (error) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const mime = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png'
        }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function createWindow(port) {
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
  win.setContentProtection(cfg.ui.protectCapture !== false);
  if (cfg.ui.clickThrough) win.setIgnoreMouseEvents(true, { forward: true });

  win.loadURL(`http://127.0.0.1:${port}/index.html`);

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
  tray.setToolTip('GhostQA вЂ” Р°СЃСЃРёСЃС‚РµРЅС‚ РЅР° СЃРѕР±РµСЃРµРґРѕРІР°РЅРёРё');
  const rebuildMenu = () => {
    const cfg = config.load();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'РџРѕРєР°Р·Р°С‚СЊ / СЃРєСЂС‹С‚СЊ', accelerator: 'Ctrl+Shift+H', click: () => toggleWindow() },
      { label: 'РќР°СЃС‚СЂРѕР№РєРё', click: () => { showWindow(); sendToRenderer('open-settings'); } },
      { type: 'separator' },
      { label: 'РђРІС‚РѕСЃР»СѓС€Р°РЅРёРµ', type: 'checkbox', checked: !!(cfg.autoListen && cfg.autoListen.enabled), click: (item) => setAutoListen(item.checked) },
      { label: 'РљР»РёРє СЃРєРІРѕР·СЊ РѕРєРЅРѕ', type: 'checkbox', checked: cfg.ui.clickThrough, click: (item) => setClickThrough(item.checked) },
      { label: 'РЎРєСЂС‹РІР°С‚СЊ РѕС‚ Р·Р°РїРёСЃРё СЌРєСЂР°РЅР°', type: 'checkbox', checked: cfg.ui.protectCapture !== false, click: (item) => applyProtection(item.checked) },
      { type: 'separator' },
      { label: 'Р’С‹С…РѕРґ', click: () => { quitting = true; app.quit(); } }
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
  const cfg = config.load();
  workerReady = false;
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
    workerReady = false;
    for (const [id, item] of pending) {
      item.reject(new Error('РџСЂРѕС†РµСЃСЃ СЂР°СЃРїРѕР·РЅР°РІР°РЅРёСЏ РѕСЃС‚Р°РЅРѕРІРёР»СЃСЏ'));
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
      sendStatus('transcribe', `в¬‡пёЏ Р—Р°РіСЂСѓР¶Р°СЋ РјРѕРґРµР»СЊ: ${data.file} вЂ” ${percent}%`);
    }
    return;
  }

  if (message.type === 'download-progress') {
    sendStatus('transcribe', `в¬‡пёЏ РЎРєР°С‡РёРІР°СЋ РјРѕРґРµР»СЊ СЃ ModelScope: ${message.file} вЂ” ${message.percent}%`);
    return;
  }

  if (message.type === 'loaded' && !message.id) {
    workerReady = true;
    return;
  }

  if (message.type === 'fatal') {
    sendStatus('error', `РћС€РёР±РєР° СЂР°СЃРїРѕР·РЅР°РІР°РЅРёСЏ: ${message.message}`);
    return;
  }

  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.type === 'result') item.resolve(message.text);
  else if (message.type === 'error') item.reject(new Error(message.message));
  else item.resolve(message);
}

function workerCall(type, payload) {
  ensureWorker();
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.stdin.write(JSON.stringify({ id, type, ...payload }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('РўР°Р№РјР°СѓС‚ СЂР°СЃРїРѕР·РЅР°РІР°РЅРёСЏ'));
      }
    }, 180000);
  });
}

async function transcribe(pcm) {
  const cfg = config.load();
  const result = await workerCall('transcribe', {
    audio: Array.from(pcm),
    model: cfg.whisper.model,
    language: cfg.whisper.language,
    cacheDir: path.join(app.getPath('userData'), 'models')
  });
  return result;
}

async function ask(question) {
  const cfg = config.load();
  if (!cfg.api.apiKey) {
    sendStatus('error', 'РќРµС‚ API-РєР»СЋС‡Р° вЂ” РѕС‚РєСЂРѕР№ РЅР°СЃС‚СЂРѕР№РєРё (вљ™) Рё РІСЃС‚Р°РІСЊ РєР»СЋС‡');
    return null;
  }

  if (currentAbort) currentAbort.abort();
  const abort = new AbortController();
  currentAbort = abort;

  sendStatus('thinking', 'рџ’­ Р”СѓРјР°СЋвЂ¦');
  let firstChunk = true;
  try {
    const answer = await streamAnswer({
      baseUrl: cfg.api.baseUrl,
      apiKey: cfg.api.apiKey,
      model: cfg.api.model,
      temperature: cfg.api.temperature,
      maxTokens: cfg.api.maxTokens,
      systemPrompt: cfg.prompt,
      history,
      question,
      signal: abort.signal
    }, {
      onDelta: (delta) => {
        if (firstChunk) {
          firstChunk = false;
          sendStatus('streaming', 'вњЌпёЏ РћС‚РІРµС‡Р°СЋвЂ¦');
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
      sendStatus('idle', 'РћСЃС‚Р°РЅРѕРІР»РµРЅРѕ');
      return null;
    }
    sendStatus('error', `РћС€РёР±РєР°: ${error.message}`);
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

  ipcMain.handle('save-config', (event, patch) => {
    const updated = config.save(patch);
    if (win && !win.isDestroyed()) {
      win.setOpacity(updated.ui.opacity);
      win.setContentProtection(updated.ui.protectCapture !== false);
    }
    if (tray && tray.rebuildMenu) tray.rebuildMenu();
    setupHotkeys();
    syncAutoFromConfig(updated);
    sendToRenderer('config-updated', updated);
    return updated;
  });

  ipcMain.handle('transcribe', async (event, pcm) => {
    try {
      sendStatus('transcribe', 'вЏі Р Р°СЃРїРѕР·РЅР°СЋ СЂРµС‡СЊвЂ¦');
      const text = await transcribe(pcm);
      if (!text) {
        sendStatus('idle', idleText());
        return null;
      }
      sendToRenderer('question', text);
      ask(text);
      return text;
    } catch (error) {
      sendStatus('error', `РћС€РёР±РєР° СЂР°СЃРїРѕР·РЅР°РІР°РЅРёСЏ: ${error.message}`);
      return null;
    }
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

  ipcMain.handle('update-download', async (event, url) => {
    const dest = path.join(app.getPath('temp'), 'GhostQA-new.exe');
    try {
      await updater.downloadUpdate(url, dest, (percent) => {
        sendToRenderer('update-progress', { phase: 'download', percent });
      });
      sendToRenderer('update-progress', { phase: 'done' });
      return { ok: true, file: dest };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('update-install', () => {
    const dest = path.join(app.getPath('temp'), 'GhostQA-new.exe');
    if (!fs.existsSync(dest)) return { ok: false, error: 'РЎРєР°С‡Р°РЅРЅС‹Р№ С„Р°Р№Р» РЅРµ РЅР°Р№РґРµРЅ' };
    if (!process.env.PORTABLE_EXECUTABLE_FILE) {
      shell.showItemInFolder(dest);
      return { ok: false, error: 'РђРІС‚РѕР·Р°РјРµРЅР° РґРѕСЃС‚СѓРїРЅР° С‚РѕР»СЊРєРѕ РІ portable-СЃР±РѕСЂРєРµ' };
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

  ipcMain.handle('get-history-items', () => history.slice(-40));

  ipcMain.handle('clear-history', () => {
    history = [];
    saveHistory();
    sendToRenderer('history-count', 0);
    return true;
  });

  ipcMain.handle('export-history', () => {
    const lines = [];
    lines.push('GhostQA вЂ” РёСЃС‚РѕСЂРёСЏ СЃРµСЃСЃРёРё');
    lines.push('РЎРѕС…СЂР°РЅРµРЅРѕ: ' + new Date().toLocaleString('ru-RU'));
    lines.push('');
    const turns = Math.floor(history.length / 2);
    for (let i = 0; i < turns; i++) {
      lines.push('Р’РѕРїСЂРѕСЃ ' + (i + 1) + ':');
      lines.push(history[i * 2].content);
      lines.push('РћС‚РІРµС‚:');
      lines.push(history[i * 2 + 1].content);
      lines.push('');
    }
    const documents = app.getPath('documents');
    const file = path.join(documents, 'GhostQA-РёСЃС‚РѕСЂРёСЏ.txt');
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    return file;
  });
}

function startFakeLLM() {
  return new Promise((resolve) => {
    const fake = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (req.url.includes('/chat/completions')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const parts = [
            'REST вЂ” СЌС‚Рѕ Р°СЂС…РёС‚РµРєС‚СѓСЂРЅС‹Р№ СЃС‚РёР»СЊ РґР»СЏ РїРѕСЃС‚СЂРѕРµРЅРёСЏ API, Р° РЅРµ РїСЂРѕС‚РѕРєРѕР».',
            'РћСЃРЅРѕРІРЅС‹Рµ РїСЂРёРЅС†РёРїС‹: РєР»РёРµРЅС‚-СЃРµСЂРІРµСЂ, stateless, РєСЌС€РёСЂСѓРµРјРѕСЃС‚СЊ, РµРґРёРЅРѕРѕР±СЂР°Р·РЅС‹Р№ РёРЅС‚РµСЂС„РµР№СЃ.',
            'Р”Р°РЅРЅС‹Рµ РѕР±С‹С‡РЅРѕ РїРµСЂРµРґР°СЋС‚СЃСЏ РІ С„РѕСЂРјР°С‚Рµ JSON.'
          ];
          const chunks = [];
          for (const part of parts) {
            for (let i = 0; i < part.length; i += 12) chunks.push(part.slice(i, i + 12));
          }
          let index = 0;
          const timer = setInterval(() => {
            if (index >= chunks.length) {
              clearInterval(timer);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[index] } }] })}\n\n`);
            index++;
          }, 15);
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    fake.listen(0, '127.0.0.1', () => resolve(fake.address().port));
  });
}

async function runE2E() {
  const original = config.load();
  const fakePort = await startFakeLLM();
  config.save({ api: { baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: 'fake' } });
  sendToRenderer('config-updated', config.load());
  await new Promise((resolve) => setTimeout(resolve, 600));
  try {
    const result = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.ghost.askText('Р§С‚Рѕ С‚Р°РєРѕРµ REST?');
      await sleep(3500);
      return {
        answer: document.getElementById('answer').textContent.slice(0, 400),
        question: document.getElementById('question').textContent,
        status: document.getElementById('status-text').textContent,
        hasCopyButton: !document.getElementById('answer-actions').classList.contains('hidden')
      };
    })()`);
    log('E2E_RESULT ' + JSON.stringify(result));
  } catch (error) {
    log('E2E_FAIL ' + error.message);
  } finally {
    config.save(original);
    quitting = true;
    app.exit(0);
  }
}

async function boot() {
  app.setAppUserModelId('GhostQA');
  const cfg = config.load();
  history = loadHistory();
  const port = await startServer();
  createWindow(port);
  createTray();
  setupHotkeys();
  registerIpc();
  syncAutoFromConfig(cfg);

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture');
  });

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

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .then((sources) => {
        if (sources.length) callback({ video: sources[0], audio: 'loopback' });
        else callback({});
      })
      .catch(() => callback({}));
  });

  setTimeout(async () => {
    try {
      const info = await updater.checkLatest(app.getVersion());
      if (info.hasUpdate) {
        sendToRenderer('update-available', { current: app.getVersion(), ...info });
      }
    } catch {}
  }, 6000);

  if (SMOKE) {
    setTimeout(async () => {
      const results = { hotkeyMode, windowCreated: !!win, workerPing: false, transformers: null, configPath: config.filePath() };
      try {
        await workerCall('ping', {});
        results.workerPing = true;
      } catch (error) {
        results.workerPing = String(error.message);
      }
      try {
        const check = await workerCall('check', {});
        results.transformers = JSON.stringify(check);
      } catch (error) {
        results.transformers = String(error.message);
      }
      if (process.env.SMOKE_FULL === '1') {
        try {
          const localConfig = config.load();
          await workerCall('load', { model: localConfig.whisper.model, cacheDir: path.join(app.getPath('userData'), 'models') });
          results.modelLoaded = true;
        } catch (error) {
          results.modelLoaded = String(error.message);
        }
      }
      log('SMOKE_RESULT ' + JSON.stringify(results));
      try {
        fs.writeFileSync(path.join(require('os').tmpdir(), 'ghostqa-smoke.json'), JSON.stringify(results));
      } catch {}
      quitting = true;
      app.exit(0);
    }, 4000);
  }

  if (E2ETEST) {
    win.webContents.once('did-finish-load', () => setTimeout(runE2E, 400));
  }

  if (AUDIOTEST) {
    win.webContents.on('render-process-gone', (event, details) => log('RENDERER_GONE', JSON.stringify(details)));
    win.webContents.on('did-fail-load', (event, code, desc) => log('DID_FAIL_LOAD', code, desc));
    win.webContents.once('did-finish-load', () => log('AUDIOTEST_PAGE_LOADED'));
    win.webContents.once('did-finish-load', async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      let res;
      try {
        res = await win.webContents.executeJavaScript(`(async () => {
        const out = {};
        try {
          out.hasHelper = typeof window.openAudioStream === 'function';
          const stream = out.hasHelper ? await window.openAudioStream('system') : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: true });
          out.tracks = stream.getTracks().map(t => t.kind + ':' + t.readyState);
          const audioStream = new MediaStream(stream.getAudioTracks());
          const ctx = new AudioContext();
          out.sampleRate = ctx.sampleRate;
          const src = ctx.createMediaStreamSource(audioStream);
          const node = ctx.createScriptProcessor(4096, 1, 1);
          const mute = ctx.createGain(); mute.gain.value = 0;
          let peak = 0, rmsMax = 0, frames = 0;
          node.onaudioprocess = (e) => {
            const d = e.inputBuffer.getChannelData(0);
            let s = 0;
            for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; s += d[i] * d[i]; }
            const r = Math.sqrt(s / d.length);
            if (r > rmsMax) rmsMax = r;
            frames++;
          };
          src.connect(node); node.connect(mute); mute.connect(ctx.destination);
          await new Promise((r) => setTimeout(r, 4000));
          try { src.disconnect(); node.disconnect(); } catch {}
          stream.getTracks().forEach((t) => t.stop());
          try { await ctx.close(); } catch {}
          out.peak = +peak.toFixed(6); out.rmsMax = +rmsMax.toFixed(6); out.frames = frames;
        } catch (e) { out.error = String(e && e.message || e); }
        return out;
      })()`);
      } catch (e) { res = { evalError: String(e && e.message || e) }; }
      log('AUDIO_RESULT ' + JSON.stringify(res));
      try {
        fs.writeFileSync(path.join(require('os').tmpdir(), 'ghostqa-audio.json'), JSON.stringify(res));
      } catch {}
      quitting = true;
      app.exit(0);
    });
  }

if (DOMTEST) {
    win.webContents.on('console-message', (event, level, message) => log('renderer-console:', level, message));
    win.webContents.once('did-finish-load', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      let result;
      let failed = null;
      try {
        result = await win.webContents.executeJavaScript(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const statusText = document.getElementById('status-text');
          const settings = document.getElementById('settings');
          const res = {
            title: document.title,
            hasApp: !!document.getElementById('app'),
            statusText: statusText ? statusText.textContent : null,
            statusDotClass: document.getElementById('status-dot').className,
            settingsHidden: settings.classList.contains('hidden'),
            buttonIds: [...document.querySelectorAll('button')].map(b => b.id),
            answerPlaceholder: document.getElementById('answer').classList.contains('placeholder'),
            bodyHeight: document.body.clientHeight,
            modeBadge: document.getElementById('mode-badge').textContent,
            clickthroughHintHidden: document.getElementById('clickthrough-hint').classList.contains('hidden'),
            headerWidth: (() => { const h = document.querySelector('.widget-header'); return h ? h.scrollWidth + '/' + h.clientWidth : 'n/a'; })()
          };
          document.getElementById('btn-settings').click();
          await sleep(300);
          res.settingsOpens = !settings.classList.contains('hidden');
          res.settingsDisplay = getComputedStyle(settings).display;
          res.sBaseurl = document.getElementById('s-baseurl').value;
          res.sProtectChecked = document.getElementById('s-protect').checked;
          document.getElementById('btn-settings-close').click();
          document.getElementById('btn-history').click();
          await sleep(300);
          res.historyOpens = !document.getElementById('history').classList.contains('hidden');
          try {
            const t0 = await window.ghost.transcribe(new Float32Array(16000));
            res.transcribeTest = 'ok:' + (t0 === null ? 'null' : String(t0).slice(0, 20));
          } catch (e) { res.transcribeTest = 'err:' + e.message; }
          try {
            const sid = await window.ghost.getScreenSourceId();
            res.screenSourceTest = sid ? 'ok:' + String(sid).slice(0, 40) : 'null';
          } catch (e) { res.screenSourceTest = 'err:' + e.message; }
          return res;
        })()`);
      } catch (error) {
        failed = error && error.message ? error.message : String(error);
      }
      const payload = failed ? { failed } : result;
      log('DOM_RESULT ' + JSON.stringify(payload));
      try {
        fs.writeFileSync(path.join(require('os').tmpdir(), 'ghostqa-dom.json'), JSON.stringify(payload));
      } catch {}
      quitting = true;
      app.exit(0);
    });
  }

  if (UPDATETEST) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const info = await updater.checkLatest('0.0.1');
      sendToRenderer('update-available', { current: '0.0.1', ...info });
      await new Promise((resolve) => setTimeout(resolve, 600));
      try {
        const state = await win.webContents.executeJavaScript(`({ barHidden: document.getElementById('update-bar').classList.contains('hidden'), text: document.getElementById('update-text').textContent, btn: document.getElementById('btn-update').textContent })`);
        log('UPDATEBAR ' + JSON.stringify(state));
      } catch (error) {
        log('UPDATEBAR_FAIL ' + error.message);
      }
      const shot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(require('os').tmpdir(), 'ghostqa-update-banner.png'), shot.toPNG());
      log('UPDATETEST_SAVED banner');
      quitting = true;
      app.exit(0);
    });
  }

  if (UITEST) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const shot1 = await win.webContents.capturePage();
      fs.writeFileSync(path.join(require('os').tmpdir(), 'ghostqa-ui.png'), shot1.toPNG());
      sendToRenderer('open-settings');
      await new Promise((resolve) => setTimeout(resolve, 600));
      const shot2 = await win.webContents.capturePage();
      fs.writeFileSync(path.join(require('os').tmpdir(), 'ghostqa-ui-settings.png'), shot2.toPNG());
      log('UITEST_SAVED ' + path.join(require('os').tmpdir(), 'ghostqa-ui-settings.png'));
      quitting = true;
      app.exit(0);
    });
  }
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
    if (server) server.close();
  });
}