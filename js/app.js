/* Интерфейс «Ответ цифрой». Данные живут в localStorage этого браузера. */
(function () {
  'use strict';

  var P = window.SmsProtocol;
  var STORE_KEY = 'otvet-cifroy-v1';
  var MAX_BATCH = 5;

  var BUILTIN_TEMPLATES = [
    { name: 'Да / нет', questions: [{ text: '', options: ['да', 'нет'] }] },
    { name: 'Самочувствие', questions: [{ text: 'Как самочувствие?', options: ['хорошо', 'нормально', 'плохо'] }] },
    { name: 'Ты дома?', questions: [{ text: 'Ты дома?', options: ['да', 'нет', 'скоро буду'] }] },
    { name: 'Когда?', questions: [{ text: 'Когда удобно?', options: ['сегодня', 'завтра', 'на выходных'] }] },
    { name: 'Во сколько?', questions: [{ text: 'Во сколько?', options: ['утром', 'днём', 'вечером'] }] },
    { name: 'Приехать?', questions: [{ text: 'Приехать к тебе?', options: ['да', 'нет', 'позже'] }] },
    { name: 'Что купить?', questions: [{ text: 'Что купить?', options: ['хлеб', 'молоко', 'яйца', 'овощи', 'лекарства'], multi: true }] },
    { name: 'Утро (анкета)', questions: [
      { text: 'Как спала?', options: ['хорошо', 'плохо'] },
      { text: 'Лекарства?', options: ['выпила', 'нет'] },
      { text: 'Нужно что?', options: ['нет', 'да'] }
    ] }
  ];

  var DEFAULT_SETTINGS = { numbered: true, hint: false, callZero: true, showCall: false, translit: false };

  // ---------- состояние ----------

  var state = load();
  var builder = emptyBuilder();

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function newContact(name) {
    return { id: uid(), name: name || 'Собеседник', phone: '', lastId: 0, messages: [], replies: [] };
  }

  function load() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { s = null; }
    if (!s || !Array.isArray(s.contacts) || !s.contacts.length) {
      var c = newContact();
      s = { contacts: [c], activeContact: c.id, settings: {}, templates: [] };
    }
    s.settings = Object.assign({}, DEFAULT_SETTINGS, s.settings || {});
    s.templates = s.templates || [];
    if (!s.contacts.some(function (c) { return c.id === s.activeContact; })) s.activeContact = s.contacts[0].id;
    return s;
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast('Не удалось сохранить: ' + e.message); }
  }

  function contact() {
    return state.contacts.find(function (c) { return c.id === state.activeContact; }) || state.contacts[0];
  }

  function emptyBuilder() { return { questions: [{ text: '', options: ['', ''], multi: false }] }; }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ---------- утилиты DOM ----------

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) {
      if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  var toastTimer;
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    var now = new Date();
    var time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return time;
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + time;
  }

  function smsHref(phone, body) {
    var ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    return 'sms:' + (phone || '').replace(/[^\d+]/g, '') + (ios ? '&' : '?') + 'body=' + encodeURIComponent(body);
  }

  function openSms(phone, body) {
    window.location.href = smsHref(phone, body);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { toast('Скопировано'); }, fallback);
    }
    fallback();
    function fallback() {
      var ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Скопировано'); } catch (e) { toast('Не удалось скопировать'); }
      ta.remove();
    }
  }

  // ---------- вкладки ----------

  function showTab(name) {
    document.querySelectorAll('.tabs [role=tab]').forEach(function (b) {
      b.setAttribute('aria-selected', String(b.dataset.tab === name));
    });
    document.querySelectorAll('.tab').forEach(function (s) { s.hidden = s.id !== 'tab-' + name; });
    if (name === 'chat') renderTimeline();
    if (name === 'card') renderCard();
    if (name === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }

  document.querySelectorAll('.tabs [role=tab]').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.dataset.tab); });
  });
  document.querySelectorAll('[data-goto]').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.dataset.goto); });
  });

  // ---------- собеседник ----------

  function renderContactSelect() {
    var sel = $('contactSelect');
    sel.innerHTML = '';
    state.contacts.forEach(function (c) {
      sel.appendChild(el('option', { value: c.id, text: c.name }));
    });
    sel.value = state.activeContact;
    $('noPhone').hidden = !!contact().phone;
  }

  $('contactSelect').addEventListener('change', function (e) {
    state.activeContact = e.target.value;
    save();
    renderAll();
  });

  // ---------- конструктор вопроса ----------

  function currentMessage(id) {
    return { id: id, questions: builder.questions };
  }

  function previewText() {
    var c = contact();
    return P.formatMessage(currentMessage(P.nextId(c.lastId)), state.settings);
  }

  function builderProblems() {
    var qs = builder.questions;
    for (var i = 0; i < qs.length; i++) {
      var label = qs.length > 1 ? 'Вопрос ' + P.BATCH_LABELS[i] : 'Вопрос';
      if (!qs[i].text.trim()) return label + ': не заполнен текст';
      var n = qs[i].options.filter(function (o) { return o.trim(); }).length;
      if (n < 2 && !(qs[i].multi && n >= 1)) return label + ': нужно хотя бы 2 варианта';
    }
    return '';
  }

  function updatePreview() {
    var text = previewText();
    $('preview').textContent = text;
    var info = P.smsInfo(text);
    var counter = $('smsCounter');
    counter.textContent = info.length + ' симв. · ' + info.parts + ' SMS';
    counter.classList.toggle('over', info.parts > 1);
    var warn = $('smsWarn');
    if (info.parts > 1) {
      warn.hidden = false;
      warn.textContent = info.encoding === 'UCS-2'
        ? 'Не влезает в одно SMS (по-русски — 70 символов). Сократите варианты или включите «Латиницей» в настройках.'
        : 'Не влезает в одно SMS (160 символов). Сократите текст.';
    } else {
      warn.hidden = true;
    }
  }

  function renderBuilder() {
    var box = $('questions');
    box.innerHTML = '';
    var batch = builder.questions.length > 1;

    builder.questions.forEach(function (q, qi) {
      var optsBox = el('div', { class: 'opts' });
      q.options.forEach(function (o, oi) {
        var input = el('input', {
          type: 'text', class: 'opt', value: o, maxlength: 40,
          placeholder: oi === 0 ? 'да' : oi === 1 ? 'нет' : 'вариант',
          'aria-label': 'Вариант ' + (oi + 1),
          oninput: function (e) { q.options[oi] = e.target.value; updatePreview(); },
          onkeydown: function (e) {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (oi === q.options.length - 1 && q.options.length < P.MAX_OPTIONS) {
                q.options.push('');
                renderBuilder();
                focusLater('[data-q="' + qi + '"] .opt', q.options.length - 1);
              } else {
                var next = optsBox.querySelectorAll('.opt')[oi + 1];
                if (next) next.focus();
              }
            }
          }
        });
        optsBox.appendChild(el('div', { class: 'opt-row' }, [
          el('span', { class: 'num', text: String(oi + 1) }),
          input,
          q.options.length > 1 ? el('button', {
            class: 'icon', title: 'Убрать вариант', 'aria-label': 'Убрать вариант ' + (oi + 1),
            text: '×', onclick: function () { q.options.splice(oi, 1); renderBuilder(); }
          }) : null
        ]));
      });

      var card = el('div', { class: 'qcard', 'data-q': String(qi) }, [
        el('div', { class: 'qhead' }, [
          el('span', { class: 'qlabel', text: batch ? 'Вопрос ' + P.BATCH_LABELS[qi] : 'Вопрос' }),
          batch ? el('button', {
            class: 'icon', title: 'Убрать вопрос', 'aria-label': 'Убрать вопрос', text: '×',
            onclick: function () { builder.questions.splice(qi, 1); renderBuilder(); }
          }) : null
        ]),
        el('input', {
          type: 'text', class: 'qtext', value: q.text, maxlength: 80,
          placeholder: batch ? 'Короткий вопрос' : 'Например: Купить хлеб?',
          'aria-label': 'Текст вопроса',
          oninput: function (e) { q.text = e.target.value; updatePreview(); }
        }),
        optsBox,
        q.options.length < P.MAX_OPTIONS ? el('button', {
          class: 'ghost small', text: '+ вариант',
          onclick: function () {
            q.options.push('');
            renderBuilder();
            focusLater('[data-q="' + qi + '"] .opt', q.options.length - 1);
          }
        }) : null,
        !batch ? el('label', { class: 'toggle inline' }, [
          el('input', {
            type: 'checkbox', checked: q.multi || null,
            onchange: function (e) { q.multi = e.target.checked; updatePreview(); }
          }),
          el('span', { text: 'Можно выбрать несколько (ответ «13»)' })
        ]) : null
      ]);
      box.appendChild(card);
    });

    if (batch) builder.questions.forEach(function (q) { q.multi = false; });
    $('addQuestion').hidden = builder.questions.length >= MAX_BATCH;
    updatePreview();
  }

  function focusLater(selector, index) {
    setTimeout(function () {
      var list = document.querySelectorAll(selector);
      if (list[index]) list[index].focus();
    }, 0);
  }

  $('addQuestion').addEventListener('click', function () {
    builder.questions.push({ text: '', options: ['да', 'нет'], multi: false });
    renderBuilder();
    focusLater('.qtext', builder.questions.length - 1);
  });

  $('clearBuilder').addEventListener('click', function () {
    builder = emptyBuilder();
    renderBuilder();
  });

  function renderTemplates() {
    var box = $('templates');
    box.innerHTML = '';
    var all = BUILTIN_TEMPLATES.map(function (t) { return { t: t, custom: false }; })
      .concat(state.templates.map(function (t) { return { t: t, custom: true }; }));
    all.forEach(function (item, i) {
      var t = item.t;
      var chip = el('button', {
        class: 'chip' + (item.custom ? ' custom' : ''), text: t.name,
        title: item.custom ? 'Удерживайте или нажмите правой кнопкой, чтобы удалить' : null,
        onclick: function () {
          builder = { questions: clone(t.questions).map(function (q) {
            return { text: q.text || '', options: q.options.slice(), multi: !!q.multi };
          }) };
          renderBuilder();
          if (!builder.questions[0].text) focusLater('.qtext', 0);
        }
      });
      if (item.custom) {
        chip.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          if (confirm('Удалить шаблон «' + t.name + '»?')) {
            state.templates.splice(i - BUILTIN_TEMPLATES.length, 1);
            save();
            renderTemplates();
          }
        });
      }
      box.appendChild(chip);
    });
  }

  $('saveTemplate').addEventListener('click', function () {
    var problem = builderProblems();
    if (problem) return toast(problem);
    var name = prompt('Название шаблона', builder.questions[0].text.slice(0, 24));
    if (!name) return;
    state.templates.push({ name: name.trim(), questions: clone(builder.questions) });
    save();
    renderTemplates();
    toast('Шаблон сохранён');
  });

  function recordSent() {
    var c = contact();
    var id = P.nextId(c.lastId);
    var questions = clone(builder.questions).map(function (q) {
      return {
        text: q.text.trim(),
        options: q.options.map(function (o) { return o.trim(); }).filter(Boolean),
        multi: builder.questions.length === 1 && !!q.multi
      };
    });
    var text = P.formatMessage({ id: id, questions: questions }, state.settings);
    // Номер освободился по кругу — старый вопрос с тем же номером закрываем.
    c.messages.forEach(function (m) { if (m.id === id && m.status === 'open') m.status = 'closed'; });
    c.messages.push({
      id: id, createdAt: Date.now(), status: 'open', text: text, questions: questions,
      picked: questions.map(function () { return []; }), call: false
    });
    c.lastId = id;
    save();
    return text;
  }

  $('sendBtn').addEventListener('click', function () {
    var problem = builderProblems();
    if (problem) return toast(problem);
    var text = recordSent();
    var phone = contact().phone;
    builder = emptyBuilder();
    renderBuilder();
    renderBadge();
    showTab('chat');
    openSms(phone, text);
  });

  $('copyBtn').addEventListener('click', function () {
    var problem = builderProblems();
    if (problem) return toast(problem);
    var text = recordSent();
    copyText(text);
    builder = emptyBuilder();
    renderBuilder();
    renderBadge();
    toast('Скопировано. Вставьте в SMS — вопрос ждёт ответа во вкладке «Ответы»');
  });

  // ---------- ответы ----------

  function applyResult(c, result, raw) {
    var reply = { at: Date.now(), raw: raw, result: result };
    c.replies.push(reply);
    var msg = c.messages.find(function (m) { return m.id === result.messageId; });
    if (result.status === 'ok' && msg) {
      result.answers.forEach(function (a) { msg.picked[a.question] = a.values.slice(); });
      msg.status = 'answered';
      msg.answeredAt = reply.at;
    } else if (result.status === 'call' && msg) {
      msg.call = true;
    }
    save();
  }

  function describeResult(c, r) {
    var msg = c.messages.find(function (m) { return m.id === r.messageId; });
    switch (r.status) {
      case 'ok':
        var parts = r.answers.map(function (a) {
          var prefix = msg && msg.questions.length > 1 ? P.BATCH_LABELS[a.question] + ') ' : '';
          return prefix + a.labels.join(', ');
        });
        var how = r.method === 't9' ? ' (набрано буквами — понято по кнопкам)'
          : r.method === 'word' ? ' (словами)' : '';
        return {
          kind: 'ok',
          text: (r.correction ? 'Исправление к #' : 'Ответ на #') + r.messageId + ': ' + parts.join('; ') + how
        };
      case 'call':
        return { kind: 'call', text: 'Просит позвонить' };
      case 'invalid':
        return { kind: 'warn', text: 'Цифры «' + r.digits + '» не подходят ни к одному вопросу — возможно, опечатка. Можно отметить ответ вручную.' };
      case 'text':
        return { kind: 'text', text: 'Обычное сообщение, не ответ цифрой' };
      default:
        return { kind: 'warn', text: 'Пусто' };
    }
  }

  function handleReply(raw) {
    var c = contact();
    raw = String(raw || '').trim();
    if (!raw) return toast('Вставьте текст ответа');
    var result = P.parseReply(raw, c.messages.filter(function (m) { return m.status !== 'closed'; }), state.settings);
    applyResult(c, result, raw);
    var d = describeResult(c, result);
    var box = $('parseResult');
    box.className = 'result ' + d.kind;
    box.textContent = d.text;
    $('replyInput').value = '';
    renderTimeline();
    renderBadge();
  }

  $('parseBtn').addEventListener('click', function () { handleReply($('replyInput').value); });
  $('replyInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); handleReply(e.target.value); }
  });

  $('pasteBtn').addEventListener('click', function () {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      $('replyInput').focus();
      return toast('Вставьте вручную: долгое нажатие → «Вставить»');
    }
    navigator.clipboard.readText().then(function (t) {
      $('replyInput').value = t.trim();
      if (t.trim()) handleReply(t);
    }, function () {
      $('replyInput').focus();
      toast('Нет доступа к буферу — вставьте вручную');
    });
  });

  function togglePick(msg, qi, value) {
    var q = msg.questions[qi];
    var cur = msg.picked[qi] || [];
    if (q.multi) {
      cur = cur.indexOf(value) >= 0 ? cur.filter(function (v) { return v !== value; }) : cur.concat(value).sort();
    } else {
      cur = cur[0] === value ? [] : [value];
    }
    msg.picked[qi] = cur;
    var done = msg.picked.every(function (p) { return p && p.length; });
    msg.status = done ? 'answered' : 'open';
    if (done) msg.answeredAt = Date.now();
    save();
    renderTimeline();
    renderBadge();
  }

  function renderOutgoing(c, msg) {
    var batch = msg.questions.length > 1;
    var status = msg.status === 'answered' ? 'отвечено' : msg.status === 'closed' ? 'закрыт' : 'ждём ответа';
    var body = msg.questions.map(function (q, qi) {
      var chips = q.options.map(function (o, oi) {
        var v = oi + 1;
        var on = (msg.picked[qi] || []).indexOf(v) >= 0;
        return el('button', {
          class: 'chip pick' + (on ? ' on' : ''), 'aria-pressed': String(on),
          title: 'Отметить ответ вручную',
          onclick: function () { togglePick(msg, qi, v); }
        }, [el('b', { text: String(v) }), ' ' + o]);
      });
      return el('div', { class: 'oq' }, [
        el('div', { class: 'oqtext', text: (batch ? P.BATCH_LABELS[qi] + ') ' : '') + q.text + (q.multi ? ' (несколько)' : '') }),
        el('div', { class: 'chips' }, chips)
      ]);
    });

    return el('li', { class: 'out ' + msg.status }, [
      el('div', { class: 'meta' }, [
        el('span', { class: 'id', text: '#' + msg.id }),
        el('span', { text: fmtTime(msg.createdAt) }),
        el('span', { class: 'status', text: status })
      ]),
      msg.call ? el('div', { class: 'callflag', text: 'Просит позвонить' }) : null
    ].concat(body).concat([
      el('div', { class: 'row-actions' }, [
        el('button', {
          class: 'link', text: 'Отправить ещё раз',
          onclick: function () { openSms(c.phone, msg.text); }
        }),
        el('button', {
          class: 'link', text: 'Спросить снова',
          onclick: function () {
            builder = { questions: clone(msg.questions) };
            showTab('ask');
            renderBuilder();
          }
        }),
        el('button', {
          class: 'link danger', text: 'Удалить',
          onclick: function () {
            if (!confirm('Удалить вопрос #' + msg.id + '?')) return;
            c.messages.splice(c.messages.indexOf(msg), 1);
            save();
            renderTimeline();
            renderBadge();
          }
        })
      ])
    ]));
  }

  function renderIncoming(c, reply) {
    var d = describeResult(c, reply.result);
    return el('li', { class: 'in ' + d.kind }, [
      el('div', { class: 'meta' }, [el('span', { text: fmtTime(reply.at) })]),
      el('div', { class: 'raw', text: reply.raw }),
      el('div', { class: 'interp', text: d.text }),
      el('div', { class: 'row-actions' }, [
        el('button', {
          class: 'link danger', text: 'Удалить',
          onclick: function () {
            c.replies.splice(c.replies.indexOf(reply), 1);
            save();
            renderTimeline();
          }
        })
      ])
    ]);
  }

  function renderTimeline() {
    var c = contact();
    var list = $('timeline');
    list.innerHTML = '';
    var items = c.messages.map(function (m) { return { at: m.createdAt, node: function () { return renderOutgoing(c, m); } }; })
      .concat(c.replies.map(function (r) { return { at: r.at, node: function () { return renderIncoming(c, r); } }; }))
      .sort(function (a, b) { return b.at - a.at; });
    items.slice(0, 200).forEach(function (it) { list.appendChild(it.node()); });
    $('emptyChat').hidden = items.length > 0;
  }

  function renderBadge() {
    var n = contact().messages.filter(function (m) { return m.status === 'open'; }).length;
    var b = $('openBadge');
    b.hidden = n === 0;
    b.textContent = String(n);
    b.title = 'Вопросов без ответа: ' + n;
  }

  // ---------- памятка ----------

  function cardExample() {
    var s = state.settings;
    var ex = P.formatMessage({ id: 12, questions: [{ text: 'Купить хлеб?', options: ['да', 'нет'] }] },
      { numbered: s.numbered, translit: s.translit, showCall: s.showCall });
    var exBatch = P.formatMessage({ id: 13, questions: [
      { text: 'Как спала?', options: ['хорошо', 'плохо'] },
      { text: 'Ела?', options: ['да', 'нет'] }
    ] }, { numbered: s.numbered, translit: s.translit });
    return { single: ex, batch: exBatch };
  }

  function renderCard() {
    var s = state.settings;
    var ex = cardExample();
    var card = $('card');
    card.innerHTML = '';
    var steps = [
      el('li', {}, [
        'Придёт вопрос с вариантами:',
        el('pre', { class: 'sms', text: ex.single })
      ]),
      el('li', {}, [
        'Нажмите «Ответить» и отправьте ', el('b', { text: 'одну цифру' }), ' — номер варианта. ',
        'Здесь «1» значит «да».'
      ]),
      el('li', {}, [
        'Если вопросов несколько (А, Б, В) — отправьте ', el('b', { text: 'цифры подряд' }), ':',
        el('pre', { class: 'sms', text: ex.batch }),
        'Ответ ', el('b', { text: '12' }), ' = «хорошо» и «нет».'
      ])
    ];
    if (s.callZero) steps.push(el('li', {}, [el('b', { text: '0' }), ' — «позвони мне».']));
    if (s.numbered) steps.push(el('li', {}, [
      'Ответить на старый вопрос: номер, пробел, цифра. Например ', el('b', { text: '12 1' }), '.'
    ]));
    steps.push(el('li', {}, [
      'Чтобы набрать цифру, ', el('b', { text: 'держите кнопку нажатой' }),
      ' или переключите режим кнопкой #. Получилась буква вместо цифры — не страшно, поймём.'
    ]));
    steps.push(el('li', {}, ['Можно ответить и словами: «да», «нет».']));

    card.appendChild(el('h2', { text: 'Как отвечать на SMS' + (contact().name !== 'Собеседник' ? ' — ' + contact().name : '') }));
    card.appendChild(el('ol', {}, steps));
  }

  function cardSms() {
    var s = state.settings;
    var text = 'Как отвечать: на вопрос с вариантами 1-да 2-нет пришли одну цифру. ' +
      'Если вопросов несколько (А,Б,В) - цифры подряд, напр. 12.' +
      (s.callZero ? ' 0 - позвони мне.' : '');
    return s.translit ? P.translit(text) : text;
  }

  $('printBtn').addEventListener('click', function () { window.print(); });
  $('sendCardBtn').addEventListener('click', function () { openSms(contact().phone, cardSms()); });

  // ---------- настройки ----------

  function renderSettings() {
    var box = $('contacts');
    box.innerHTML = '';
    state.contacts.forEach(function (c) {
      box.appendChild(el('div', { class: 'contact-row' + (c.id === state.activeContact ? ' active' : '') }, [
        el('input', {
          type: 'text', value: c.name, placeholder: 'Имя', 'aria-label': 'Имя',
          oninput: function (e) { c.name = e.target.value || 'Собеседник'; save(); renderContactSelect(); }
        }),
        el('input', {
          type: 'tel', value: c.phone, placeholder: '+7 900 000-00-00', 'aria-label': 'Телефон',
          inputmode: 'tel', autocomplete: 'tel',
          oninput: function (e) { c.phone = e.target.value.trim(); save(); renderContactSelect(); }
        }),
        state.contacts.length > 1 ? el('button', {
          class: 'icon', text: '×', title: 'Удалить собеседника', 'aria-label': 'Удалить ' + c.name,
          onclick: function () {
            if (!confirm('Удалить «' + c.name + '» вместе с перепиской?')) return;
            state.contacts.splice(state.contacts.indexOf(c), 1);
            if (state.activeContact === c.id) state.activeContact = state.contacts[0].id;
            save();
            renderAll();
            renderSettings();
          }
        }) : null
      ]));
    });

    document.querySelectorAll('[data-setting]').forEach(function (input) {
      input.checked = !!state.settings[input.dataset.setting];
    });
  }

  $('addContact').addEventListener('click', function () {
    var c = newContact('Собеседник ' + (state.contacts.length + 1));
    state.contacts.push(c);
    state.activeContact = c.id;
    save();
    renderAll();
    renderSettings();
    var inputs = document.querySelectorAll('.contact-row input[type=text]');
    if (inputs.length) { inputs[inputs.length - 1].select(); inputs[inputs.length - 1].focus(); }
  });

  document.querySelectorAll('[data-setting]').forEach(function (input) {
    input.addEventListener('change', function () {
      state.settings[input.dataset.setting] = input.checked;
      save();
      updatePreview();
    });
  });

  $('exportBtn').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var a = el('a', { href: URL.createObjectURL(blob), download: 'otvet-cifroy-' + new Date().toISOString().slice(0, 10) + '.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  $('importInput').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    file.text().then(function (t) {
      var data = JSON.parse(t);
      if (!data || !Array.isArray(data.contacts)) throw new Error('не тот файл');
      if (!confirm('Заменить текущие данные загруженной копией?')) return;
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
      state = load();
      renderAll();
      renderSettings();
      toast('Копия загружена');
    }).catch(function (err) { toast('Не получилось: ' + err.message); });
    e.target.value = '';
  });

  // ---------- запуск ----------

  function renderAll() {
    renderContactSelect();
    renderTemplates();
    renderBuilder();
    renderTimeline();
    renderBadge();
  }

  renderAll();

  // Ответ, пришедший через «Поделиться» из приложения SMS (Web Share Target).
  (function handleShare() {
    var params = new URLSearchParams(location.search);
    var shared = params.get('text') || params.get('title');
    if (!shared) return;
    history.replaceState(null, '', location.pathname);
    showTab('chat');
    handleReply(shared);
  })();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
