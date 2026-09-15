const fs = require('fs');
const os = require('os');
const http = require('http');

function saveArtifact(name, data) {
  try {
    fs.writeFileSync(pathJoin(name), data);
  } catch {}
}

function pathJoin(name) {
  return require('path').join(os.tmpdir(), name);
}

function logResult(log, tag, payload) {
  log(tag + ' ' + JSON.stringify(payload));
}

function startFakeLLM() {
  return new Promise((resolve) => {
    const fake = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.url.includes('/chat/completions')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const parts = [
            'REST — это архитектурный стиль для построения API, а не протокол.',
            'Основные принципы: клиент-сервер, stateless, кэшируемость, единообразный интерфейс.',
            'Данные обычно передаются в формате JSON.'
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

function runSmoke({ win, hotkeyMode, modelsDir, config, workerCall, log, exitApp }) {
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
        await workerCall('load', { model: localConfig.whisper.model, cacheDir: modelsDir });
        results.modelLoaded = true;
      } catch (error) {
        results.modelLoaded = String(error.message);
      }
    }
    logResult(log, 'SMOKE_RESULT', results);
    saveArtifact('ghostit-smoke.json', JSON.stringify(results));
    exitApp();
  }, 4000);
}

function runE2E({ win, config, sendToRenderer, log, exitApp }) {
  return new Promise(async (resolve) => {
    const original = config.load();
    const fakePort = await startFakeLLM();
    config.save({ api: { baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: 'fake' } });
    sendToRenderer('config-updated', config.load());
    await new Promise((r) => setTimeout(r, 600));
    try {
      const result = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.ghost.askText('Что такое REST?');
      await sleep(3500);
      return {
        answer: document.getElementById('answer').textContent.slice(0, 400),
        question: document.getElementById('question').textContent,
        status: document.getElementById('status-text').textContent,
        hasCopyButton: !document.getElementById('answer-actions').classList.contains('hidden')
      };
    })()`);
      logResult(log, 'E2E_RESULT', result);
    } catch (error) {
      logResult(log, 'E2E_FAIL', { message: error.message });
    } finally {
      config.save(original);
      exitApp();
      resolve();
    }
  });
}

function runAudioTest({ win, log, exitApp }) {
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
    logResult(log, 'AUDIO_RESULT', res);
    saveArtifact('ghostit-audio.json', JSON.stringify(res));
    exitApp();
  });
}

function runDomTest({ win, updater, workerCall, config, log, exitApp }) {
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
          res.transcribeTest = 'ok:' + (t0 && t0.text ? String(t0.text).slice(0, 20) : 'null') + '/asked:' + (t0 && t0.asked);
          const t1 = await window.ghost.transcribe(new Float32Array(16000), { auto: true });
          res.transcribeAutoTest = 'asked:' + (t1 && t1.asked) + '/text:' + (t1 && t1.text ? String(t1.text).slice(0, 16) : 'none');
        } catch (e) { res.transcribeTest = 'err:' + e.message; }
        try {
          const stream = await window.openAudioStream('system');
          const kinds = stream.getTracks().map((t) => t.kind + ':' + t.readyState).join(',');
          stream.getTracks().forEach((t) => t.stop());
          res.screenSourceTest = 'ok:' + kinds;
        } catch (e) { res.screenSourceTest = 'err:' + e.message; }
        try {
          const s = await window.ghost.tgAuthStart();
          res.tgAuthTest = s.sid ? 'ok:' + s.code : 'err:' + (s.error || 'no sid');
        } catch (e) { res.tgAuthTest = 'err:' + e.message; }
        return res;
      })()`);
    } catch (error) {
      failed = error && error.message ? error.message : String(error);
    }
    const payload = failed ? { failed } : result;
    logResult(log, 'DOM_RESULT', payload);
    saveArtifact('ghostit-dom.json', JSON.stringify(payload));
    exitApp();
  });
}

function runUpdateTest({ win, updater, sendToRenderer, log, exitApp }) {
  win.webContents.once('did-finish-load', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const info = await updater.checkLatest('0.0.1');
    sendToRenderer('update-available', { current: '0.0.1', ...info });
    await new Promise((resolve) => setTimeout(resolve, 600));
    try {
      const state = await win.webContents.executeJavaScript(`({ barHidden: document.getElementById('update-bar').classList.contains('hidden'), text: document.getElementById('update-text').textContent, btn: document.getElementById('btn-update').textContent })`);
      logResult(log, 'UPDATEBAR', state);
    } catch (error) {
      logResult(log, 'UPDATEBAR_FAIL', { message: error.message });
    }
    const shot = await win.webContents.capturePage();
    saveArtifact('ghostit-update-banner.png', shot.toPNG());
    log('UPDATETEST_SAVED banner');
    exitApp();
  });
}

function runUiTest({ win, sendToRenderer, log, exitApp }) {
  win.webContents.once('did-finish-load', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const shot1 = await win.webContents.capturePage();
    saveArtifact('ghostit-ui.png', shot1.toPNG());
    sendToRenderer('open-settings');
    await new Promise((resolve) => setTimeout(resolve, 600));
    const shot2 = await win.webContents.capturePage();
    saveArtifact('ghostit-ui-settings.png', shot2.toPNG());
    log('UITEST_SAVED ' + pathJoin('ghostit-ui-settings.png'));
    exitApp();
  });
}

module.exports = { runSmoke, runE2E, runAudioTest, runDomTest, runUpdateTest, runUiTest };