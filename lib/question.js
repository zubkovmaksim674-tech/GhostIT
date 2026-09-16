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
  'настрой', 'разбери', 'сравни', 'переведи', 'подскажи', 'ответь', 'поформируй'
]);

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
    if (INTERROGATIVES.has(word) || REQUEST_VERBS.has(word)) return true;
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

module.exports = { isQuestion, createFragmentMerger };
