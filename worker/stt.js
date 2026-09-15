const fs = require('fs');
const path = require('path');

const MODELSCOPE = 'https://modelscope.cn';
const LANGUAGE_NAMES = {
  ru: 'russian',
  en: 'english',
  de: 'german',
  fr: 'french',
  es: 'spanish',
  it: 'italian',
  uk: 'ukrainian',
  tr: 'turkish',
  zh: 'chinese',
  ja: 'japanese'
};

const SKIP_FILES = new Set([
  '.gitattributes',
  'README.md',
  'configuration.json',
  'quant_config.json',
  'quantize_config.json'
]);

function isModelFile(fileName) {
  if (SKIP_FILES.has(fileName)) return false;
  if (!fileName.startsWith('onnx/')) return true;
  return (
    fileName === 'onnx/encoder_model_quantized.onnx' ||
    fileName === 'onnx/decoder_model_merged_quantized.onnx'
  );
}

let transformersPromise = null;
let currentModel = null;
let currentPipe = null;
let loadingPromise = null;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function log(message) {
  process.stderr.write(`[stt] ${message}\n`);
}

function getTransformers() {
  if (!transformersPromise) transformersPromise = import('@xenova/transformers');
  return transformersPromise;
}

function modelDir(cacheDir, modelId) {
  return path.join(cacheDir, ...modelId.split('/'));
}

async function listModelFiles(modelId) {
  const url = `${MODELSCOPE}/api/v1/models/${modelId}/repo/files?Revision=master&Recursive=true`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`ModelScope file list: HTTP ${response.status}`);
  const json = await response.json();
  const files = json.Data && json.Data.Files;
  if (!Array.isArray(files)) throw new Error('ModelScope file list: bad response');
  return files
    .filter((file) => file.Type === 'blob' && file.Size > 0)
    .map((file) => ({ path: file.Path, size: Number(file.Size) || 0 }))
    .filter((file) => isModelFile(file.path));
}

const activeDownloads = new Map();

function ensureFileDownloaded(url, dest, label, expectedSize) {
  if (fs.existsSync(dest)) return Promise.resolve();
  const inFlight = activeDownloads.get(dest);
  if (inFlight) return inFlight;
  const promise = downloadFile(url, dest, label, expectedSize).finally(() => {
    activeDownloads.delete(dest);
  });
  activeDownloads.set(dest, promise);
  return promise;
}

async function downloadFile(url, dest, label, expectedSize) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const part = dest + '.part';
    try {
      const start = fs.existsSync(part) ? fs.statSync(part).size : 0;
      const headers = {};
      if (start > 0) headers.Range = `bytes=${start}-`;
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(600000) });
      if (start > 0 && response.status === 416) {
        if (expectedSize && fs.statSync(part).size === expectedSize) {
          fs.renameSync(part, dest);
          return expectedSize;
        }
        fs.unlinkSync(part);
        continue;
      }
      if (!response.ok && response.status !== 206) {
        if (start > 0) fs.unlinkSync(part);
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.body || !response.body.getReader) {
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buffer);
        return buffer.length;
      }
      const reader = response.body.getReader();
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = fs.createWriteStream(part, { flags: 'a' });
      const outError = new Promise((_, reject) => out.on('error', reject));
      let received = start;
      const total = start + (Number(response.headers.get('content-length')) || 0);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
        received += chunk.length;
        if (total) {
          send({ type: 'download-progress', file: label, percent: Math.round((received / total) * 100), total });
        }
      }
      await new Promise((resolve) => out.end(resolve));
      await Promise.race([new Promise((resolve) => out.on('finish', resolve)), outError]);
      if (expectedSize && received !== expectedSize) {
        log(`size mismatch for ${label}: got ${received}, expected ${expectedSize}`);
        fs.unlinkSync(part);
        continue;
      }
      fs.renameSync(part, dest);
      return received;
    } catch (error) {
      lastError = error;
      log(`download attempt ${attempt}/3 failed for ${label}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    }
  }
  throw lastError;
}

async function ensureModelFiles(modelId, cacheDir) {
  const dir = modelDir(cacheDir, modelId);
  const files = await listModelFiles(modelId);
  const jobs = files.map((file) => {
    const dest = path.join(dir, ...file.path.split('/'));
    const url = `${MODELSCOPE}/models/${modelId}/resolve/master/${file.path}`;
    return ensureFileDownloaded(url, dest, file.path, file.size);
  });
  const concurrency = 3;
  let next = 0;
  const workers = [];
  const run = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await job;
    }
  };
  for (let i = 0; i < Math.min(concurrency, jobs.length); i++) workers.push(run());
  await Promise.all(workers);
  log(`model files ready (${files.length} total)`);
}

async function loadModel(options) {
  const { env, pipeline } = await getTransformers();
  if (options.cacheDir) env.cacheDir = options.cacheDir;
  env.allowLocalModels = false;
  env.useBrowserCache = false;

  if (currentPipe && currentModel === options.model) return currentPipe;
  if (loadingPromise) await loadingPromise;
  if (currentPipe && currentModel === options.model) return currentPipe;

  loadingPromise = (async () => {
    await ensureModelFiles(options.model, options.cacheDir);
    log(`loading model ${options.model}`);
    const pipe = await pipeline('automatic-speech-recognition', options.model, {
      quantized: true,
      progress_callback: (progress) => {
        send({ type: 'progress', data: progress });
      }
    });
    currentPipe = pipe;
    currentModel = options.model;
    send({ type: 'loaded', model: options.model });
  })();

  try {
    await loadingPromise;
  } finally {
    loadingPromise = null;
  }
  return currentPipe;
}

function resolveLanguage(language) {
  if (!language || language === 'auto') return undefined;
  return LANGUAGE_NAMES[language] || language;
}

async function handle(message) {
  const { id, type } = message;
  try {
    if (type === 'ping') {
      send({ id, type: 'pong' });
      return;
    }

    if (type === 'check') {
      const mod = await getTransformers();
      send({ id, type: 'check-result', hasPipeline: typeof mod.pipeline === 'function', named: Object.keys(mod).length });
      return;
    }

    if (type === 'load') {
      await loadModel({ model: message.model, cacheDir: message.cacheDir });
      send({ id, type: 'loaded', model: message.model });
      return;
    }

    if (type === 'transcribe') {
      const pipe = await loadModel({ model: message.model, cacheDir: message.cacheDir });
      const audio = message.audio || new Float32Array(0);
      const started = Date.now();
      const result = await pipe(audio, {
        language: resolveLanguage(message.language),
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
        no_repeat_ngram_size: 3
      });
      const text = String(result?.text || '').replace(/\s+/g, ' ').trim();
      log(`transcribed ${audio.length} samples in ${Date.now() - started}ms: ${text}`);
      send({ id, type: 'result', text });
      return;
    }

    send({ id, type: 'error', message: `Неизвестная команда: ${type}` });
  } catch (error) {
    log(`error: ${error && error.stack ? error.stack : error}`);
    send({ id, type: 'error', message: error && error.message ? error.message : String(error) });
  }
}

let buffer = Buffer.alloc(0);
let pendingHeader = null;

function dispatch(message) {
  handle(message).catch((error) => {
    log(`dispatch error: ${error && error.message ? error.message : error}`);
  });
}

process.stdin.on('data', (chunk) => {
  buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
  while (true) {
    if (pendingHeader) {
      if (buffer.length < pendingHeader.audioBytes) break;
      const audioBuf = buffer.subarray(0, pendingHeader.audioBytes);
      buffer = buffer.subarray(pendingHeader.audioBytes);
      const message = pendingHeader;
      pendingHeader = null;
      message.audio = new Float32Array(audioBuf.buffer, audioBuf.byteOffset, audioBuf.byteLength / 4);
      dispatch(message);
      continue;
    }
    const nl = buffer.indexOf(0x0a);
    if (nl === -1) break;
    const line = buffer.subarray(0, nl).toString('utf8');
    buffer = buffer.subarray(nl + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.audioBytes && message.audioBytes > 0) {
      pendingHeader = message;
      continue;
    }
    dispatch(message);
  }
});

process.on('uncaughtException', (error) => {
  log(`uncaught: ${error && error.stack ? error.stack : error}`);
  send({ type: 'fatal', message: error && error.message ? error.message : String(error) });
});

send({ type: 'ready' });