const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const wavPath = process.argv[2];
const model = process.argv[3] || 'Xenova/whisper-tiny';
const language = process.argv[4] || 'ru';

function readWavPcm(filePath) {
  const buffer = fs.readFileSync(filePath);
  const numChannels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  let offset = 12;
  while (offset < buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') break;
    offset += 8 + chunkSize;
  }
  const dataStart = offset + 8;
  const samples = [];
  const bytesPerSample = bitsPerSample / 8;
  for (let i = dataStart; i + bytesPerSample <= buffer.length; i += bytesPerSample * numChannels) {
    let sample;
    if (bitsPerSample === 16) sample = buffer.readInt16LE(i) / 32768;
    else if (bitsPerSample === 32) sample = buffer.readFloatLE(i);
    else sample = buffer[i] / 255 - 0.5;
    samples.push(Math.max(-1, Math.min(1, sample)));
  }
  return { samples: new Float32Array(samples), sampleRate };
}

const wav = readWavPcm(wavPath);
console.log(`wav: ${wav.samples.length} samples @ ${wav.sampleRate} Hz`);

let target = wav.samples;
if (wav.sampleRate !== 16000) {
  const ratio = wav.sampleRate / 16000;
  const out = new Float32Array(Math.round(wav.samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, wav.samples.length - 1);
    const frac = pos - i0;
    out[i] = wav.samples[i0] * (1 - frac) + wav.samples[i1] * frac;
  }
  target = out;
  console.log(`resampled to 16000: ${target.length} samples`);
}

const worker = spawn(process.execPath, [path.join(__dirname, '..', 'worker', 'stt.js')], {
  env: { ...process.env, MODEL_CACHE_DIR: path.join(require('os').tmpdir(), 'ghostit-model-test') },
  stdio: ['pipe', 'pipe', 'pipe']
});

let buffer = '';
let done = false;

worker.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === 'progress' && message.data && message.data.status === 'progress') {
      const percent = message.data.total ? Math.round((message.data.loaded / message.data.total) * 100) : 0;
      process.stdout.write(`\r  download ${message.data.file}: ${percent}%`);
    } else if (message.type === 'result') {
      done = true;
      console.log('\nRESULT: ' + message.text);
      worker.kill();
      process.exit(0);
    } else if (message.type === 'error') {
      done = true;
      console.log('\nERROR: ' + message.message);
      worker.kill();
      process.exit(1);
    }
  }
});

worker.stderr.on('data', (chunk) => process.stderr.write(chunk));

worker.stdin.write(JSON.stringify({
  id: 1,
  type: 'transcribe',
  audio: Array.from(target),
  model,
  language,
  hfEndpoint: process.env.HF_ENDPOINT || '',
  cacheDir: path.join(require('os').tmpdir(), 'ghostit-model-test')
}) + '\n');

setTimeout(() => {
  if (!done) {
    console.log('\nTIMEOUT');
    worker.kill();
    process.exit(1);
  }
}, 600000);