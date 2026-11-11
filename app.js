(() => {
  'use strict';

  const AVATARS = ['🦊', '🦉', '🐢', '🐬', '🦁', '🐙', '🐼', '🦄'];
  const COLORS = ['#FF5A5F', '#FF9F1C', '#12B886', '#228BE6', '#7950F2', '#F06595'];
  const ROUND_EMOJI = { quiz: '🧠', flags: '🌍', lie: '🤥' };
  const LETTERS = ['Α', 'Β', 'Γ', 'Δ'];
  const GREEK_TO_LATIN = { 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Χ': 'X', 'Υ': 'Y', 'Ζ': 'Z' };

  const $ = id => document.getElementById(id);
  const screen = $('screen'), topBar = $('top'), banner = $('banner'), toastEl = $('toast'), fx = $('fx');

  let S = null;          // τελευταία κατάσταση από τον server
  let session = null;    // { code, token }
  let es = null;         // EventSource
  let lastKey = '';
  let lastFxKey = '';
  let deadline = 0;
  let connLost = false;
  let qEls = null;       // στοιχεία της οθόνης ερώτησης

  /* ---------- μικρά βοηθητικά ---------- */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ιδιωτική περιήγηση */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* αγνοείται */ } },
  };
  function normCode(code) {
    return String(code || '').toUpperCase().replace(/./g, ch => GREEK_TO_LATIN[ch] || ch).replace(/[^A-Z]/g, '').slice(0, 4);
  }
  async function post(path, body) {
    let res;
    try {
      res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error('Δεν υπάρχει σύνδεση με τον διακομιστή. Δοκίμασε ξανά.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Κάτι πήγε στραβά.');
    return data;
  }
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }
  async function copy(text, msg) {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const ta = h('textarea', { style: 'position:fixed;opacity:0' });
        ta.value = text;
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast(msg);
    } catch (e) {
      toast('Δεν έγινε αντιγραφή. Κωδικός: ' + (S ? S.code : ''));
    }
  }
  function avatarEl(p, size) {
    return h('span', { class: 'av' + (size ? ' ' + size : ''), style: `--c:${COLORS[p.color] || COLORS[0]}` }, AVATARS[p.avatar] || AVATARS[0]);
  }
  function flagEmoji(code) {
    return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
  }
  const fmt = n => Number(n).toLocaleString('el-GR');
  const meP = () => S.players.find(p => p.id === S.me);
  const oppP = () => S.players.find(p => p.id !== S.me);

  /* ---------- αρχική οθόνη ---------- */
  const prefs = Object.assign(
    { name: '', avatar: Math.floor(Math.random() * AVATARS.length), color: Math.floor(Math.random() * COLORS.length) },
    store.get('gm:prefs') || {});

  function renderHome(linkCode, message) {
    S = null; lastKey = ''; qEls = null;
    topBar.hidden = true; banner.hidden = true;
    const nameIn = h('input', { class: 'input', maxlength: 14, placeholder: 'π.χ. Μαρία', autocomplete: 'nickname', 'aria-label': 'Το όνομά σου', enterkeyhint: 'done' });
    nameIn.value = prefs.name || '';
    const codeIn = h('input', { class: 'input code', maxlength: 4, placeholder: '• • • •', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Κωδικός δωματίου' });
    codeIn.value = linkCode || '';
    codeIn.addEventListener('input', () => { codeIn.value = normCode(codeIn.value); });
    const err = h('p', { class: 'error', role: 'alert' }, message || '');

    const avatarBtns = AVATARS.map((a, i) => h('button', { type: 'button', class: 'pick', 'aria-label': 'Avatar ' + a, onclick: () => { prefs.avatar = i; mark(); } }, a));
    const colorBtns = COLORS.map((c, i) => h('button', { type: 'button', class: 'pick swatch', style: `background:${c}`, 'aria-label': 'Χρώμα ' + (i + 1), onclick: () => { prefs.color = i; mark(); } }));
    function mark() {
      avatarBtns.forEach((b, i) => b.classList.toggle('on', i === prefs.avatar));
      colorBtns.forEach((b, i) => b.classList.toggle('on', i === prefs.color));
    }
    mark();

    let busy = false;
    async function enter(kind) {
      if (busy) return;
      err.textContent = '';
      prefs.name = nameIn.value.trim();
      if (!prefs.name) { err.textContent = 'Γράψε πρώτα το όνομά σου.'; nameIn.focus(); return; }
      const code = normCode(codeIn.value);
      if (kind === 'join' && code.length !== 4) { err.textContent = 'Ο κωδικός έχει 4 γράμματα.'; codeIn.focus(); return; }
      store.set('gm:prefs', prefs);
      busy = true;
      try {
        const saved = kind === 'join' ? store.get('gm:s:' + code) : null;
        const r = await post(kind === 'create' ? '/api/create' : '/api/join',
          { name: prefs.name, avatar: prefs.avatar, color: prefs.color, code, token: saved && saved.token });
        startSession(r.code, r.token);
      } catch (e) {
        err.textContent = e.message;
        busy = false;
      }
    }
    const joinBtn = h('button', { class: 'btn' + (linkCode ? '' : ' alt'), onclick: () => enter('join') }, 'Μπες στο δωμάτιο');
    const createBtn = h('button', { class: 'btn' + (linkCode ? ' ghost' : ''), onclick: () => enter('create') }, linkCode ? 'Φτιάξε καινούριο δωμάτιο' : 'Δημιούργησε δωμάτιο');
    const joinBlock = h('div', { class: 'stack' }, codeIn, joinBtn);

    screen.replaceChildren(
      h('div', { class: 'logo' },
        h('span', { class: 'mark' }, '🧠'),
        h('h1', null, 'Γνωσιο', h('span', null, 'μαχία')),
        h('p', null, 'Μονομαχία γνώσεων για δύο')),
      h('div', { class: 'card pop' },
        h('p', { class: 'label' }, 'Το όνομά σου'), nameIn,
        h('p', { class: 'label' }, 'Avatar'), h('div', { class: 'picker' }, avatarBtns),
        h('p', { class: 'label' }, 'Χρώμα'), h('div', { class: 'picker colors' }, colorBtns),
        linkCode
          ? [h('p', { class: 'label' }, 'Σε κάλεσαν στο δωμάτιο'), joinBlock, h('div', { class: 'or' }, 'ή'), createBtn]
          : [h('div', { style: 'height:18px' }), createBtn, h('div', { class: 'or' }, 'ή μπες με κωδικό'), joinBlock],
        err));
  }

  /* ---------- σύνδεση ---------- */
  function startSession(code, token) {
    session = { code, token };
    store.set('gm:s:' + code, { token });
    history.replaceState(null, '', '?room=' + code);
    connect();
  }
  function connect() {
    if (es) es.close();
    es = new EventSource(`/api/events?code=${session.code}&token=${session.token}`);
    es.addEventListener('state', e => { connLost = false; onState(JSON.parse(e.data)); });
    es.onopen = () => { connLost = false; if (S) updateBanner(); };
    es.onerror = () => {
      if (unloading) return;
      connLost = true;
      if (S) updateBanner();
      // readyState 2: ο browser σταμάτησε να προσπαθεί. Ελέγχουμε αν υπάρχει ακόμη το δωμάτιο.
      if (es.readyState === 2) verifySeat();
    };
  }
  let verifying = false;
  async function verifySeat() {
    if (verifying || !session) return;
    verifying = true;
    try {
      const res = await fetch('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: session.code, token: session.token, resumeOnly: true }) });
      if (res.status === 404) leave('Το δωμάτιο δεν υπάρχει πια. Φτιάξε ένα καινούριο.');
      else if (res.ok) connect();
      else setTimeout(() => { if (session && es && es.readyState === 2) verifySeat(); }, 3000);
    } catch (e) {
      // χωρίς δίκτυο: ξαναδοκιμάζουμε σε λίγο
      setTimeout(() => { if (session && es && es.readyState === 2) verifySeat(); }, 3000);
    } finally {
      verifying = false;
    }
  }
  let unloading = false;
  window.addEventListener('pagehide', () => { unloading = true; if (es) es.close(); });
  window.addEventListener('pageshow', e => { unloading = false; if (e.persisted && session) connect(); });
  function leave(message) {
    if (es) { es.close(); es = null; }
    if (session) store.del('gm:s:' + session.code);
    session = null;
    history.replaceState(null, '', location.pathname);
    renderHome('', message);
  }
  function act(type, extra) {
    return post('/api/action', Object.assign({ code: session.code, token: session.token, type }, extra)).catch(e => toast(e.message));
  }
  // κρατά «ξύπνιο» τον δωρεάν server όσο υπάρχει ανοιχτό παιχνίδι
  setInterval(() => { if (session) fetch('/healthz').catch(() => {}); }, 4 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && session && es && es.readyState === 2) verifySeat();
  });

  /* ---------- νέα κατάσταση ---------- */
  function onState(s) {
    S = s;
    deadline = performance.now() + s.remaining;
    const inQ = s.phase === 'question' || s.phase === 'reveal';
    const key = inQ ? `q|${s.round}|${s.qIndex}` : `${s.phase}|${s.round}`;
    const fresh = key !== lastKey;
    lastKey = key;
    if (inQ) { if (fresh || !qEls) buildQuestion(); updateQuestion(); }
    else { qEls = null; renderPhase(fresh); }
    renderTop();
    updateBanner();
    const fxKey = `${s.phase}|${s.round}|${s.qIndex}`;
    if (fxKey !== lastFxKey) { lastFxKey = fxKey; effects(); }
    if (fresh) window.scrollTo({ top: 0 });
  }

  function renderTop() {
    if (S.phase === 'lobby') { topBar.hidden = true; return; }
    topBar.hidden = false;
    const chip = (p, right) => p ? h('div', { class: 'chipP' + (right ? ' right' : '') + (p.connected ? '' : ' off') },
      avatarEl(p),
      h('div', { class: 'who' },
        h('div', { class: 'nm' }, p.name),
        h('div', { class: 'sc' }, fmt(p.score), p.answered ? h('span', { class: 'tick' }, ' ✓') : null))) : h('div');
    topBar.replaceChildren(
      chip(meP(), false),
      h('div', { class: 'mid-label' }, S.phase === 'final' ? 'Τέλος' : ['Γύρος', h('b', null, `${S.round + 1}/${S.roundCount}`)]),
      chip(oppP(), true));
  }

  function updateBanner() {
    const opp = oppP();
    let msg = '';
    if (connLost) msg = 'Χάθηκε η σύνδεση. Γίνεται επανασύνδεση…';
    else if (opp && !opp.connected && S.phase !== 'lobby') {
      msg = `Αποσυνδέθηκε: ${opp.name}. ` + (S.paused ? 'Το παιχνίδι περιμένει μέχρι να ξαναμπεί.' : 'Μπορεί να ξαναμπεί με τον ίδιο κωδικό.');
    }
    banner.hidden = !msg;
    banner.textContent = msg;
  }

  /* ---------- οθόνες εκτός ερώτησης ---------- */
  function renderPhase(fresh) {
    const pop = fresh ? ' pop' : '';
    if (S.phase === 'lobby') return renderLobby(pop);
    if (S.phase === 'intro') {
      return screen.replaceChildren(h('div', { class: 'card intro' + pop },
        h('p', { class: 'n' }, `Γύρος ${S.round + 1} από ${S.roundCount}`),
        h('span', { class: 'emoji' }, ROUND_EMOJI[S.roundKey] || '🎲'),
        h('h2', null, S.roundName),
        h('p', null, S.roundDesc),
        h('p', { class: 'count', 'data-count': 'Ξεκινάμε σε' })));
    }
    if (S.phase === 'roundEnd') {
      const sorted = S.players.slice().sort((a, b) => b.score - a.score);
      const tie = sorted.length > 1 && sorted[0].score === sorted[1].score;
      const last = S.round === S.roundCount - 1;
      return screen.replaceChildren(h('div', { class: 'card' + pop },
        h('p', { class: 'label' }, `Κατάταξη μετά τον γύρο ${S.round + 1}`),
        h('div', { class: 'stack' }, sorted.map((p, i) => h('div', { class: 'rank' + (i === 0 && !tie ? ' lead' : '') },
          h('span', { class: 'pos' }, tie ? '=' : i + 1),
          avatarEl(p),
          h('span', { class: 'nm' }, p.name + (p.id === S.me ? ' (εσύ)' : ''), h('small', null, `+${fmt(p.rounds[S.round])} στον γύρο`)),
          h('span', { class: 'tot' }, fmt(p.score))))),
        h('p', { class: 'count center', 'data-count': last ? 'Τελικά αποτελέσματα σε' : 'Επόμενος γύρος σε' })));
    }
    if (S.phase === 'final') return renderFinal(pop);
  }

  function renderLobby(pop) {
    const me = meP(), opp = oppP();
    const isHost = S.hostId === S.me;
    const ready = !!opp && opp.connected;
    const seat = p => p
      ? h('div', { class: 'seat' }, avatarEl(p, 'mid'), h('div', null,
        h('div', { class: 'nm' }, p.name + (p.id === S.me ? ' (εσύ)' : '')),
        h('div', { class: 'sub' }, !p.connected ? 'Εκτός σύνδεσης' : p.id === S.hostId ? 'Έφτιαξε το δωμάτιο' : 'Μπήκε στο δωμάτιο')))
      : h('div', { class: 'seat empty' }, h('span', { class: 'av mid', style: '--c:#E4E1F5' }, '❔'), h('div', { class: 'nm dots' }, 'Περιμένουμε τον αντίπαλο'));
    screen.replaceChildren(
      h('div', { class: 'card' + pop },
        h('p', { class: 'label center' }, 'Κωδικός δωματίου'),
        h('div', { class: 'codebox', role: 'img', 'aria-label': 'Κωδικός ' + S.code.split('').join(' ') }, S.code.split('').map(ch => h('span', null, ch))),
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost small', onclick: () => copy(S.code, 'Ο κωδικός αντιγράφηκε!') }, 'Αντιγραφή κωδικού'),
          h('button', { class: 'btn alt small', onclick: share }, 'Μοιράσου το link')),
        h('p', { class: 'label' }, 'Παίκτες'),
        h('div', { class: 'stack' }, seat(me), seat(opp)),
        h('div', { style: 'height:16px' }),
        isHost
          ? h('button', { class: 'btn', disabled: !ready, onclick: () => act('start') }, ready ? 'Ξεκινάμε!' : 'Χρειάζεται δεύτερος παίκτης')
          : h('p', { class: 'hint' }, 'Το παιχνίδι ξεκινά μόλις πατήσει «Ξεκινάμε!» ο οικοδεσπότης.')),
      h('button', { class: 'linkbtn', onclick: () => leave('') }, 'Έξοδος από το δωμάτιο'));
  }
  async function share() {
    const url = `${location.origin}/?room=${S.code}`;
    const text = `Έλα να παίξουμε Γνωσιομαχία! Κωδικός δωματίου: ${S.code}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Γνωσιομαχία', text, url }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    copy(url, 'Το link αντιγράφηκε!');
  }

  function renderFinal(pop) {
    const me = meP(), opp = oppP();
    const sorted = S.players.slice().sort((a, b) => b.score - a.score);
    const tie = sorted.length > 1 && sorted[0].score === sorted[1].score;
    const win = sorted[0];
    const cell = (p, key, other) => {
      const st = p.stats[key];
      const avg = st.answered ? (st.timeMs / st.answered / 1000).toFixed(1).replace('.', ',') + '″' : '–';
      return h('td', { class: other && st.points > other.stats[key].points ? 'best' : '' },
        h('b', null, fmt(st.points)), h('small', null, `${st.correct}/${st.total} σωστές`), h('small', null, `μ.ό. ${avg}`));
    };
    const cols = [me, opp].filter(Boolean);
    const table = h('table', { class: 'stats' },
      h('thead', null, h('tr', null, h('th', null, 'Mini-game'), cols.map(p => h('th', null, p.name)))),
      h('tbody', null,
        S.roundNames.map(r => h('tr', null, h('td', null, (ROUND_EMOJI[r.key] || '') + ' ' + r.name),
          cols.map(p => cell(p, r.key, cols.find(x => x !== p))))),
        h('tr', null, h('td', null, 'Σύνολο'), cols.map(p => h('td', null, h('b', null, fmt(p.score)))))));
    let status = '';
    if (opp && !opp.connected) status = `${opp.name}: εκτός σύνδεσης.`;
    else if (me.rematch && !(opp && opp.rematch)) status = 'Περιμένουμε να δεχτεί ρεβάνς και ο αντίπαλος…';
    else if (opp && opp.rematch && !me.rematch) status = `${opp.name}: ζητά ρεβάνς!`;
    screen.replaceChildren(
      h('div', { class: 'card winner' + pop },
        h('span', { class: 'crown' }, tie ? '🤝' : '👑'),
        tie ? h('div', { class: 'row', style: 'justify-content:center;gap:0' }, sorted.map(p => avatarEl(p, 'big'))) : avatarEl(win, 'big'),
        h('h2', null, tie ? 'Ισοπαλία!' : win.id === S.me ? 'Νίκησες!' : `Νίκη: ${win.name}`),
        h('p', null, sorted.map(p => `${p.name} ${fmt(p.score)}`).join('  ·  '))),
      h('div', { class: 'card' }, h('p', { class: 'label' }, 'Στατιστικά ανά mini-game'), table),
      h('div', { class: 'card stack' },
        h('button', { class: 'btn', disabled: me.rematch, onclick: () => act('rematch') }, me.rematch ? 'Ζήτησες ρεβάνς ✓' : 'Ρεβάνς'),
        status ? h('p', { class: 'hint' }, status) : null,
        h('p', { class: 'hint' }, `Ίδιο δωμάτιο, ίδιος κωδικός: ${S.code}`)),
      h('button', { class: 'linkbtn', onclick: () => leave('') }, 'Έξοδος από το δωμάτιο'));
  }

  /* ---------- οθόνη ερώτησης ---------- */
  function buildQuestion() {
    const q = S.q;
    const buttons = q.options.map((text, i) => h('button', { class: 'opt', onclick: () => choose(i) },
      h('span', { class: 'k' }, LETTERS[i]), h('span', { class: 't' }, text), h('span', { class: 'who' })));
    let flag = null;
    if (q.flag) {
      const img = h('img', { src: `https://flagcdn.com/w320/${q.flag}.png`, alt: 'Σημαία χώρας', width: 240, height: 160 });
      // αν δεν φορτώσει η εικόνα, δείχνουμε τη σημαία ως emoji
      img.addEventListener('error', () => img.replaceWith(h('span', { class: 'emoji' }, flagEmoji(q.flag))));
      flag = h('div', { class: 'flagwrap' }, img);
    }
    qEls = {
      buttons,
      bar: h('div', { class: 'bar' }),
      secs: h('span', { class: 'secs' }),
      timer: null,
      status: h('p', { class: 'status', role: 'status' }),
      expl: h('div', { class: 'expl', hidden: true }),
    };
    qEls.timer = h('div', { class: 'timer' }, h('div', { class: 'track' }, qEls.bar), qEls.secs);
    screen.replaceChildren(h('div', { class: 'card pop' + (q.type === 'lie' ? ' lie' : '') },
      h('div', { class: 'meta' },
        h('span', { class: 'tag' }, q.category),
        h('span', { class: 'tag ' + q.level }, q.level === 'hard' ? 'Δύσκολη' : 'Εύκολη'),
        h('span', { class: 'qn' }, `${S.qIndex + 1} / ${S.qCount}`)),
      qEls.timer,
      h('h2', { class: 'qtext' }, q.text),
      flag,
      h('div', { class: 'opts' }, buttons),
      qEls.status, qEls.expl));
  }
  function choose(i) {
    if (!S || S.phase !== 'question' || S.myChoice != null || S.paused) return;
    S.myChoice = i; // άμεση ανταπόκριση, πριν απαντήσει ο server
    updateQuestion();
    act('answer', { choice: i });
  }
  function updateQuestion() {
    const rev = S.phase === 'reveal' ? S.reveal : null;
    const me = meP(), opp = oppP();
    qEls.buttons.forEach((b, i) => {
      const who = b.querySelector('.who');
      b.disabled = !!rev || S.myChoice != null || S.paused;
      let cls = 'opt';
      if (rev) {
        const pickers = S.players.filter(p => rev.picks[p.id] && rev.picks[p.id].choice === i);
        if (i === rev.correct) cls += ' right';
        else if (S.myChoice === i) cls += ' wrong';
        else cls += ' dim';
        who.replaceChildren(...pickers.map(p => avatarEl(p, 'tiny')));
      } else {
        if (S.myChoice === i) cls += ' chosen';
        else if (S.myChoice != null) cls += ' dim';
        who.replaceChildren();
      }
      if (b.className !== cls) b.className = cls;
    });
    let text = '', sc = 'status';
    if (rev) {
      const mine = rev.picks[S.me] || {};
      if (mine.ok) { text = `Σωστό! +${fmt(mine.gained)} πόντοι`; sc += ' good'; }
      else if (mine.choice == null) { text = 'Τέλος χρόνου!'; sc += ' badc'; }
      else { text = 'Λάθος!'; sc += ' badc'; }
    } else if (S.paused) { text = 'Παύση'; sc += ' wait'; }
    else if (S.myChoice != null) { text = opp && !opp.answered ? `Κλείδωσε! Περιμένουμε: ${opp.name}…` : 'Κλείδωσε!'; sc += ' wait'; }
    else if (opp && opp.answered) { text = `${opp.name}: έχει ήδη απαντήσει!`; sc += ' wait'; }
    qEls.status.className = sc;
    qEls.status.textContent = text;
    if (rev && rev.explanation) {
      qEls.expl.hidden = false;
      qEls.expl.replaceChildren(h('b', null, 'Γιατί είναι ψέμα'), rev.explanation);
    } else qEls.expl.hidden = true;
    qEls.timer.style.visibility = rev ? 'hidden' : '';
    void me;
  }

  /* ---------- εφέ ---------- */
  function effects() {
    if (S.phase === 'reveal' && S.reveal) {
      const mine = S.reveal.picks[S.me] || {};
      fx.className = '';
      void fx.offsetWidth;
      fx.className = mine.ok ? 'flash-ok' : 'flash-bad';
      if (mine.ok) {
        const f = h('div', { class: 'float' }, `+${fmt(mine.gained)}`);
        fx.append(f);
        setTimeout(() => f.remove(), 1300);
      } else if (navigator.vibrate) navigator.vibrate(120);
    }
    if (S.phase === 'final') {
      const colors = COLORS.concat('#FFC93C');
      for (let i = 0; i < 60; i++) {
        const c = h('span', { class: 'confetti', style: `left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-duration:${2 + Math.random() * 2.5}s;animation-delay:${Math.random() * .8}s` });
        fx.append(c);
        setTimeout(() => c.remove(), 6000);
      }
    }
  }

  /* ---------- χρονόμετρο ---------- */
  function tick() {
    if (S) {
      const left = S.paused ? S.remaining : Math.max(0, deadline - performance.now());
      if (S.phase === 'question' && qEls) {
        const frac = S.duration ? Math.min(1, left / S.duration) : 0;
        qEls.bar.style.transform = `scaleX(${frac})`;
        const secs = String(Math.ceil(left / 1000));
        if (qEls.secs.textContent !== secs) qEls.secs.textContent = secs;
        qEls.timer.classList.toggle('low', left < 5000);
      } else {
        const el = screen.querySelector('[data-count]');
        if (el) {
          const t = S.paused ? 'Παύση' : `${el.dataset.count} ${Math.max(1, Math.ceil(left / 1000))}…`;
          if (el.textContent !== t) el.textContent = t;
        }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  /* ---------- εκκίνηση ---------- */
  const linkCode = normCode(new URLSearchParams(location.search).get('room'));
  const saved = linkCode && store.get('gm:s:' + linkCode);
  if (saved && saved.token) {
    // επιστροφή σε παιχνίδι που ήταν ήδη σε εξέλιξη (π.χ. μετά από ανανέωση της σελίδας)
    post('/api/join', { code: linkCode, token: saved.token, resumeOnly: true })
      .then(r => startSession(r.code, r.token))
      .catch(() => { store.del('gm:s:' + linkCode); renderHome(linkCode); });
  } else {
    renderHome(linkCode);
  }
})();
