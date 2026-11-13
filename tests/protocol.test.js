const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/protocol.js');

const yesNo = (id, createdAt, status = 'open') => ({
  id, createdAt, status, questions: [{ text: 'Купить хлеб?', options: ['да', 'нет', 'позже'] }]
});
const batch = (id, createdAt) => ({
  id, createdAt, status: 'open',
  questions: [
    { text: 'Как спала?', options: ['хорошо', 'плохо'] },
    { text: 'Ела?', options: ['да', 'нет'] },
    { text: 'Нужно что-то?', options: ['нет', 'да', 'лекарства'] }
  ]
});
const multi = (id, createdAt) => ({
  id, createdAt, status: 'open',
  questions: [{ text: 'Что купить?', options: ['хлеб', 'молоко', 'яйца', 'сыр'], multi: true }]
});

test('nextId: двузначные номера по кругу', () => {
  assert.equal(P.nextId(undefined), 10);
  assert.equal(P.nextId(10), 11);
  assert.equal(P.nextId(99), 10);
});

test('formatMessage: один вопрос', () => {
  const text = P.formatMessage(
    { id: 12, questions: [{ text: 'Купить хлеб?', options: ['да', 'нет', ''] }] },
    { numbered: true }
  );
  assert.equal(text, '#12 Купить хлеб?\n1-да\n2-нет');
});

test('formatMessage: анкета, подсказка, транслит', () => {
  const text = P.formatMessage(batch(13, 0), { numbered: true });
  assert.equal(text,
    '#13 Ответ - 3 цифры подряд:\n' +
    'А) Как спала? 1-хорошо 2-плохо\n' +
    'Б) Ела? 1-да 2-нет\n' +
    'В) Нужно что-то? 1-нет 2-да 3-лекарства');
  const lat = P.formatMessage(yesNo(14, 0), { translit: true, hint: true });
  assert.equal(lat, '#14 Kupit hleb?\n1-da\n2-net\n3-pozzhe\nOtvet: odna tsifra');
  assert.equal(P.smsInfo(lat).encoding, 'GSM-7');
});

test('smsInfo: кириллица 70, латиница 160', () => {
  assert.deepEqual(P.smsInfo('а'.repeat(70)).parts, 1);
  assert.deepEqual(P.smsInfo('а'.repeat(71)).parts, 2);
  assert.deepEqual(P.smsInfo('a'.repeat(160)).parts, 1);
  assert.deepEqual(P.smsInfo('a'.repeat(161)).parts, 2);
  assert.equal(P.smsInfo('[').length, 2);
});

test('одна цифра → последний открытый вопрос', () => {
  const r = P.parseReply(' 2 ', [yesNo(10, 1), yesNo(11, 2)]);
  assert.equal(r.status, 'ok');
  assert.equal(r.messageId, 11);
  assert.deepEqual(r.answers[0].labels, ['нет']);
});

test('явный номер вопроса: «10 3», «10#3», «103»', () => {
  const msgs = [yesNo(10, 1), yesNo(11, 2)];
  for (const s of ['10 3', '10#3', '10*3', '103']) {
    const r = P.parseReply(s, msgs);
    assert.equal(r.status, 'ok', s);
    assert.equal(r.messageId, 10, s);
    assert.deepEqual(r.answers[0].values, [3], s);
  }
});

test('анкета: цифры подряд и через пробел', () => {
  for (const s of ['213', '2 1 3', '2-1-3']) {
    const r = P.parseReply(s, [batch(20, 1)]);
    assert.equal(r.status, 'ok', s);
    assert.deepEqual(r.answers.map(a => a.labels[0]), ['плохо', 'да', 'лекарства'], s);
  }
  assert.equal(P.parseReply('21', [batch(20, 1)]).status, 'invalid');
});

test('несколько вариантов: «13», «31», «1 3»', () => {
  for (const s of ['13', '31', '1 3', '133']) {
    const r = P.parseReply(s, [multi(30, 1)]);
    assert.equal(r.status, 'ok', s);
    assert.deepEqual(r.answers[0].labels, ['хлеб', 'яйца'], s);
  }
});

test('0 = позвони мне, и словами тоже', () => {
  assert.equal(P.parseReply('0', [yesNo(10, 1)]).status, 'call');
  assert.equal(P.parseReply('Позвони!', [yesNo(10, 1)]).status, 'call');
  assert.equal(P.parseReply('0', [yesNo(10, 1)], { callZero: false }).status, 'invalid');
});

test('ответ словами', () => {
  const r1 = P.parseReply('Да', [yesNo(10, 1)]);
  assert.deepEqual([r1.status, r1.method, r1.answers[0].values[0]], ['ok', 'word', 1]);
  const r2 = P.parseReply('ага', [yesNo(10, 1)]);
  assert.equal(r2.answers[0].labels[0], 'да');
  const r3 = P.parseReply('позж', [yesNo(10, 1)]);
  assert.equal(r3.answers[0].labels[0], 'позже');
});

test('буква вместо цифры (кнопка в буквенном режиме)', () => {
  // кнопка 2 → «а»/«a», кнопка 3 → «д»/«d», кнопка 1 → «.»
  assert.deepEqual(P.parseReply('а', [yesNo(10, 1)]).answers[0].values, [2]);
  assert.deepEqual(P.parseReply('D', [yesNo(10, 1)]).answers[0].values, [3]);
  assert.deepEqual(P.parseReply('.', [yesNo(10, 1)]).answers[0].values, [1]);
  const b = P.parseReply('а.д', [batch(20, 1)]);
  assert.equal(b.method, 't9');
  assert.deepEqual(b.answers.map(a => a.values[0]), [2, 1, 3]);
  // обычное слово не принимаем за нажатия кнопок
  assert.equal(P.parseReply('нет', [batch(20, 1)]).status, 'text');
});

test('нет открытых вопросов → исправление последнего ответа', () => {
  const r = P.parseReply('1', [yesNo(10, 1, 'answered')]);
  assert.equal(r.status, 'ok');
  assert.equal(r.correction, true);
});

test('произвольный текст и пустой ответ', () => {
  assert.equal(P.parseReply('купи ещё масло', [yesNo(10, 1)]).status, 'text');
  assert.equal(P.parseReply('   ', [yesNo(10, 1)]).status, 'empty');
  assert.equal(P.parseReply('5', [yesNo(10, 1)]).status, 'invalid');
  assert.equal(P.parseReply('1', []).status, 'invalid');
});
