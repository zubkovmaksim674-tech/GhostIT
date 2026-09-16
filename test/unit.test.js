const test = require('node:test');
const assert = require('node:assert');

const { isQuestion, createFragmentMerger, isSilenceJunk } = require('../lib/question');
const { parseVersion, isNewer } = require('../lib/updater');
const { buildMessages, normalizeBaseUrl } = require('../lib/llm');

test('isQuestion: явный знак вопроса', () => {
  assert.equal(isQuestion('Что такое REST?'), true);
  assert.equal(isQuestion('Идём обедать?'), true);
});

test('isQuestion: вопросительные слова', () => {
  assert.equal(isQuestion('Почему используем микросервисы'), true);
  assert.equal(isQuestion('как работает балансировка'), true);
  assert.equal(isQuestion('Расскажи про индексы в БД'), true);
  assert.equal(isQuestion('Чем отличается TCP от UDP'), true);
});

test('isQuestion: префиксы-разговорные', () => {
  assert.equal(isQuestion('А как ты деплоишь?'), true);
  assert.equal(isQuestion('ну так почему упал прод'), true);
  assert.equal(isQuestion('давай расскажи о себе'), true);
});

test('isQuestion: не-вопросы отбрасываются', () => {
  assert.equal(isQuestion(''), false);
  assert.equal(isQuestion('Здравствуйте'), false);
  assert.equal(isQuestion('Меня зовут Максим'), false);
  assert.equal(isQuestion('Сегодня хорошая погода'), false);
});

test('isQuestion: свободный порядок слов', () => {
  assert.equal(isQuestion('прод лёг и никто не знает почему'), true);
  assert.equal(isQuestion('балансировщик настраивается как'), true);
  assert.equal(isQuestion('это кэшируется вообще-то или нет'), true);
});

test('isQuestion: частицы и глаголы-просьбы', () => {
  assert.equal(isQuestion('работает ли этот прокси'), true);
  assert.equal(isQuestion('сравни http и https'), true);
  assert.equal(isQuestion('объясни простыми словами'), true);
});

test('isQuestion: неопределённые местоимения не считаются вопросом', () => {
  assert.equal(isQuestion('что-то упало в логах'), false);
  assert.equal(isQuestion('кто-то трогал конфиг'), false);
  assert.equal(isQuestion('как-нибудь потом'), false);
});

test('createFragmentMerger: склейка разрезанного паузой вопроса', () => {
  const m = createFragmentMerger({ windowMs: 5000 });
  assert.equal(m.combine('не работает'), null);
  m.remember('поднял сервис');
  assert.equal(m.combine('почему'), 'поднял сервис почему');
  assert.equal(m.combine('почему'), null);
});

test('createFragmentMerger: окно и слишком длинные фразы', async () => {
  const m = createFragmentMerger({ windowMs: 20, maxWords: 4 });
  m.remember('старый фрагмент');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(m.combine('слова'), null);

  const long = createFragmentMerger({ windowMs: 5000, maxWords: 3 });
  long.remember('раз два три четыре');
  assert.equal(long.combine('короткий'), null);
});

test('isSilenceJunk: галлюцинации Whisper на тишине', () => {
  assert.equal(isSilenceJunk('Редактор субтитров А. Кядаша'), true);
  assert.equal(isSilenceJunk('Субтитры сделал DimaTorzok'), true);
  assert.equal(isSilenceJunk('Спасибо за внимание'), true);
  assert.equal(isSilenceJunk('Thanks for watching'), true);
  assert.equal(isSilenceJunk(''), false);
  assert.equal(isSilenceJunk('Как работает редактор субтитров в ffmpeg'), false);
  assert.equal(isSilenceJunk('расскажи про субтитры в ffmpeg: как их сделать, какие форматы поддерживаются и чем one-pass отличается от two-pass на длинных видео'), false);
});

test('updater.parseVersion', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('0.1.0'), [0, 1, 0]);
  assert.deepEqual(parseVersion('abc'), [0]);
});

test('updater.isNewer', () => {
  assert.equal(isNewer('1.2.3', '1.2.2'), true);
  assert.equal(isNewer('1.2.3', '1.2.3'), false);
  assert.equal(isNewer('1.2.3', '1.2.4'), false);
  assert.equal(isNewer('1.3.0', '1.2.9'), true);
  assert.equal(isNewer('2.0.0', '1.9.9'), true);
  assert.equal(isNewer('0.1.0', '0.0.9'), true);
  assert.equal(isNewer('0.2.3.1', '0.2.3'), true);
  assert.equal(isNewer('0.2.3', '0.2.3.1'), false);
  assert.equal(isNewer('0.2.3.1', '0.2.3.1'), false);
  assert.equal(isNewer('0.2.4', '0.2.3.9'), true);
});

test('llm.normalizeBaseUrl', () => {
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('  https://x.com  '), 'https://x.com');
  assert.throws(() => normalizeBaseUrl(''), /Base URL/);
  assert.throws(() => normalizeBaseUrl(null), /Base URL/);
});

test('llm.buildMessages: системный промпт + история + вопрос', () => {
  const messages = buildMessages('Ты ассистент', [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' }
  ], 'вопрос');
  assert.equal(messages.length, 4);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[messages.length - 1].content, 'вопрос');
  assert.equal(messages[1].content, 'q1');
});

test('llm.buildMessages: история обрезается до 8 последних', () => {
  const longHistory = [];
  for (let i = 0; i < 20; i++) {
    longHistory.push({ role: 'user', content: 'q' + i });
  }
  const messages = buildMessages('sys', longHistory, 'вопрос');
  assert.equal(messages.length, 10);
  assert.equal(messages[1].content, 'q12');
});