/*
game.js = OYUN EKRANI MANTIGI (game.html icin; bilgisayar / akilli tahta)
- Sunucudan gelen oyuncu listesini ve konumlarini cizer. Hicbir konumu kendisi belirlemez.
- Durum: SUNUCU BAGLI / BAGLANTI BEKLENIYOR, OYUNCULAR: n/20, stickman karakterler.
- Dosyanin sonundaki ikinci blok QR kodu yukler.
*/
(() => {
  const socket = io();
  const WORLD_W = 1600, WORLD_H = 900; // server.js ile ayni olmali
  const MAX = 20;
  const $counter = document.getElementById('counter');
  const $status = document.getElementById('status');
  const $world = document.getElementById('world');
  const $panel = document.getElementById('joinPanel');

  function setStatus(text, ok) {
    $status.textContent = text;
    $status.className = 'status ' + (ok ? 'ok' : 'bad');
  }

  // ---- Stickman karakterler (yalnizca sunucudan gelen konumu cizer) ----
  const chars = new Map(); // id -> { el, x, y, tx, ty, dirty, walking, moveT }
  let ww = 1, wh = 1;

  function measure() {
    ww = $world.clientWidth || 1;
    wh = $world.clientHeight || 1;
    chars.forEach((c) => { c.dirty = true; });
  }
  new ResizeObserver(measure).observe($world);
  measure();

  function makeChar(p) {
    const el = document.createElement('div');
    el.className = 'char';
    el.style.setProperty('--c', p.color);
    el.innerHTML = '<i class="leg l"></i><i class="leg r"></i><i class="torso"></i>' +
      '<i class="arm l"></i><i class="arm r"></i><i class="head"></i><span class="tag"></span>';
    el.querySelector('.tag').textContent = p.name; // textContent: guvenli
    $world.appendChild(el);
    chars.set(p.id, { el, x: p.x, y: p.y, tx: p.x, ty: p.y, dirty: true, walking: false, moveT: 0 });
  }

  function syncChars(list) {
    const ids = new Set();
    list.forEach((p) => { ids.add(p.id); if (!chars.has(p.id)) makeChar(p); });
    chars.forEach((c, id) => { if (!ids.has(id)) { c.el.remove(); chars.delete(id); } });
    $counter.textContent = `OYUNCULAR: ${list.length}/${MAX}`;
    if (list.length === 0) $panel.classList.add('big');       // oyuncu yokken QR buyuk
    else if (!syncChars.seen) $panel.classList.remove('big');  // ilk oyuncuda kucult
    syncChars.seen = list.length > 0;
  }

  let last = performance.now();
  function frame(t) {
    const dt = Math.min((t - last) / 1000, 0.1);
    last = t;
    const k = 1 - Math.exp(-dt * 20); // yumusak takip
    chars.forEach((c) => {
      const dx = c.tx - c.x, dy = c.ty - c.y;
      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) { c.x += dx * k; c.y += dy * k; c.dirty = true; }
      const moving = Math.abs(dx) > 1.5 || Math.abs(dy) > 1.5;
      if (moving) c.moveT = t;
      const walking = t - c.moveT < 150;
      if (walking !== c.walking) { c.walking = walking; c.el.classList.toggle('walk', walking); }
      if (c.dirty) {
        c.el.style.transform = `translate3d(${c.x / WORLD_W * ww}px,${c.y / WORLD_H * wh}px,0)`;
        c.dirty = false;
      }
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  socket.on('connect', () => {
    setStatus('● SUNUCU BAĞLI', true);
    socket.emit('board:join'); // yeniden baglanmada da tekrar katil
  });
  socket.on('disconnect', () => setStatus('● BAĞLANTI BEKLENİYOR', false));
  socket.on('connect_error', () => setStatus('● BAĞLANTI BEKLENİYOR', false));

  socket.on('players:update', syncChars);
  socket.on('state:update', (list) => {
    list.forEach(([id, x, y]) => {
      const c = chars.get(id);
      if (c) { c.tx = x; c.ty = y; }
    });
  });

  $panel.addEventListener('click', () => $panel.classList.toggle('big')); // QR'a dokun: buyut/kucult
})();

// QR katilim paneli - Socket.IO kodundan bagimsiz
(() => {
  const $qrBox = document.getElementById('qrBox');
  const $joinUrl = document.getElementById('joinUrl');
  let lastUrl = '';

  async function loadJoinInfo() {
    try {
      const res = await fetch('/api/join-info', { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok) {
        lastUrl = '';
        $qrBox.textContent = data.error || 'QR kod oluşturulamadı.';
        $joinUrl.textContent = '';
        return;
      }
      if (data.url !== lastUrl) { // sadece adres degisince yeniden ciz
        lastUrl = data.url;
        $qrBox.innerHTML = data.svg; // svg sunucuda yerel uretilir
        $joinUrl.textContent = data.url;
      }
    } catch (e) { /* sonraki denemede tekrar dene */ }
  }

  loadJoinInfo();
  setInterval(loadJoinInfo, 10000);
})();
