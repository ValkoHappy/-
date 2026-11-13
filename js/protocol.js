/*
 * Протокол «вопрос с вариантами → ответ цифрой» поверх обычных SMS.
 *
 * Чистая логика без DOM: форматирование исходящего SMS, подсчёт длины,
 * транслитерация и разбор входящего ответа. Работает и в браузере
 * (window.SmsProtocol), и в Node (require) — для тестов.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SmsProtocol = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Номера сообщений всегда двузначные (10..99), чтобы их нельзя было
  // спутать с однозначным ответом.
  var ID_MIN = 10;
  var ID_MAX = 99;
  var MAX_OPTIONS = 9;
  var BATCH_LABELS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И'];

  function nextId(prev) {
    if (!prev || prev < ID_MIN || prev >= ID_MAX) return ID_MIN;
    return prev + 1;
  }

  // ---------- Транслитерация (латиница помещается 160 симв. в одно SMS) ----------

  var TRANSLIT = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '',
    'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya', '№': '#', '«': '"',
    '»': '"', '—': '-', '–': '-', '…': '...'
  };

  function translit(text) {
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var lower = ch.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(TRANSLIT, lower)) {
        var t = TRANSLIT[lower];
        if (ch !== lower && t) t = t[0].toUpperCase() + t.slice(1);
        out += t;
      } else {
        out += ch;
      }
    }
    return out;
  }

  // ---------- Длина SMS ----------

  var GSM_BASIC =
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  var GSM_EXT = '^{}\\[~]|€';

  /** Сколько символов и сколько SMS займёт текст. */
  function smsInfo(text) {
    var gsm = true;
    var gsmLen = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (GSM_BASIC.indexOf(ch) >= 0) gsmLen += 1;
      else if (GSM_EXT.indexOf(ch) >= 0) gsmLen += 2;
      else { gsm = false; break; }
    }
    if (gsm) {
      return {
        encoding: 'GSM-7', length: gsmLen, perSms: 160,
        parts: gsmLen === 0 ? 0 : gsmLen <= 160 ? 1 : Math.ceil(gsmLen / 153)
      };
    }
    var len = text.length; // UTF-16 code units, как и считает оператор
    return {
      encoding: 'UCS-2', length: len, perSms: 70,
      parts: len === 0 ? 0 : len <= 70 ? 1 : Math.ceil(len / 67)
    };
  }

  // ---------- Исходящее сообщение ----------

  function cleanQuestion(q) {
    var options = (q.options || [])
      .map(function (o) { return String(o).trim(); })
      .filter(Boolean)
      .slice(0, MAX_OPTIONS);
    return { text: String(q.text || '').trim(), options: options, multi: !!q.multi };
  }

  /**
   * msg: { id, questions: [{ text, options: [..], multi }] }
   * opts: { numbered, hint, showCall, translit }
   */
  function formatMessage(msg, opts) {
    opts = opts || {};
    var qs = (msg.questions || []).map(cleanQuestion);
    var prefix = opts.numbered !== false && msg.id ? '#' + msg.id + ' ' : '';
    var lines = [];

    if (qs.length === 1) {
      var q = qs[0];
      lines.push(prefix + q.text + (q.multi ? ' (можно неск. цифр)' : ''));
      q.options.forEach(function (o, i) { lines.push((i + 1) + '-' + o); });
      if (opts.showCall) lines.push('0-позвони');
      if (opts.hint) lines.push(q.multi ? 'Ответ: цифры подряд' : 'Ответ: одна цифра');
    } else if (qs.length > 1) {
      lines.push(prefix + 'Ответ - ' + qs.length + (qs.length < 5 ? ' цифры' : ' цифр') + ' подряд:');
      qs.forEach(function (q, i) {
        var opt = q.options.map(function (o, j) { return (j + 1) + '-' + o; }).join(' ');
        lines.push(BATCH_LABELS[i] + ') ' + q.text + ' ' + opt);
      });
      if (opts.showCall) lines.push('0-позвони');
    }

    var text = lines.join('\n');
    return opts.translit ? translit(text) : text;
  }

  // ---------- Разбор ответа ----------

  // Раскладка кнопочного телефона: если человек в буквенном режиме
  // один раз нажал кнопку «2», получится «а» (или «a») — понимаем это как 2.
  var T9_FIRST = {
    'а': '2', 'д': '3', 'и': '4', 'м': '5', 'р': '6', 'ф': '7', 'ш': '8', 'ь': '9',
    'a': '2', 'd': '3', 'g': '4', 'j': '5', 'm': '6', 'p': '7', 't': '8', 'w': '9',
    '.': '1', ',': '1'
  };

  var YES = ['да', 'ага', 'угу', 'конечно', 'хорошо', 'ок', 'ok', 'yes', 'da', 'lf'];
  var NO = ['нет', 'не', 'неа', 'no', 'net', 'ytn'];
  var CALL = ['позвони', 'перезвони', 'звони', 'позвони мне', 'перезвони мне',
              'позвони пожалуйста', 'pozvoni', 'perezvoni', 'zvoni'];

  function norm(s) {
    return String(s).toLowerCase().replace(/ё/g, 'е')
      .replace(/[^a-zа-я0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function sortedTargets(messages) {
    var list = (messages || []).slice().sort(function (a, b) {
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    var open = list.filter(function (m) { return m.status === 'open'; });
    var target = open[0] || list[0] || null;
    return { target: target, correction: !open[0] && !!target, all: list };
  }

  /** Проверяет строку цифр как ответ на сообщение msg. */
  function validate(msg, digits) {
    var qs = (msg.questions || []).map(cleanQuestion);
    if (!qs.length || !digits) return null;

    if (qs.length === 1) {
      var q = qs[0];
      var n = q.options.length;
      if (q.multi) {
        var seen = {};
        var values = [];
        for (var i = 0; i < digits.length; i++) {
          var d = +digits[i];
          if (d < 1 || d > n) return null;
          if (!seen[d]) { seen[d] = true; values.push(d); }
        }
        values.sort(function (a, b) { return a - b; });
        return [answerFor(q, 0, values)];
      }
      if (digits.length !== 1) return null;
      var v = +digits;
      if (v < 1 || v > n) return null;
      return [answerFor(q, 0, [v])];
    }

    if (digits.length !== qs.length) return null;
    var out = [];
    for (var k = 0; k < qs.length; k++) {
      var dv = +digits[k];
      if (dv < 1 || dv > qs[k].options.length) return null;
      out.push(answerFor(qs[k], k, [dv]));
    }
    return out;
  }

  function answerFor(q, index, values) {
    return {
      question: index,
      values: values,
      labels: values.map(function (v) { return q.options[v - 1]; })
    };
  }

  function ok(msg, answers, method, correction) {
    return { status: 'ok', messageId: msg.id, answers: answers, method: method, correction: !!correction };
  }

  /** Ответ словами: «да», «нет», текст варианта целиком. */
  function matchWords(msg, text) {
    var qs = (msg.questions || []).map(cleanQuestion);
    if (qs.length !== 1) return null;
    var q = qs[0];
    var t = norm(text);
    if (!t) return null;
    var opts = q.options.map(norm);

    var exact = opts.indexOf(t);
    if (exact >= 0) return [answerFor(q, 0, [exact + 1])];

    var group = YES.indexOf(t) >= 0 ? YES : NO.indexOf(t) >= 0 ? NO : null;
    if (group) {
      for (var i = 0; i < opts.length; i++) {
        if (group.indexOf(opts[i]) >= 0) return [answerFor(q, 0, [i + 1])];
      }
    }

    // Начало варианта: «завт» → «завтра» (только если однозначно).
    if (t.length >= 3) {
      var hits = [];
      opts.forEach(function (o, i) { if (o.indexOf(t) === 0) hits.push(i); });
      if (hits.length === 1) return [answerFor(q, 0, [hits[0] + 1])];
    }
    return null;
  }

  function t9Digits(text) {
    var s = String(text).toLowerCase().replace(/\s+/g, '');
    if (!s || s.length > 9) return null;
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var d = T9_FIRST[s[i]];
      if (!d) return null;
      out += d;
    }
    return out;
  }

  /**
   * Разбирает входящий ответ.
   * messages: [{ id, createdAt, status: 'open'|'answered', questions }]
   * opts: { callZero: true }
   *
   * Возвращает { status: 'ok'|'call'|'invalid'|'text'|'empty', ... }
   */
  function parseReply(text, messages, opts) {
    opts = opts || {};
    var callZero = opts.callZero !== false;
    var raw = String(text == null ? '' : text).trim();
    if (!raw) return { status: 'empty' };

    var t = sortedTargets(messages);
    var target = t.target;
    var byId = {};
    t.all.forEach(function (m) { if (!byId[m.id]) byId[m.id] = m; });

    var tokens = raw.match(/\d+/g);

    if (tokens) {
      var digits = tokens.join('');

      if (callZero && digits === '0') {
        return { status: 'call', messageId: target ? target.id : null, method: 'digits' };
      }

      // Явный номер через разделитель: «12 3», «12#3», «12*3».
      if (tokens.length >= 2 && tokens[0].length === 2 && byId[+tokens[0]]) {
        var m1 = byId[+tokens[0]];
        var a1 = validate(m1, tokens.slice(1).join(''));
        if (a1) return ok(m1, a1, 'id', m1.status !== 'open');
      }

      // Без номера — ответ на последний открытый вопрос.
      if (target) {
        var a2 = validate(target, digits);
        if (a2) return ok(target, a2, 'digits', t.correction);
      }

      // Номер слитно с ответом: «123» = вопрос #12, ответ 3.
      if (digits.length >= 3 && byId[+digits.slice(0, 2)]) {
        var m3 = byId[+digits.slice(0, 2)];
        var a3 = validate(m3, digits.slice(2));
        if (a3) return ok(m3, a3, 'id', m3.status !== 'open');
      }

      return {
        status: 'invalid', messageId: target ? target.id : null, digits: digits,
        note: 'Цифры не подходят к вопросу'
      };
    }

    var n = norm(raw);
    if (CALL.indexOf(n) >= 0) {
      return { status: 'call', messageId: target ? target.id : null, method: 'word' };
    }

    if (target) {
      var a4 = matchWords(target, raw);
      if (a4) return ok(target, a4, 'word', t.correction);

      var known = YES.indexOf(n) >= 0 || NO.indexOf(n) >= 0;
      var td = known ? null : t9Digits(raw);
      if (td) {
        var a5 = validate(target, td);
        if (a5) return ok(target, a5, 't9', t.correction);
      }
    }

    return { status: 'text', messageId: target ? target.id : null };
  }

  return {
    ID_MIN: ID_MIN,
    ID_MAX: ID_MAX,
    MAX_OPTIONS: MAX_OPTIONS,
    BATCH_LABELS: BATCH_LABELS,
    nextId: nextId,
    translit: translit,
    smsInfo: smsInfo,
    formatMessage: formatMessage,
    parseReply: parseReply,
    validate: validate
  };
});
