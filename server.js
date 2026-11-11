'use strict';
/*
 * Γνωσιομαχία — παιχνίδι γνώσεων για δύο παίκτες σε πραγματικό χρόνο.
 * Χωρίς εξωτερικές βιβλιοθήκες: μόνο ο ενσωματωμένος http server του Node.
 * Ο server στέλνει την κατάσταση με Server-Sent Events (GET /api/events)
 * και δέχεται κινήσεις με απλά POST (/api/create, /api/join, /api/action).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const FAST = process.env.TEST_FAST === '1'; // μόνο για τα αυτόματα τεστ
const PUBLIC_DIR = __dirname;
const DATA_DIR = __dirname;
// μόνο αυτά τα αρχεία σερβίρονται στους παίκτες (όλα τα αρχεία βρίσκονται στον ίδιο φάκελο)
const PUBLIC_FILES = new Set(['/index.html', '/style.css', '/app.js']);

/* ---------- Ρυθμίσεις παιχνιδιού ---------- */
const ROUNDS = [
  { key: 'quiz', name: 'Κουίζ γενικών γνώσεων', desc: 'Απάντησε σωστά και γρήγορα: όσο πιο γρήγορα, τόσο περισσότεροι πόντοι.', count: 5, hard: 2, seconds: 15 },
  { key: 'flags', name: 'Σημαίες και πρωτεύουσες', desc: 'Βρες τη χώρα από τη σημαία ή από την πρωτεύουσά της.', count: 5, hard: 2, seconds: 15 },
  { key: 'lie', name: 'Βρες το ψέμα', desc: 'Τρεις ισχυρισμοί: δύο αληθινοί, ένας ψεύτικος. Πιάσε τον ψεύτικο.', count: 4, hard: 2, seconds: 25 },
];
const T = FAST
  ? { intro: 80, reveal: 80, revealLie: 80, roundEnd: 80 }
  : { intro: 4500, reveal: 4500, revealLie: 9000, roundEnd: 8000 };
const BASE_POINTS = 500;   // πόντοι για σωστή απάντηση
const SPEED_POINTS = 500;  // επιπλέον πόντοι, ανάλογα με τον χρόνο που περίσσεψε
const CODE_LETTERS = 'ABEHIKMNOPTXYZ'; // γράμματα ίδια σε ελληνικό και λατινικό πληκτρολόγιο
const AVATAR_COUNT = 8;
const COLOR_COUNT = 6;
// Σημαίες που μοιάζουν πολύ μεταξύ τους δεν εμφανίζονται ποτέ μαζί ως επιλογές.
const LOOKALIKES = [['td', 'ro', 'ad', 'md'], ['id', 'mc', 'pl'], ['nl', 'lu'], ['ie', 'ci'], ['au', 'nz'], ['ml', 'gn', 'sn']];

/* ---------- Φόρτωση και έλεγχος δεδομένων ---------- */
function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch (e) {
    console.error(`Σφάλμα στο αρχείο data/${file}: ${e.message}`);
    process.exit(1);
  }
}
function isLevel(l) { return l === 'easy' || l === 'hard'; }
const QUIZ = loadJson('quiz.json').filter((q, i) => {
  const ok = q && q.question && q.correct && Array.isArray(q.wrong) && q.wrong.length === 3 && isLevel(q.level);
  if (!ok) console.warn(`quiz.json: αγνοήθηκε η εγγραφή #${i + 1}`);
  return ok;
});
const LIES = loadJson('lies.json').filter((l, i) => {
  const ok = l && Array.isArray(l.true) && l.true.length === 2 && l.false && isLevel(l.level);
  if (!ok) console.warn(`lies.json: αγνοήθηκε η εγγραφή #${i + 1}`);
  return ok;
});
const COUNTRIES = loadJson('countries.json').filter((c, i) => {
  const ok = c && c.code && c.country && isLevel(c.level);
  if (!ok) console.warn(`countries.json: αγνοήθηκε η εγγραφή #${i + 1}`);
  return ok;
});
QUIZ.forEach((q, i) => { if (!q.id) q.id = 'q' + i; });
LIES.forEach((l, i) => { if (!l.id) l.id = 'l' + i; });
console.log(`Δεδομένα: ${QUIZ.length} ερωτήσεις κουίζ, ${COUNTRIES.length} χώρες, ${LIES.length} σετ «Βρες το ψέμα».`);

/* ---------- Βοηθητικά ---------- */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function levelPlan(count, hard) {
  return shuffle(Array.from({ length: count }, (_, i) => (i < hard ? 'hard' : 'easy')));
}
function lookalike(a, b) {
  return LOOKALIKES.some(g => g.includes(a) && g.includes(b));
}

/* Διαλέγει στοιχείο που δεν έχει ξαναπαιχτεί στο δωμάτιο. Αν εξαντληθεί η τράπεζα, ξαναρχίζει. */
function pickUnused(pool, used, keyOf, prefer) {
  let fresh = pool.filter(x => !used.has(keyOf(x)));
  if (!fresh.length) {
    pool.forEach(x => used.delete(keyOf(x)));
    fresh = pool.slice();
  }
  let cands = prefer ? fresh.filter(prefer) : fresh;
  if (!cands.length) cands = fresh;
  const item = cands[crypto.randomInt(cands.length)];
  used.add(keyOf(item));
  return item;
}

function buildQuizRound(room, cfg) {
  const cats = new Set();
  return levelPlan(cfg.count, cfg.hard).map(level => {
    // προτίμηση σε κατηγορία που δεν έχει βγει ακόμη σε αυτόν τον γύρο
    const q = pickUnused(QUIZ.filter(x => x.level === level), room.used, x => 'q:' + x.id, x => !cats.has(x.category));
    cats.add(q.category);
    const options = shuffle([q.correct, ...q.wrong]);
    return { type: 'quiz', category: q.category, level, text: q.question, options, correct: options.indexOf(q.correct), seconds: cfg.seconds };
  });
}

function buildFlagsRound(room, cfg) {
  const inMatch = new Set();
  return levelPlan(cfg.count, cfg.hard).map((level, i) => {
    const type = i % 2 === 0 ? 'flag' : 'capital'; // εναλλάξ σημαία / πρωτεύουσα
    const pool = COUNTRIES.filter(c => c.level === level && (type === 'flag' || (c.capitalQuestion && c.capital)));
    const c = pickUnused(pool, room.used, x => type + ':' + x.code, x => !inMatch.has(x.code));
    inMatch.add(c.code);
    // παραπλανητικές επιλογές: στις δύσκολες από την ίδια ήπειρο, στις εύκολες από γνωστές χώρες
    let others = COUNTRIES.filter(o => o.code !== c.code && !(type === 'flag' && lookalike(o.code, c.code)) &&
      (level === 'hard' ? o.region === c.region : o.level === 'easy'));
    others = shuffle(others).slice(0, 3);
    const options = shuffle([c, ...others]).map(o => o.country);
    return {
      type, level,
      category: type === 'flag' ? 'Σημαία' : 'Πρωτεύουσα',
      text: type === 'flag' ? 'Ποιας χώρας είναι αυτή η σημαία;' : `Ποιας χώρας πρωτεύουσα είναι: ${c.capital};`,
      flag: type === 'flag' ? c.code : null,
      options, correct: options.indexOf(c.country), seconds: cfg.seconds,
    };
  });
}

function buildLieRound(room, cfg) {
  const inMatch = new Set();
  return levelPlan(cfg.count, cfg.hard).map(level => {
    const l = pickUnused(LIES.filter(x => x.level === level), room.used, x => 'l:' + x.id, x => !inMatch.has(x.id));
    inMatch.add(l.id);
    const options = shuffle([l.false, ...l.true]);
    return { type: 'lie', category: 'Βρες το ψέμα', level, text: 'Ποιος από τους τρεις ισχυρισμούς είναι ψευδής;', options, correct: options.indexOf(l.false), explanation: l.explanation || '', seconds: cfg.seconds };
  });
}
const BUILDERS = { quiz: buildQuizRound, flags: buildFlagsRound, lie: buildLieRound };

/* ---------- Δωμάτια ---------- */
const rooms = new Map();

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
}
function emptyStats() {
  const s = {};
  ROUNDS.forEach(r => { s[r.key] = { points: 0, correct: 0, total: 0, answered: 0, timeMs: 0 }; });
  return s;
}
function clampInt(v, max) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 && n < max ? n : 0;
}
function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'Παίκτης';
}
function newPlayer(body) {
  return {
    id: crypto.randomBytes(4).toString('hex'),
    token: crypto.randomBytes(16).toString('hex'),
    name: cleanName(body.name),
    avatar: clampInt(body.avatar, AVATAR_COUNT),
    color: clampInt(body.color, COLOR_COUNT),
    score: 0, rounds: ROUNDS.map(() => 0), stats: emptyStats(),
    connected: false, streams: new Set(), rematch: false, dropTimer: null,
  };
}
function createRoom(body) {
  const room = {
    code: newCode(), players: [], hostId: null, phase: 'lobby',
    round: 0, qIndex: 0, questions: [], current: null, answers: {},
    timer: null, timerFn: null, timerEnds: 0, phaseDuration: 0,
    paused: false, pausedRemaining: 0, used: new Set(), lastActive: Date.now(),
  };
  const p = newPlayer(body);
  room.players.push(p);
  room.hostId = p.id;
  rooms.set(room.code, room);
  return { room, player: p };
}

/* ---------- Χρονόμετρα φάσεων ---------- */
function schedule(room, ms, fn) {
  clearTimeout(room.timer);
  room.timerFn = fn;
  room.timerEnds = Date.now() + ms;
  room.timer = setTimeout(() => { room.timer = null; fn(); }, ms);
}
function startPhase(room, phase, ms, fn) {
  room.phase = phase;
  room.phaseDuration = ms;
  schedule(room, ms, fn);
  broadcast(room);
}
function pause(room) {
  if (room.paused || !room.timer) return;
  room.pausedRemaining = Math.max(0, room.timerEnds - Date.now());
  clearTimeout(room.timer);
  room.timer = null;
  room.paused = true;
}
function resume(room) {
  if (!room.paused) return;
  room.paused = false;
  schedule(room, room.pausedRemaining, room.timerFn);
}
const ACTIVE = new Set(['intro', 'question', 'reveal', 'roundEnd']);

/* ---------- Ροή παιχνιδιού ---------- */
function startMatch(room) {
  room.players.forEach(p => { p.score = 0; p.rounds = ROUNDS.map(() => 0); p.stats = emptyStats(); p.rematch = false; });
  room.questions = ROUNDS.map(cfg => BUILDERS[cfg.key](room, cfg));
  room.round = 0;
  enterIntro(room);
}
function enterIntro(room) {
  room.qIndex = 0;
  room.current = null;
  room.answers = {};
  startPhase(room, 'intro', T.intro, () => enterQuestion(room));
}
function enterQuestion(room) {
  room.current = room.questions[room.round][room.qIndex];
  room.answers = {};
  const ms = FAST ? 1500 : room.current.seconds * 1000;
  startPhase(room, 'question', ms, () => enterReveal(room));
}
function submitAnswer(room, player, choice) {
  if (room.phase !== 'question' || room.paused || room.answers[player.id]) return;
  const q = room.current;
  const c = Number.parseInt(choice, 10);
  if (!Number.isInteger(c) || c < 0 || c >= q.options.length) return;
  const remaining = Math.max(0, room.timerEnds - Date.now());
  room.answers[player.id] = { choice: c, remaining };
  if (room.players.every(p => room.answers[p.id])) {
    clearTimeout(room.timer);
    room.timer = null;
    enterReveal(room);
  } else {
    broadcast(room);
  }
}
function enterReveal(room) {
  const q = room.current;
  const key = ROUNDS[room.round].key;
  const total = room.phaseDuration;
  room.players.forEach(p => {
    const a = room.answers[p.id];
    const st = p.stats[key];
    st.total++;
    let gained = 0;
    const ok = !!a && a.choice === q.correct;
    if (a) { st.answered++; st.timeMs += total - a.remaining; }
    if (ok) {
      gained = BASE_POINTS + Math.round(SPEED_POINTS * (a.remaining / total));
      st.correct++;
      st.points += gained;
      p.score += gained;
      p.rounds[room.round] += gained;
    }
    room.answers[p.id] = { choice: a ? a.choice : null, gained, ok };
  });
  startPhase(room, 'reveal', q.type === 'lie' ? T.revealLie : T.reveal, () => {
    room.qIndex++;
    if (room.qIndex < ROUNDS[room.round].count) enterQuestion(room);
    else startPhase(room, 'roundEnd', T.roundEnd, () => {
      room.round++;
      if (room.round < ROUNDS.length) enterIntro(room);
      else enterFinal(room);
    });
  });
}
function enterFinal(room) {
  clearTimeout(room.timer);
  room.timer = null;
  room.round = ROUNDS.length - 1;
  room.phase = 'final';
  room.current = null;
  room.players.forEach(p => { p.rematch = false; });
  broadcast(room);
}

/* ---------- Τι βλέπει κάθε παίκτης ---------- */
function view(room, me) {
  const cfg = ROUNDS[room.round] || ROUNDS[0];
  const remaining = room.paused ? room.pausedRemaining : (room.timer ? Math.max(0, room.timerEnds - Date.now()) : 0);
  const s = {
    code: room.code, phase: room.phase, me: me.id, hostId: room.hostId, paused: room.paused,
    round: room.round, roundCount: ROUNDS.length, roundKey: cfg.key, roundName: cfg.name, roundDesc: cfg.desc,
    roundNames: ROUNDS.map(r => ({ key: r.key, name: r.name })),
    qIndex: room.qIndex, qCount: cfg.count, remaining, duration: room.phaseDuration,
    players: room.players.map(p => ({
      id: p.id, name: p.name, avatar: p.avatar, color: p.color, score: p.score, rounds: p.rounds,
      connected: p.connected, rematch: p.rematch, stats: p.stats,
      answered: room.phase === 'question' && !!room.answers[p.id],
    })),
  };
  const q = room.current;
  if (q && (room.phase === 'question' || room.phase === 'reveal')) {
    s.q = { type: q.type, category: q.category, level: q.level, text: q.text, flag: q.flag || null, options: q.options };
    const mine = room.answers[me.id];
    s.myChoice = mine ? mine.choice : null;
    if (room.phase === 'reveal') {
      s.reveal = { correct: q.correct, explanation: q.explanation || null, picks: room.answers };
    }
  }
  return s;
}
function sendState(room, p) {
  const data = `event: state\ndata: ${JSON.stringify(view(room, p))}\n\n`;
  p.streams.forEach(res => res.write(data));
}
function broadcast(room) {
  room.lastActive = Date.now();
  room.players.forEach(p => sendState(room, p));
}

/* ---------- Σύνδεση / αποσύνδεση ---------- */
function onConnect(room, p, res) {
  clearTimeout(p.dropTimer);
  p.streams.add(res);
  p.connected = true;
  if (room.paused && room.players.every(x => x.connected)) resume(room);
  broadcast(room);
}
function onDisconnect(room, p, res) {
  p.streams.delete(res);
  if (p.streams.size) return;
  clearTimeout(p.dropTimer);
  // μικρή ανοχή, ώστε μια απλή ανανέωση της σελίδας να μη «παγώνει» το παιχνίδι
  p.dropTimer = setTimeout(() => {
    if (p.streams.size) return;
    p.connected = false;
    if (ACTIVE.has(room.phase)) pause(room);
    broadcast(room);
  }, FAST ? 50 : 2000);
}

/* ---------- HTTP ---------- */
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 10000) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const GREEK_TO_LATIN = { 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Χ': 'X', 'Υ': 'Y', 'Ζ': 'Z' };
function normCode(code) {
  return String(code || '').toUpperCase().replace(/./g, ch => GREEK_TO_LATIN[ch] || ch).replace(/[^A-Z]/g, '').slice(0, 4);
}
function findSeat(body) {
  const room = rooms.get(normCode(body.code));
  if (!room) return {};
  return { room, player: room.players.find(p => p.token === body.token) };
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const { room, player } = findSeat({ code: url.searchParams.get('code'), token: url.searchParams.get('token') });
    if (!room || !player) return json(res, 404, { error: 'Το δωμάτιο δεν υπάρχει πια.' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    req.on('close', () => onDisconnect(room, player, res));
    onConnect(room, player, res);
    return;
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Μη αποδεκτή μέθοδος.' });
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Λάθος αίτημα.' }); }

  if (url.pathname === '/api/create') {
    const { room, player } = createRoom(body);
    return json(res, 200, { code: room.code, token: player.token, id: player.id });
  }

  if (url.pathname === '/api/join') {
    const room = rooms.get(normCode(body.code));
    if (!room) return json(res, 404, { error: 'Δεν βρέθηκε δωμάτιο με αυτόν τον κωδικό.' });
    let p = room.players.find(x => x.token && x.token === body.token);
    if (!p && body.resumeOnly) return json(res, 404, { error: 'Η θέση σου δεν βρέθηκε.' });
    if (!p && room.players.length < 2) {
      p = newPlayer(body);
      if (room.players.some(x => x.name.toLowerCase() === p.name.toLowerCase())) p.name = (p.name.slice(0, 12) + ' 2');
      room.players.push(p);
    }
    if (!p) {
      // επανασύνδεση από άλλη συσκευή: ίδιο όνομα, και ο αρχικός παίκτης είναι εκτός σύνδεσης
      const name = cleanName(body.name).toLowerCase();
      p = room.players.find(x => !x.connected && x.name.toLowerCase() === name);
      if (p) p.token = crypto.randomBytes(16).toString('hex');
    }
    if (!p) return json(res, 409, { error: 'Το δωμάτιο είναι γεμάτο. Αν είσαι παίκτης που αποσυνδέθηκε, μπες με το ίδιο όνομα.' });
    broadcast(room);
    return json(res, 200, { code: room.code, token: p.token, id: p.id });
  }

  if (url.pathname === '/api/action') {
    const { room, player } = findSeat(body);
    if (!room || !player) return json(res, 404, { error: 'Το δωμάτιο δεν υπάρχει πια.' });
    room.lastActive = Date.now();
    if (body.type === 'start') {
      if (room.phase !== 'lobby') return json(res, 200, { ok: true });
      if (player.id !== room.hostId) return json(res, 403, { error: 'Το παιχνίδι το ξεκινά όποιος έφτιαξε το δωμάτιο.' });
      if (room.players.length < 2 || !room.players.every(p => p.connected)) return json(res, 409, { error: 'Χρειάζονται δύο συνδεδεμένοι παίκτες.' });
      startMatch(room);
    } else if (body.type === 'answer') {
      submitAnswer(room, player, body.choice);
    } else if (body.type === 'rematch') {
      if (room.phase === 'final') {
        player.rematch = true;
        if (room.players.length === 2 && room.players.every(p => p.rematch && p.connected)) startMatch(room);
        else broadcast(room);
      }
    }
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Άγνωστη διαδρομή.' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (!PUBLIC_FILES.has(rel)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Δεν βρέθηκε.'); }
  const file = path.join(PUBLIC_DIR, rel);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Δεν βρέθηκε.'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: 'Σφάλμα διακομιστή.' }); });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url);
});

// «σφυγμός» για να μένουν ανοιχτές οι συνδέσεις πίσω από proxies
setInterval(() => {
  rooms.forEach(room => room.players.forEach(p => p.streams.forEach(res => res.write(': ping\n\n'))));
}, 20000).unref();

// καθάρισμα δωματίων που έμειναν άδεια
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    const anyone = room.players.some(p => p.connected);
    const idle = now - room.lastActive;
    if ((!anyone && idle > 30 * 60 * 1000) || idle > 6 * 60 * 60 * 1000) {
      clearTimeout(room.timer);
      room.players.forEach(p => p.streams.forEach(res => res.end()));
      rooms.delete(code);
    }
  });
}, 60000).unref();

server.listen(PORT, () => console.log(`Γνωσιομαχία: http://localhost:${PORT}`));
