const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  api: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.4,
    maxTokens: 800
  },
  whisper: {
    model: 'Xenova/whisper-small',
    language: 'ru'
  },
  audio: {
    listenSource: 'mic'
  },
  hotkey: {
    mode: 'hold',
    combo: 'ctrl+shift+space'
  },
  autoListen: {
    enabled: false,
    sensitivity: 35,
    silenceMs: 1300,
    minSpeechMs: 700
  },
  ui: {
    opacity: 0.95,
    clickThrough: false,
    tts: false,
    protectCapture: true,
    x: null,
    y: null
  },
  prompt: [
    'Ты — быстрый ассистент на собеседовании по тестированию ПО (QA).',
    'Отвечай на русском, кратко и по делу: сначала суть в 1–2 предложениях, затем при необходимости 3–6 пунктов.',
    'Пиши так, как говорит уверенный кандидат: без воды, без вступлений вроде «отличный вопрос».',
    'Если вопрос не про IT/QA — ответь одной фразой, что профиль другой.'
  ].join(' ')
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof out[key] === 'object' && out[key] !== null && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

let cache = null;

function filePath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    cache = deepMerge(DEFAULTS, JSON.parse(raw));
  } catch {
    cache = JSON.parse(JSON.stringify(DEFAULTS));
  }
  return cache;
}

function save(patch) {
  cache = deepMerge(load(), patch);
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

module.exports = { load, save, DEFAULTS, filePath };