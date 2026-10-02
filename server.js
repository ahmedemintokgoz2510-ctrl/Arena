/*
server.js = SUNUCU (bilgisayarda calisir: node server.js)
- Dosyalari sunar (ayni klasordeki html/js/css), QR adresini uretir (/api/join-info).
- Hem yerel agda (bilgisayar) hem internette (Render gibi ucretsiz hosting) calisir.
- TUM oyun durumunu burada tutar: oyuncu id, isim, renk, x, y, baglanti durumu.
- Telefondan sadece joystick girdisi (-1..1) alir; konumu SUNUCU hesaplar ve dogrular.
- Oyun ekranina (game.html) konumlari Socket.IO ile yayinlar.
- ASAMA 5: soru, sure, can, puan, elenme, kazanan = hepsi SUNUCUDA hesaplanir (istemciye guvenilmez).
- ASAMA 7: telefonlara mini harita icin konumlar dusuk sikliktaki 'map:update' ile gonderilir (sadece gosterim).
- ASAMA 6: secilen ders (selectedSubject) sunucuda tutulur; oyuncunun bulundugu bolge (zone) sunucudan yayinlanir.
*/
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode'); // yerel QR uretimi (internet gerekmez)
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Yerel agdaki tum cihazlar baglanabilsin

const app = express();
const server = http.createServer(app);
// Kopan telefonlari hizli fark etmek icin ping ayarlari (yaklasik 10 sn icinde temizlenir)
const io = new Server(server, { pingInterval: 5000, pingTimeout: 5000 });

// Sadece oyun dosyalari disari acilir (server.js / package.json gizli kalir)
['index.html', 'game.html', 'controller.html', 'style.css', 'game.js', 'controller.js'].forEach((f) => {
  app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, f)));
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// MERKEZI OYUN DURUMU (tek dogru kaynak: sunucu)
// socket.id -> { id, name }
// Ileride: x, y, lives, score, alive vb. buraya eklenecek.
const players = new Map();

// ---- ASAMA 2: dunya, renk, dogma noktasi, hareket ----
const WORLD_W = 1600;          // mantiksal dunya (istemciler ekrana olcekler)
const WORLD_H = 900;
const SPEED = 450;             // birim/saniye (hiz SADECE sunucuda belirlenir)
const INPUT_TIMEOUT = 500;     // ms: girdi gelmezse oyuncu durur
const MIN_INPUT_GAP = 20;      // ms: en fazla ~50 girdi/sn kabul edilir
const COLORS = ['#ef4444','#3b82f6','#22c55e','#f59e0b','#a855f7','#ec4899','#14b8a6','#f97316',
  '#84cc16','#06b6d4','#eab308','#8b5cf6','#f43f5e','#0ea5e9','#10b981','#d946ef',
  '#fb7185','#60a5fa','#a3e635','#fbbf24','#c084fc','#2dd4bf','#fb923c','#94a3b8'];
const MAX_PLAYERS = 20;
const COLS = 6, ROWS = 4;      // 24 dogma noktasi (>= 20 oyuncu)

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function freeColor() {
  const used = new Set(Array.from(players.values()).map((p) => p.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[players.size % COLORS.length];
}

function freeSlot() {
  const used = new Set(Array.from(players.values()).map((p) => p.slot));
  for (let i = 0; i < COLS * ROWS; i++) if (!used.has(i)) return i;
  return Math.floor(Math.random() * COLS * ROWS); // 24'ten fazlaysa rastgele
}

function slotPos(slot) {
  return {
    x: ((slot % COLS) + 0.5) / COLS * WORLD_W,
    y: (Math.floor(slot / COLS) % ROWS + 0.5) / ROWS * WORLD_H,
  };
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, connected: p.connected, lives: p.lives, score: p.score, alive: p.alive, waiting: p.waiting, x: Math.round(p.x), y: Math.round(p.y), zone: zoneOf(p.x, p.y) || '' };
}

function getPlayerList() {
  return Array.from(players.values()).map(publicPlayer);
}

// Oyun dongusu: 60 Hz fizik, 30 Hz yayin (sadece hareket varsa)
let lastTick = Date.now();
let tickCount = 0;
let dirty = false;
let mapDirty = false; // telefon mini haritasi icin
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;
  tickCount++;
  players.forEach((p, sid) => {
    if (now - p.lastInputAt > INPUT_TIMEOUT) { p.ix = 0; p.iy = 0; }
    if (!canMove(p)) { p.ix = 0; p.iy = 0; } else if (p.ix || p.iy) {
      p.x = clamp(p.x + p.ix * SPEED * dt, 0, WORLD_W);
      p.y = clamp(p.y + p.iy * SPEED * dt, 0, WORLD_H);
      dirty = true; mapDirty = true;
      const z = zoneOf(p.x, p.y) || ''; // ASAMA 6: bolge degisince telefona haber ver (sadece gosterim)
      if (z !== p.zone) { p.zone = z; io.to(sid).emit('me:zone', z); }
    }
  });
  if (mapDirty && tickCount % 6 === 0) { // ~10 Hz, sadece telefonlara: [id, x, y, renk, hayatta]
    mapDirty = false;
    io.to('players').emit('map:update',
      Array.from(players.values()).map((p) => [p.id, Math.round(p.x), Math.round(p.y), p.color, p.alive && !p.waiting ? 1 : 0]));
  }
  if (dirty && tickCount % 2 === 0) {
    dirty = false;
    io.to('board').emit('state:update',
      Array.from(players.values()).map((p) => [p.id, Math.round(p.x), Math.round(p.y), zoneOf(p.x, p.y) || '']));
  }
}, 1000 / 60);

function broadcastPlayers() {
  mapDirty = true;
  io.to('board').emit('players:update', getPlayerList());
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 16);
}

// ---------------------------------------------------------------
// QR ILE KOLAY BAGLANTI
// Bilgisayarin yerel IP'sini her istekte yeniden bulur; Wi-Fi/IP
// degisirse QR kod otomatik olarak yeni adrese gore uretilir.
// Istege bagli: HOST_IP=192.168.1.25 ile IP elle sabitlenebilir.
// ---------------------------------------------------------------
const VIRTUAL_NAME = /virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|loopback|tailscale|zerotier|vpn|bluetooth/i;

function getLanIp() {
  if (process.env.HOST_IP) return process.env.HOST_IP;
  const candidates = [];
  Object.entries(os.networkInterfaces()).forEach(([name, list]) => {
    (list || []).forEach((n) => {
      const isV4 = n.family === 'IPv4' || n.family === 4;
      if (!isV4 || n.internal || n.address.startsWith('169.254.')) return;
      let score = 0;
      if (n.address.startsWith('192.168.')) score += 3;
      else if (n.address.startsWith('10.')) score += 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(n.address)) score += 1;
      if (VIRTUAL_NAME.test(name)) score -= 10;
      candidates.push({ address: n.address, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].address : null;
}

const qrCache = { url: '', svg: '' };

app.get('/api/join-info', async (req, res) => {
  try {
    // Tahta hangi adresle acildiysa QR da onu kullanir (internet linki veya yerel IP).
    // Tahta localhost ile acildiysa bilgisayarin yerel IP'si kullanilir.
    const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
    let base;
    if (hostHeader && !/^(localhost|127\.|\[?::1)/.test(hostHeader)) {
      base = `${proto}://${hostHeader}`;
    } else {
      const ip = getLanIp();
      if (!ip) return res.json({ ok: false, error: 'Yerel ağ IP adresi bulunamadı. Wi-Fi bağlantını kontrol et.' });
      base = `http://${ip}:${PORT}`;
    }
    const url = `${base}/controller.html`;
    if (qrCache.url !== url) {
      qrCache.svg = await QRCode.toString(url, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 4, // QR etrafindaki bos alan (okunabilirlik icin gerekli)
        color: { dark: '#000000', light: '#ffffff' },
      });
      qrCache.url = url;
    }
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, url, svg: qrCache.svg });
  } catch (err) {
    console.error('QR olusturulamadi:', err);
    res.status(500).json({ ok: false, error: 'QR kod oluşturulamadı.' });
  }
});

// ---------------------------------------------------------------
// ASAMA 5: OYUN AKISI (tum kurallar sunucuda)
// lobby -> [countdown 5..1 BASLA! (5+ oyuncu varsa)] -> question (30 sn) -> result (2 sn) -> question ... -> winner -> lobby
// Dogru cevap SADECE sunucuda durur; telefonlara hic gonderilmez.
// ---------------------------------------------------------------
const START_LIVES = 3, ANSWER_SECONDS = 30, RESULT_SECONDS = 2, POINTS = 100;
const COUNTDOWN_MIN_PLAYERS = 5; // bu kadar veya daha fazla oyuncu varsa oyun basinda 5-4-3-2-1-BASLA! geri sayimi
const COUNTDOWN_MS = 6000;       // 5,4,3,2,1 + BASLA! (her biri ~1 sn)
const ZONE_Y = 300; // game.js ile ayni: bu cizginin altindaki 4 sutun = A, B, C, D bolgesi

// ASAMA 6: DERS LISTESI (kolay degistirilebilir). Gercek soru bankalari sonraki asamada eklenecek.
const SUBJECTS = [
  { id: 'matematik', name: 'MATEMATİK', icon: '📐' },
  { id: 'edebiyat', name: 'TÜRK DİLİ VE EDEBİYATI', icon: '📖' },
  { id: 'fizik', name: 'FİZİK', icon: '⚡' },
  { id: 'kimya', name: 'KİMYA', icon: '🧪' },
  { id: 'biyoloji', name: 'BİYOLOJİ', icon: '🧬' },
  { id: 'tarih', name: 'TARİH', icon: '🏛️' },
  { id: 'cografya', name: 'COĞRAFYA', icon: '🌍' },
  { id: 'din', name: 'DİN KÜLTÜRÜ', icon: '🕌' },
  { id: 'ingilizce', name: 'İNGİLİZCE', icon: '🔤' },
  { id: 'karma', name: 'KARMA', icon: '🎲' },
];

// SADECE TEST SORULARI (her ders icin gercek sorular sonraki asamada eklenecek; simdilik tum dersler bunu kullanir)
const QUESTIONS = [
  { question: "Türkiye'nin başkenti neresidir?", options: { A: 'İstanbul', B: 'Ankara', C: 'İzmir', D: 'Bursa' }, correctAnswer: 'B' },
  { question: 'Bir yılda kaç ay vardır?', options: { A: '10', B: '11', C: '12', D: '13' }, correctAnswer: 'C' },
  { question: 'Hangisi bir meyvedir?', options: { A: 'Elma', B: 'Masa', C: 'Kalem', D: 'Defter' }, correctAnswer: 'A' },
  { question: '3 + 4 kaçtır?', options: { A: '6', B: '8', C: '7', D: '9' }, correctAnswer: 'C' },
  { question: 'Güneş hangi yönden doğar?', options: { A: 'Batı', B: 'Kuzey', C: 'Güney', D: 'Doğu' }, correctAnswer: 'D' },
];

// ---- ASAMA 8: SORU BANKALARI ----
// Her ders q-<dersid>.js dosyasindan yuklenir (ornek: q-matematik.js, q-karma.js). Bu dosyalar istemciye SUNULMAZ
// (dogru cevaplar sadece sunucuda kalir). Gecersiz / tekrar eden ID'li sorular atlanir ve logda uyari verilir.
// Dosyasi yoksa ya da bos ise o ders icin 5'lik TEST havuzu kullanilir.
const DIFFS = ['easy', 'medium', 'hard'];
const DIFF_WEIGHT = { easy: 0.3, medium: 0.5, hard: 0.2 }; // hedef dagilim %30 / %50 / %20
const QUESTION_BANKS = {};
function loadBanks() {
  const seenIds = new Set();
  SUBJECTS.forEach((sub) => {
    let raw = [];
    try { raw = require('./q-' + sub.id + '.js'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') console.warn('[soru] ' + sub.id + ' yuklenemedi:', e.message); }
    const list = [];
    (Array.isArray(raw) ? raw : []).forEach((q, i) => {
      const ok = q && typeof q.id === 'string' && q.id && !seenIds.has(q.id) && DIFFS.includes(q.difficulty) &&
        typeof q.question === 'string' && q.question && q.answers && ['A', 'B', 'C', 'D'].every((k) => typeof q.answers[k] === 'string' && q.answers[k]) &&
        ['A', 'B', 'C', 'D'].includes(q.correct);
      if (!ok) { console.warn('[soru] ' + sub.id + ' #' + (i + 1) + ' gecersiz ya da tekrar eden ID, atlandi'); return; }
      seenIds.add(q.id);
      list.push({ id: q.id, difficulty: q.difficulty, question: q.question, options: q.answers, correctAnswer: q.correct });
    });
    QUESTION_BANKS[sub.id] = list;
    const c = (d) => list.filter((q) => q.difficulty === d).length;
    console.log('[soru] ' + sub.id + ': ' + list.length + ' (kolay ' + c('easy') + ', orta ' + c('medium') + ', zor ' + c('hard') + ')' + (list.length ? '' : ' -> test havuzu kullanilacak'));
  });
}
loadBanks();
function poolFor(subjectId) {
  const b = QUESTION_BANKS[subjectId];
  return Array.isArray(b) && b.length ? b : QUESTIONS.map((q, i) => ({ id: 'test_' + (i + 1), difficulty: 'medium', question: q.question, options: q.options, correctAnswer: q.correctAnswer }));
}

// Tekrar onleme: (1) usedQuestionIds = bu oyunda cikan sorular, ASLA tekrar secilmez.
// (2) seenBySubject = onceki oyunlarda cikanlar; sunucu acik oldukca yeni oyunlarda da once hic cikmamis sorular secilir.
// Ders havuzu tamamen tukenirse seenBySubject o ders icin sifirlanir.
const seenBySubject = {};

function pickQuestion() {
  const free = game.pool.filter((q) => !game.usedQuestionIds.has(q.id));
  if (!free.length) return null; // bu oyunda havuz bitti
  const seen = seenBySubject[game.subject] || (seenBySubject[game.subject] = new Set());
  let cand = free.filter((q) => !seen.has(q.id));
  if (!cand.length) { game.pool.forEach((q) => seen.delete(q.id)); cand = free; }
  // zorluk: hedef agirlikli rastgele; ust uste 2 ayni zorluktan sonra ayni zorluga agirlik dusurulur (onceden tahmin edilemez)
  const have = DIFFS.filter((d) => cand.some((q) => q.difficulty === d));
  const w = have.map((d) => {
    let x = DIFF_WEIGHT[d];
    const r = game.recentDiffs;
    if (r.length >= 2 && r[r.length - 1] === d && r[r.length - 2] === d && have.length > 1) x = 0; // ust uste 3. kez ayni zorluk gelmez
    return x;
  });
  let t = Math.random() * w.reduce((a, b) => a + b, 0), diff = have[have.length - 1];
  for (let i = 0; i < have.length; i++) { t -= w[i]; if (t <= 0) { diff = have[i]; break; } }
  const same = cand.filter((q) => q.difficulty === diff);
  const q = same[Math.floor(Math.random() * same.length)];
  game.usedQuestionIds.add(q.id); seen.add(q.id);
  game.recentDiffs.push(q.difficulty); if (game.recentDiffs.length > 4) game.recentDiffs.shift();
  return q;
}

const game = { subject: null, pool: [], usedQuestionIds: new Set(), recentDiffs: [], phase: 'lobby', order: [], round: 0, current: null, endsAt: 0, startCount: 0, timer: null, result: null, winner: null };

function later(ms, fn) { clearTimeout(game.timer); game.timer = setTimeout(fn, ms); }
function zoneOf(x, y) { return y < ZONE_Y ? null : 'ABCD'[Math.min(3, Math.floor(x / (WORLD_W / 4)))]; }
function canMove(p) { return p.alive && !p.waiting && (game.phase === 'lobby' || game.phase === 'countdown' || game.phase === 'question'); }

function baseState() { // dogru cevap burada YOK
  const subj = SUBJECTS.find((x) => x.id === game.subject) || null;
  const s = { subject: subj, phase: game.phase, round: game.round, endsIn: Math.max(0, game.endsAt - Date.now()), winner: game.winner };
  if (game.current && (game.phase === 'question' || game.phase === 'result')) {
    s.question = { text: game.current.question, options: game.current.options };
  }
  return s;
}
function pushState() {
  const base = baseState();
  // Dogru cevap + oyuncu sonuclari yalnizca tahtaya; telefonlar kendi sonucunu me:update ile alir
  io.to('board').emit('game:state', Object.assign({}, base, { result: game.phase === 'result' ? game.result : null }));
  io.except('board').emit('game:state', base);
}
function sendMe(sid, p) {
  io.to(sid).emit('me:update', { lives: p.lives, score: p.score, alive: p.alive, waiting: p.waiting, last: p.last, zone: zoneOf(p.x, p.y) || '' });
}
function pushMe() { players.forEach((p, sid) => sendMe(sid, p)); }

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function resetToLobby() {
  clearTimeout(game.timer);
  Object.assign(game, { phase: 'lobby', current: null, result: null, winner: null, round: 0, endsAt: 0 });
  players.forEach((p) => { p.lives = START_LIVES; p.score = 0; p.alive = true; p.waiting = false; p.last = null; });
  pushState(); broadcastPlayers(); pushMe();
}

function startGame() {
  game.pool = poolFor(game.subject);
  game.usedQuestionIds = new Set(); game.recentDiffs = []; // yeni oyun: kullanilan soru listesi sifirlanir
  game.round = 0; game.winner = null;
  players.forEach((p) => { p.lives = START_LIVES; p.score = 0; p.alive = true; p.waiting = false; p.last = null; });
  game.startCount = players.size;
  if (players.size >= COUNTDOWN_MIN_PLAYERS) { // geri sayim: tahtada 5-4-3-2-1-BASLA!, sonra ilk soru
    game.phase = 'countdown'; game.current = null; game.result = null;
    game.endsAt = Date.now() + COUNTDOWN_MS;
    pushState(); pushMe();
    later(COUNTDOWN_MS, nextQuestion);
  } else nextQuestion();
  broadcastPlayers();
}

function nextQuestion() {
  const q = pickQuestion();
  if (!q) { // havuz bitti: soru tekrar ETMEZ, oyun biter
    const all = Array.from(players.values()).filter((p) => !p.waiting);
    return endGame(all, all.filter((p) => p.alive), true);
  }
  game.current = q;
  game.round++;
  game.phase = 'question';
  game.result = null;
  game.endsAt = Date.now() + ANSWER_SECONDS * 1000;
  players.forEach((p) => { p.last = null; });
  pushState(); pushMe();
  later(ANSWER_SECONDS * 1000, endQuestion);
}

function endQuestion() {
  const per = {};
  players.forEach((p) => {
    if (!p.alive || p.waiting) return;
    p.ix = 0; p.iy = 0;
    const zn = zoneOf(p.x, p.y);
    if (zn === game.current.correctAnswer) {
      p.score += POINTS; p.last = 'correct'; per[p.id] = 'correct';
    } else { // 'wrong' = yanlis bolge, 'none' = hicbir bolgede degil (CEVAP VERILMEDI); ikisi de 1 can kaybettirir
      const miss = zn ? 'wrong' : 'none';
      p.lives -= 1; p.last = miss; per[p.id] = miss;
      if (p.lives <= 0) p.alive = false; // elendi
    }
  });
  game.phase = 'result';
  game.endsAt = Date.now() + RESULT_SECONDS * 1000;
  game.result = { correct: game.current.correctAnswer, per };
  pushState(); broadcastPlayers(); pushMe();
  later(RESULT_SECONDS * 1000, afterResult);
}

function afterResult() {
  const all = Array.from(players.values()).filter((p) => !p.waiting);
  const active = all.filter((p) => p.alive);
  const over = active.length === 0 || (game.startCount >= 2 && active.length <= 1);
  if (!over) return nextQuestion();
  endGame(all, active, false);
}

function endGame(all, active, exhausted) {
  if (!all.length) return resetToLobby();
  // tek kisi kaldiysa o; herkes elendiyse tum oyuncular arasinda; sorular bittiyse hayatta kalanlar arasinda en yuksek puan
  const pool = active.length === 1 ? active : (exhausted && active.length ? active : all);
  const max = Math.max(...pool.map((p) => p.score));
  const winners = active.length === 1 ? active : pool.filter((p) => p.score === max);
  game.winner = { ids: winners.map((p) => p.id), names: winners.map((p) => p.name), score: max };
  game.phase = 'winner'; game.endsAt = 0; game.current = null; game.result = null;
  pushState(); pushMe();
}

function afterPlayerRemoved() { if (players.size === 0) resetToLobby(); }

io.on('connection', (socket) => {
  socket.on('board:join', () => {
    socket.join('board');
    socket.emit('subjects:list', SUBJECTS);
    socket.emit('players:update', getPlayerList());
    socket.emit('game:state', Object.assign(baseState(), { result: game.phase === 'result' ? game.result : null }));
  });

  socket.on('player:join', (rawData, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};

    // Telefon { name, key } gonderir. key = telefonun kalici kimligi (yeniden baglanmada kullanilir)
    const data = rawData && typeof rawData === 'object' ? rawData : { name: rawData };
    const rawName = data.name;
    const key = typeof data.key === 'string' ? data.key.slice(0, 64) : '';

    if (players.has(socket.id)) {
      return reply({ ok: true, player: publicPlayer(players.get(socket.id)) });
    }
    const name = sanitizeName(rawName);
    if (!name) {
      return reply({ ok: false, error: 'Lütfen bir oyuncu adı gir.' });
    }

    // Ayni telefon (ayni key) yeniden baglandiysa eski baglantinin kalinti kaydini temizle;
    // boylece bozuk/eski state yeni baglantiyi kilitlemez. Kimlik, renk ve konum korunur.
    let old = null;
    if (key) {
      for (const [sid, p] of players) {
        if (p.key === key && sid !== socket.id) { old = p; players.delete(sid); break; }
      }
    }
    if (!old && players.size >= MAX_PLAYERS) return reply({ ok: false, error: 'Oyun dolu (en fazla 20 oyuncu).' });
    const slot = old ? old.slot : freeSlot();
    const pos = old ? { x: old.x, y: old.y } : slotPos(slot);
    const player = {
      id: old ? old.id : crypto.randomBytes(4).toString('hex'),
      name,
      key,
      connected: true,
      lives: START_LIVES, score: 0, alive: true, last: null,
      waiting: game.phase !== 'lobby', // oyun surerken katilan, siradaki oyunu bekler
      color: old ? old.color : freeColor(),
      slot,
      x: pos.x,
      y: pos.y,
      zone: zoneOf(pos.x, pos.y) || '',
      ix: 0, iy: 0,        // joystick girdisi (-1..1)
      lastInputAt: 0,
    };
    if (old) { player.lives = old.lives; player.score = old.score; player.alive = old.alive; player.waiting = old.waiting; player.last = old.last; }
    players.set(socket.id, player);
    socket.join('players'); // mini harita yayini icin

    console.log(`[+] ${player.name} (${player.id}) bağlandı. Toplam: ${players.size}`);
    reply({ ok: true, player: publicPlayer(player) });
    socket.emit('game:state', baseState());
    sendMe(socket.id, player);
    io.to('board').emit('player:joined', { id: player.id, name: player.name, color: player.color });
    broadcastPlayers();
  });

  // Sadece tahta (board) oyunu baslatabilir / yeni oyuna gecebilir
  socket.on('game:start', () => {
    if (!socket.rooms.has('board') || game.phase !== 'lobby' || players.size < 1) return;
    if (!game.subject) return; // ders secilmeden oyun baslamaz
    startGame();
  });
  // ASAMA 6: ders secimi (sadece tahta, sadece lobide; gecerli id sunucuda dogrulanir)
  socket.on('subject:select', (id) => {
    if (!socket.rooms.has('board') || game.phase !== 'lobby') return;
    if (typeof id !== 'string' || !SUBJECTS.some((x) => x.id === id)) return;
    game.subject = id;
    pushState();
  });
  // ASAMA 6: "beni bul" - telefon tahtada kendi karakterini kisa sure vurgulatir (sadece gosterim)
  socket.on('player:find', () => {
    const p = players.get(socket.id);
    const now = Date.now();
    if (!p || now - (p.lastFindAt || 0) < 1500) return;
    p.lastFindAt = now;
    io.to('board').emit('player:find', { id: p.id });
  });
  socket.on('game:reset', () => {
    if (!socket.rooms.has('board') || game.phase !== 'winner') return;
    resetToLobby();
  });

  socket.on('player:input', (d) => {
    const p = players.get(socket.id);
    if (!p || !d) return;
    let x = Number(d.x), y = Number(d.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x = clamp(x, -1, 1); y = clamp(y, -1, 1);
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    const now = Date.now();
    if ((x || y) && now - p.lastInputAt < MIN_INPUT_GAP) return; // hiz siniri
    if (!canMove(p)) { p.ix = 0; p.iy = 0; return; } // elenen / bekleyen / sonuc ekrani: hareket yok
    p.ix = x; p.iy = y; p.lastInputAt = now;
  });

  socket.on('disconnect', () => {
    const player = players.get(socket.id);
    if (!player) return;
    players.delete(socket.id);
    console.log(`[-] ${player.name} (${player.id}) ayrıldı. Toplam: ${players.size}`);
    io.to('board').emit('player:left', { id: player.id, name: player.name });
    broadcastPlayers();
    afterPlayerRemoved();
  });
});

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log(' SINIF ARENASI sunucusu çalışıyor');
  console.log('==============================================');
  const nets = os.networkInterfaces();
  Object.values(nets).forEach((list) => {
    (list || []).forEach((n) => {
      if (n.family === 'IPv4' && !n.internal) {
        console.log(` Akıllı tahta : http://${n.address}:${PORT}/game.html`);
        console.log(` Telefon      : http://${n.address}:${PORT}/controller.html`);
        console.log('----------------------------------------------');
      }
    });
  });
  console.log(' (Telefonlarda localhost ÇALIŞMAZ, yukarıdaki IP adreslerini kullan.)');
});
