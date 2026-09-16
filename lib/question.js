const INTERROGATIVES = new Set([
  'что', 'чего', 'чему', 'чем', 'чём',
  'кто', 'кого', 'кому', 'кем',
  'как', 'почему', 'отчего', 'зачем', 'когда', 'где', 'куда', 'откуда', 'сколько',
  'какой', 'какая', 'какое', 'какие', 'каков', 'какова', 'каково', 'каковы',
  'какого', 'какой', 'какому', 'каком', 'каким', 'каких', 'какие', 'какими',
  'чей', 'чья', 'чье', 'чьё', 'чьи', 'чьего', 'чьему', 'чьим', 'чьих',
  'ли', 'разве', 'неужели'
]);

const REQUEST_VERBS = new Set([
  'расскажи', 'объясни', 'опиши', 'назови', 'перечисли', 'покажи', 'помоги',
  'сделай', 'напиши', 'проверь', 'найди', 'исправь', 'запусти', 'создай',
  'настрой', 'разбери', 'сравни', 'переведи', 'подскажи', 'ответь', 'поформируй',
  'приведи', 'дай', 'сформулируй', 'представь', 'определи', 'укажи',
  'посчитай', 'перепиши', 'выбери', 'добавь', 'можешь', 'можете', 'посмотри',
  // инфинитивы: «можете рассказать…», «хочу проверить…»
  'рассказать', 'объяснить', 'описать', 'назвать', 'перечислить', 'показать',
  'помочь', 'сделать', 'написать', 'проверить', 'найти', 'исправить', 'создать',
  'настроить', 'разобрать', 'сравнить', 'перевести', 'подсказать', 'ответить',
  'привести', 'дать', 'сформулировать', 'представить', 'определить', 'указать',
  'посчитать', 'переписать', 'выбрать', 'добавить'
]);

// Основы глаголов-просьб без личных окончаний: «расскаж»+«ете», «объясн»+«ите»,
// «привед»+«ёте»… — вежливые формы «вы» на собеседовании.
const REQUEST_STEMS = new Set([
  'расскаж', 'объясн', 'опиш', 'назв', 'перечисл', 'покаж', 'помог',
  'сдела', 'напиш', 'провер', 'найд', 'исправ', 'созда', 'настро', 'разбер',
  'сравн', 'перевед', 'подскаж', 'ответ', 'привед', 'сформулир', 'представ',
  'определ', 'укаж', 'посчита', 'перепиш', 'выбер', 'добав', 'посмотр'
]);

function looksLikeRequest(word) {
  if (REQUEST_VERBS.has(word)) return true;
  if (word.endsWith('те')) {
    const base = word.slice(0, -2);
    if (REQUEST_VERBS.has(base)) return true;
  }
  if (/(ете|ите|ешь|ишь)$/.test(word)) {
    const stem = word.slice(0, -3);
    if (REQUEST_STEMS.has(stem)) return true;
  }
  return false;
}

function tokenize(raw) {
  return raw.split(/[^\p{L}\p{M}'-]+/u).filter(Boolean);
}

const OR_NOT_RE = /(?:^|[^\p{L}\p{M}])или\s+нет(?:$|[^\p{L}\p{M}])/u;

function isQuestion(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return false;
  if (raw.includes('?')) return true;
  if (OR_NOT_RE.test(raw)) return true;
  for (const word of tokenize(raw)) {
    if (/-то$|-нибудь$|-либо$/.test(word)) continue;
    if (word === 'то' || word === 'либо' || word === 'нибудь') continue;
    if (INTERROGATIVES.has(word)) return true;
    if (looksLikeRequest(word)) return true;
  }
  return false;
}

function wordCount(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function createFragmentMerger(options) {
  const windowMs = (options && options.windowMs) || 8000;
  const maxWords = (options && options.maxWords) || 12;
  let last = null;
  return {
    remember(text) {
      last = { text: String(text).trim(), at: Date.now() };
    },
    combine(text) {
      if (!last) return null;
      const prev = last;
      last = null;
      const cur = String(text).trim();
      if (!prev.text || !cur) return null;
      if (Date.now() - prev.at > windowMs) return null;
      if (wordCount(prev.text) > maxWords || wordCount(cur) > maxWords) return null;
      return prev.text + ' ' + cur;
    },
    reset() {
      last = null;
    }
  };
}

const SILENCE_JUNK_RES = [
  /^субтитры\s+сделал/i, /^редактор\s+субтитров/i,
  /^спасибо\s+за\s+внимание/i, /^подписывай?тесь/i,
  /^если\s+(?:видео|ролик)\s+понравилось/i,
  /^мелодию\s+и\s+аранжировку/i, /^ставь\s+лайк/i,
  /^you\s+can\s+help\s+by\s+donating/i, /^thanks\s+for\s+watching/i,
  /^please\s+(?:subscribe|like)/i
];

function isSilenceJunk(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 60) return false;
  return SILENCE_JUNK_RES.some((re) => re.test(raw));
}

module.exports = { isQuestion, createFragmentMerger, isSilenceJunk };
