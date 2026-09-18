// Локальная озвучка «джарвис-deep» — Piper офлайн (движок + голос dmitri лежат в vendor/piper,
// в установленной версии — в resources/piper) плюс DSP-профиль, выбранный пользователем:
// тон ×0.88, низ +3.5 дБ @180 Гц, верх −2.5 дБ @5.2 кГц, компрессор 2:1.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROFILE = { pitch: 0.88, bassDb: 3.5, trebleDb: -2.5 };

function piperDir() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return path.join(process.resourcesPath, 'piper');
  } catch {}
  return path.join(__dirname, '..', 'vendor', 'piper');
}

function readWav(buf) {
  const rate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const bits = buf.readUInt16LE(34);
  if (bits !== 16 || channels !== 1) throw new Error('ожидался PCM16 mono');
  const n = (buf.length - 44) / 2;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(44 + i * 2) / 32768;
  return { rate, samples };
}

function resample(samples, factor) {
  const outLen = Math.floor(samples.length / factor);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * factor;
    const i0 = Math.floor(pos);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

function shelf(samples, rate, freq, gainDb, type) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / rate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = (sinw / 2) * Math.sqrt((A + 1 / A) * (1 / 1 - 1) + 2);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'low') {
    b0 = A * (A + 1 - (A - 1) * cosw + 2 * Math.sqrt(A) * alpha);
    b1 = 2 * A * (A - 1 - (A + 1) * cosw);
    b2 = A * (A + 1 - (A - 1) * cosw - 2 * Math.sqrt(A) * alpha);
    a0 = A + 1 + (A - 1) * cosw + 2 * Math.sqrt(A) * alpha;
    a1 = -2 * (A - 1 + (A + 1) * cosw);
    a2 = A + 1 + (A - 1) * cosw - 2 * Math.sqrt(A) * alpha;
  } else {
    b0 = A * (A + 1 + (A - 1) * cosw + 2 * Math.sqrt(A) * alpha);
    b1 = -2 * A * (A - 1 + (A + 1) * cosw);
    b2 = A * (A + 1 + (A - 1) * cosw - 2 * Math.sqrt(A) * alpha);
    a0 = A + 1 - (A - 1) * cosw + 2 * Math.sqrt(A) * alpha;
    a1 = 2 * (A - 1 - (A + 1) * cosw);
    a2 = A + 1 - (A - 1) * cosw - 2 * Math.sqrt(A) * alpha;
  }
  const b0n = b0 / a0, b1n = b1 / a0, b2n = b2 / a0, a1n = a1 / a0, a2n = a2 / a0;
  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = b0n * x0 + b1n * x1 + b2n * x2 - a1n * y1 - a2n * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    out[i] = y0;
  }
  return out;
}

function compress(samples, rate) {
  const thr = Math.pow(10, -18 / 20);
  const ratio = 2.0;
  const makeup = Math.pow(10, 2 / 20);
  const att = Math.exp(-1 / (rate * 0.005));
  const rel = Math.exp(-1 / (rate * 0.12));
  let env = 0;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    env = a > env ? att * env + (1 - att) * a : rel * env + (1 - rel) * a;
    let gain = 1;
    if (env > thr) gain = Math.pow(env / thr, 1 / ratio - 1);
    out[i] = samples[i] * gain * makeup;
  }
  return out;
}

function writeWav(rate, samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

function synthesize(text) {
  return new Promise((resolve) => {
    const dir = piperDir();
    const exe = path.join(dir, 'piper.exe');
    const model = path.join(dir, 'voices', 'dmitri.onnx');
    if (!fs.existsSync(exe) || !fs.existsSync(model)) return resolve(null);
    const out = path.join(os.tmpdir(), 'ghostit-tts-' + Date.now() + '.wav');
    const child = spawn(exe, ['--model', model, '--output_file', out], {
      cwd: dir,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, 20000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0 || !fs.existsSync(out)) return resolve(null);
        const raw = fs.readFileSync(out);
        fs.rmSync(out, { force: true });
        const { rate, samples } = readWav(raw);
        let s = resample(samples, PROFILE.pitch);
        s = shelf(s, rate, 180, PROFILE.bassDb, 'low');
        s = shelf(s, rate, 5200, PROFILE.trebleDb, 'high');
        s = compress(s, rate);
        resolve(writeWav(rate, s));
      } catch {
        resolve(null);
      }
    });
    child.stdin.write(String(text || '').slice(0, 1500) + '\n', 'utf8');
    child.stdin.end();
  });
}

module.exports = { synthesize, PROFILE };
