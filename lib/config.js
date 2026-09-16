const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const ENC_PREFIX = 'enc:';

function encryptValue(value) {
  if (!value) return value;
  try {
    if (!safeStorage.isEncryptionAvailable()) return value;
    return ENC_PREFIX + safeStorage.encryptString(value).toString('base64');
  } catch {
    return value;
  }
}

function decryptValue(value) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value;
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'));
  } catch {
    return '';
  }
}

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
    listenSource: 'system'
  },
  hotkey: {
    mode: 'hold',
    combo: 'ctrl+shift+space'
  },
  autoListen: {
    enabled: false,
    sensitivity: 35,
    silenceMs: 1300,
    minSpeechMs: 700,
    suppressMs: 15000
  },
ui: {
    opacity: 0.95,
    clickThrough: false,
    tts: false,
    protectCapture: false,
    theme: 'violet',
    x: null,
    y: null
  },
  prompt: [
    'Ты — ведущий IT-специалист на собеседовании (разработка, QA, DevOps, аналитика).',
    'В вопросах по своей сфере ты уверенный эксперт: отвечаешь как человек с многолетним опытом, а не как справочник.',
    'Правила ответа:',
    '1) Сначала 1–2 предложения — суть ответа.',
    '2) Затем 2–5 коротких пунктов: как устроено, практические нюансы, trade-offs, когда что применять.',
    '3) Если просят пример кода — короткий фрагмент (5–15 строк) без лишних комментариев.',
    '4) Упоминай практику («в нашем проекте», «в продакшене»), но без выдуманных цифр и названий компаний.',
    '5) Никакой воды: без «отличный вопрос», без уточняющих вопросов, без «можно сказать, что…».',
    '6) Отвечай на русском; англоязычные термины допустимы.',
    '7) Вопрос не про IT — одной фразой скажи, что это вне профиля, и предложи вернуться к теме.',
    '8) Не уверен в точном ответе — дай обоснованное предположение и честно отметь неопределённость.'
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
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8').replace(/^\uFEFF/, ''));
    if (raw.api && raw.api.apiKey) raw.api.apiKey = decryptValue(raw.api.apiKey);
    cache = deepMerge(DEFAULTS, raw);
  } catch {
    cache = JSON.parse(JSON.stringify(DEFAULTS));
  }
  cache.prompt = DEFAULTS.prompt;
  return cache;
}

function save(patch) {
  cache = deepMerge(load(), patch);
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  const toDisk = JSON.parse(JSON.stringify(cache));
  if (toDisk.api && toDisk.api.apiKey) toDisk.api.apiKey = encryptValue(toDisk.api.apiKey);
  fs.writeFileSync(filePath(), JSON.stringify(toDisk, null, 2), 'utf8');
  return cache;
}

const LEGACY_DATA_NAMES = ['GhostQA', 'ghost-qa'];

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function migrateLegacy() {
  const summary = { migrated: [], removed: [] };
  const currentDir = app.getPath('userData');
  const appData = app.getPath('appData');
  for (const name of LEGACY_DATA_NAMES) {
    const legacy = path.join(appData, name);
    try {
      if (samePath(legacy, currentDir)) continue;
      const legacyCfgFile = path.join(legacy, 'config.json');
      if (!fs.existsSync(legacyCfgFile)) continue;
      const legacyRaw = JSON.parse(fs.readFileSync(legacyCfgFile, 'utf8').replace(/^\uFEFF/, ''));
      let curRaw = {};
      try { curRaw = JSON.parse(fs.readFileSync(filePath(), 'utf8')); } catch {}
      if (!(curRaw.api && curRaw.api.apiKey) && legacyRaw.api && legacyRaw.api.apiKey) {
        curRaw.api = Object.assign({}, curRaw.api || {}, legacyRaw.api);
        fs.mkdirSync(path.dirname(filePath()), { recursive: true });
        fs.writeFileSync(filePath(), JSON.stringify(curRaw, null, 2), 'utf8');
        cache = null;
        summary.migrated.push(name + ':api');
      }
      const histTo = path.join(currentDir, 'history.json');
      const histFrom = path.join(legacy, 'history.json');
      if (!fs.existsSync(histTo) && fs.existsSync(histFrom)) {
        fs.copyFileSync(histFrom, histTo);
        summary.migrated.push(name + ':history');
      }
      const modelsTo = path.join(currentDir, 'models');
      const modelsFrom = path.join(legacy, 'models');
      if (!fs.existsSync(modelsTo) && fs.existsSync(modelsFrom)) {
        try { fs.renameSync(modelsFrom, modelsTo); }
        catch { fs.cpSync(modelsFrom, modelsTo, { recursive: true }); }
        summary.migrated.push(name + ':models');
      }
      fs.rmSync(legacy, { recursive: true, force: true });
      summary.removed.push(name);
    } catch (e) {
      console.error('migrateLegacy ' + name + ': ' + e.message);
    }
  }
  return summary;
}

module.exports = { load, save, DEFAULTS, filePath, migrateLegacy };