/*
server.js = SUNUCU (bilgisayarda calisir: node server.js)
- Dosyalari sunar (ayni klasordeki html/js/css), QR adresini uretir (/api/join-info).
- Hem yerel agda (bilgisayar) hem internette (Render gibi ucretsiz hosting) calisir.
- TUM oyun durumunu burada tutar: oyuncu id, isim, renk, x, y, baglanti durumu.
- Telefondan sadece joystick girdisi (-1..1) alir; konumu SUNUCU hesaplar ve dogrular.
- Oyun ekranina (game.html) konumlari Socket.IO ile yayinlar.
- ASAMA 6: ders secimi (setup -> lobby), cevap bolgesi vurgusu (oyuncunun bolgesi sunucuda hesaplanir).
- ASAMA 5: soru, sure, can, puan, elenme, kazanan = hepsi SUNUCUDA hesaplanir (istemciye guvenilmez).
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
const COLS = 8, ROWS = 3;   // dogma noktalari: baslangic alaninda 8x3 = 24 yer      // 24 dogma noktasi (>= 20 oyuncu)

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
    y: (Math.floor(slot / COLS) % ROWS + 0.5) / ROWS * ZONE_Y, // sadece baslangic alani (cevap bolgelerinin ustu)
  };
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, connected: p.connected, lives: p.lives, score: p.score, alive: p.alive, waiting: p.waiting, x: Math.round(p.x), y: Math.round(p.y) };
}

function getPlayerList() {
  return Array.from(players.values()).map(publicPlayer);
}

// Oyun dongusu: 60 Hz fizik, 30 Hz yayin (sadece hareket varsa)
let lastTick = Date.now();
let tickCount = 0;
let dirty = false;
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;
  tickCount++;
  players.forEach((p, sid) => {
    // Oyuncunun hangi cevap bolgesinde oldugunu SUNUCU hesaplar (tahta vurgusu + telefondaki "SECILI CEVAP")
    const z = zoneOf(p.x, p.y) || '';
    if (z !== p.zone) { p.zone = z; io.to(sid).emit('me:zone', z); dirty = true; }
    if (now - p.lastInputAt > INPUT_TIMEOUT) { p.ix = 0; p.iy = 0; }
    if (!canMove(p)) { p.ix = 0; p.iy = 0; } else if (p.ix || p.iy) {
      p.x = clamp(p.x + p.ix * SPEED * dt, 0, WORLD_W);
      p.y = clamp(p.y + p.iy * SPEED * dt, 0, WORLD_H);
      dirty = true;
    }
  });
  if (dirty && tickCount % 2 === 0) {
    dirty = false;
    io.to('board').emit('state:update',
      Array.from(players.values()).map((p) => [p.id, Math.round(p.x), Math.round(p.y), p.zone || '']));
  }
}, 1000 / 60);

function broadcastPlayers() {
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
// lobby -> question (15 sn) -> result (5 sn) -> question ... -> winner -> lobby
// Dogru cevap SADECE sunucuda durur; telefonlara hic gonderilmez.
// ---------------------------------------------------------------
const START_LIVES = 3, ANSWER_SECONDS = 15, RESULT_SECONDS = 5, POINTS = 100;
const ZONE_Y = 400; // bu cizginin altindaki 4 sutun = A, B, C, D bolgesi (oyun ekranina da gonderilir)

// SADECE TEST SORULARI (500 gercek soru sonraki asamada eklenecek)
// DERS LISTESI: buradan kolayca degistirilebilir (id, ad, simge, renk)
const SUBJECTS = [
  { id: 'turkce', name: 'TÜRKÇE', icon: '📖', color: '#ef4444' },
  { id: 'matematik', name: 'MATEMATİK', icon: '➗', color: '#3b82f6' },
  { id: 'fen', name: 'FEN BİLİMLERİ', icon: '🔬', color: '#22c55e' },
  { id: 'sosyal', name: 'SOSYAL BİLGİLER', icon: '🌍', color: '#f59e0b' },
  { id: 'ingilizce', name: 'İNGİLİZCE', icon: '🔤', color: '#a855f7' },
  { id: 'din', name: 'DİN KÜLTÜRÜ', icon: '🕌', color: '#14b8a6' },
  { id: 'tarih', name: 'TARİH', icon: '🏛️', color: '#b45309' },
  { id: 'cografya', name: 'COĞRAFYA', icon: '🧭', color: '#0ea5e9' },
];

const QUESTIONS = [
  { question: "Türkiye'nin başkenti neresidir?", options: { A: 'İstanbul', B: 'Ankara', C: 'İzmir', D: 'Bursa' }, correctAnswer: 'B' },
  { question: 'Bir yılda kaç ay vardır?', options: { A: '10', B: '11', C: '12', D: '13' }, correctAnswer: 'C' },
  { question: 'Hangisi bir meyvedir?', options: { A: 'Elma', B: 'Masa', C: 'Kalem', D: 'Defter' }, correctAnswer: 'A' },
  { question: '3 + 4 kaçtır?', options: { A: '6', B: '8', C: '7', D: '9' }, correctAnswer: 'C' },
  { question: 'Güneş hangi yönden doğar?', options: { A: 'Batı', B: 'Kuzey', C: 'Güney', D: 'Doğu' }, correctAnswer: 'D' },
];

const game = { phase: 'setup', subject: null, order: [], round: 0, current: null, endsAt: 0, startCount: 0, timer: null, result: null, winner: null };

function later(ms, fn) { clearTimeout(game.timer); game.timer = setTimeout(fn, ms); }
function zoneOf(x, y) { return y < ZONE_Y ? null : 'ABCD'[Math.min(3, Math.floor(x / (WORLD_W / 4)))]; }
function canMove(p) { return p.alive && !p.waiting && game.phase === 'question'; } // sadece soru sirasinda hareket

function baseState() { // dogru cevap burada YOK
  const s = { phase: game.phase, subject: game.subject, zoneY: ZONE_Y, round: game.round, endsIn: Math.max(0, game.endsAt - Date.now()), winner: game.winner };
  if (game.phase === 'setup') s.subjects = SUBJECTS;
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
  io.to(sid).emit('me:update', { lives: p.lives, score: p.score, alive: p.alive, waiting: p.waiting, last: p.last });
}
function pushMe() { players.forEach((p, sid) => sendMe(sid, p)); }

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function resetToLobby() {
  clearTimeout(game.timer);
  Object.assign(game, { phase: game.subject ? 'lobby' : 'setup', current: null, result: null, winner: null, round: 0, endsAt: 0 });
  players.forEach((p) => { p.lives = START_LIVES; p.score = 0; p.alive = true; p.waiting = false; p.last = null; });
  pushState(); broadcastPlayers(); pushMe();
}

function startGame() {
  game.order = shuffle(QUESTIONS.map((_, i) => i));
  game.round = 0; game.winner = null;
  players.forEach((p) => { p.lives = START_LIVES; p.score = 0; p.alive = true; p.waiting = false; p.last = null; });
  game.startCount = players.size;
  players.forEach((p) => { const pos = slotPos(p.slot); p.x = pos.x; p.y = pos.y; p.zone = ''; p.ix = 0; p.iy = 0; }); // herkes baslangic alanindan baslar
  dirty = true;
  nextQuestion();
  broadcastPlayers();
}

function nextQuestion() {
  game.current = QUESTIONS[game.order[game.round % game.order.length]];
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
    if (zoneOf(p.x, p.y) === game.current.correctAnswer) {
      p.score += POINTS; p.last = 'correct'; per[p.id] = 'correct';
    } else { // yanlis bolge VEYA hicbir bolgede degil
      p.lives -= 1; p.last = 'wrong'; per[p.id] = 'wrong';
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
  if (!all.length) return resetToLobby();
  const pool = active.length === 1 ? active : all; // herkes elendiyse en yuksek puanlilar kazanir
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
      lives: START_LIVES, score: 0, alive: true, last: null, zone: '',
      waiting: !['setup', 'lobby'].includes(game.phase), // oyun surerken katilan, siradaki oyunu bekler
      color: old ? old.color : freeColor(),
      slot,
      x: pos.x,
      y: pos.y,
      ix: 0, iy: 0,        // joystick girdisi (-1..1)
      lastInputAt: 0,
    };
    if (old) { player.lives = old.lives; player.score = old.score; player.alive = old.alive; player.waiting = old.waiting; player.last = old.last; }
    players.set(socket.id, player);

    console.log(`[+] ${player.name} (${player.id}) bağlandı. Toplam: ${players.size}`);
    reply({ ok: true, player: publicPlayer(player) });
    socket.emit('game:state', baseState());
    sendMe(socket.id, player);
    io.to('board').emit('player:joined', { id: player.id, name: player.name, color: player.color });
    broadcastPlayers();
  });

  // Sadece tahta (board) oyunu baslatabilir / yeni oyuna gecebilir
  socket.on('game:start', () => {
    if (!socket.rooms.has('board') || game.phase !== 'lobby' || !game.subject || players.size < 1) return;
    startGame();
  });
  // Ders secimi (setup) -> lobi -> oyun. Sadece tahta yapabilir.
  socket.on('game:subject', (id) => {
    if (!socket.rooms.has('board') || (game.phase !== 'setup' && game.phase !== 'lobby')) return;
    const s = SUBJECTS.find((x) => x.id === id);
    if (!s) return;
    game.subject = s;
    pushState();
  });
  socket.on('game:lobby', () => {
    if (!socket.rooms.has('board') || game.phase !== 'setup' || !game.subject) return;
    game.phase = 'lobby'; pushState(); pushMe();
  });
  socket.on('game:setup', () => {
    if (!socket.rooms.has('board') || game.phase !== 'lobby') return;
    game.phase = 'setup'; pushState(); pushMe();
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
