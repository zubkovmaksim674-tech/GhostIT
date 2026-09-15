const readline = require('readline');
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
    .map((file) => file.Path)
    .filter(isModelFile);
}

async function downloadFile(url, dest, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const total = Number(response.headers.get('content-length')) || 0;
      if (!response.body || !response.body.getReader) {
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buffer);
        return total;
      }
      const reader = response.body.getReader();
      let received = 0;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        received += value.length;
        if (total) {
          send({ type: 'download-progress', file: label, percent: Math.round((received / total) * 100), total });
        }
      }
      const buffer = Buffer.concat(chunks);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buffer);
      return buffer.length;
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
  let skipped = 0;
  for (const file of files) {
    const dest = path.join(dir, ...file.split('/'));
    if (fs.existsSync(dest)) continue;
    const url = `${MODELSCOPE}/models/${modelId}/resolve/master/${file}`;
    await downloadFile(url, dest, file);
    skipped++;
  }
  log(`model files ready (${files.length - skipped} from cache, downloaded ${skipped})`);
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
      const audio = Float32Array.from(message.audio || []);
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

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  handle(message);
});

process.on('uncaughtException', (error) => {
  log(`uncaught: ${error && error.stack ? error.stack : error}`);
  send({ type: 'fatal', message: error && error.message ? error.message : String(error) });
});

send({ type: 'ready' });