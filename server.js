/*
server.js = SUNUCU (bilgisayarda calisir: node server.js)
- Dosyalari sunar (ayni klasordeki html/js/css), QR adresini uretir (/api/join-info).
- Hem yerel agda (bilgisayar) hem internette (Render gibi ucretsiz hosting) calisir.
- TUM oyun durumunu burada tutar: oyuncu id, isim, renk, x, y, baglanti durumu.
- Telefondan sadece joystick girdisi (-1..1) alir; konumu SUNUCU hesaplar ve dogrular.
- Oyun ekranina (game.html) konumlari Socket.IO ile yayinlar.
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
  return { id: p.id, name: p.name, color: p.color, connected: p.connected, x: Math.round(p.x), y: Math.round(p.y) };
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
  players.forEach((p) => {
    if (now - p.lastInputAt > INPUT_TIMEOUT) { p.ix = 0; p.iy = 0; }
    if (p.ix || p.iy) {
      p.x = clamp(p.x + p.ix * SPEED * dt, 0, WORLD_W);
      p.y = clamp(p.y + p.iy * SPEED * dt, 0, WORLD_H);
      dirty = true;
    }
  });
  if (dirty && tickCount % 2 === 0) {
    dirty = false;
    io.to('board').emit('state:update',
      Array.from(players.values()).map((p) => [p.id, Math.round(p.x), Math.round(p.y)]));
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

io.on('connection', (socket) => {
  socket.on('board:join', () => {
    socket.join('board');
    socket.emit('players:update', getPlayerList());
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
      color: old ? old.color : freeColor(),
      slot,
      x: pos.x,
      y: pos.y,
      ix: 0, iy: 0,        // joystick girdisi (-1..1)
      lastInputAt: 0,
    };
    players.set(socket.id, player);

    console.log(`[+] ${player.name} (${player.id}) bağlandı. Toplam: ${players.size}`);
    reply({ ok: true, player: publicPlayer(player) });
    io.to('board').emit('player:joined', { id: player.id, name: player.name, color: player.color });
    broadcastPlayers();
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
    p.ix = x; p.iy = y; p.lastInputAt = now;
  });

  socket.on('disconnect', () => {
    const player = players.get(socket.id);
    if (!player) return;
    players.delete(socket.id);
    console.log(`[-] ${player.name} (${player.id}) ayrıldı. Toplam: ${players.size}`);
    io.to('board').emit('player:left', { id: player.id, name: player.name });
    broadcastPlayers();
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
