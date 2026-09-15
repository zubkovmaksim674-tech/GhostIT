const QUESTION_STARTERS = [
  'что такое', 'что тако', 'что из себя', 'что означает', 'что значит', 'что будет', 'что делать',
  'как', 'почему', 'зачем', 'когда', 'где', 'куда', 'откуда', 'сколько',
  'какой', 'какая', 'какие', 'какое', 'каков', 'какова', 'какими', 'каких', 'какому',
  'чей', 'чья', 'чьё',
  'кто', 'расскажи', 'объясни', 'опиши', 'назови', 'перечисли', 'можешь',
  'в чём', 'в чем', 'чем отличается', 'чем отличаются', 'для чего', 'на что', 'с чем', 'за что',
  'в чём разница', 'в чем разница', 'чем различаются', 'какая разница'
];

function isQuestion(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return false;
  if (raw.includes('?')) return true;
  let clean = raw.replace(/[.,;:!]+$/g, '');
  for (let i = 0; i < 4; i++) {
    const next = clean.replace(/^(а |и |ну |так |давай |ещё |тогда |вообще |вот |теперь |знаешь |слушай |далее )/, '');
    if (next === clean) break;
    clean = next;
  }
  if (!clean) return false;
  return QUESTION_STARTERS.some((starter) => clean.startsWith(starter));
}

module.exports = { isQuestion };