/*
controller.js = TELEFON KUMANDASI MANTIGI (controller.html icin)
- Isim girip katilma, sanal joystick (pointer events), baglanti durumu gostergesi.
- Sadece joystick yonunu (-1..1) sunucuya yollar; karakterin konumunu SUNUCU belirler.
- Baglanti kopup gelirse ayni telefon kimligiyle (clientKey) otomatik yeniden katilir.
*/
(() => {
  const socket = io();
  const $join = document.getElementById('joinView');
  const $conn = document.getElementById('connectedView');
  const $input = document.getElementById('nameInput');
  const $btn = document.getElementById('joinBtn');
  const $err = document.getElementById('err');
  const $name = document.getElementById('playerName');
  const $zone = document.getElementById('stickZone');
  const $stick = document.getElementById('stick');
  const $knob = document.getElementById('knob');

  let joined = false;
  let lastName = '';
  const $connJoin = document.getElementById('connJoin');
  const $hudMid = document.getElementById('hudMid');

  // Telefonun kalici kimligi (sekme basina). Yeniden baglaninca sunucu ayni oyuncuyu taniyabilsin.
  let clientKey = '';
  try { clientKey = sessionStorage.getItem('arenaKey') || ''; } catch (e) {}
  if (!clientKey) {
    clientKey = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem('arenaKey', clientKey); } catch (e) {}
  }

  function setConn(ok) {
    const text = ok ? '● BAĞLI' : '● BAĞLANTI KESİLDİ';
    [$connJoin, $hudMid].forEach((el) => { el.textContent = text; el.classList.toggle('bad', !ok); });
    $conn.classList.toggle('offline', !ok);
  }

  // ---------- Katilim ----------
  function showPlay(player) {
    $name.textContent = 'Oyuncu: ' + player.name;
    $knob.style.background = player.color || '#38bdf8';
    $err.textContent = '';
    $join.classList.add('hidden');
    $conn.classList.remove('hidden');
  }

  function join() {
    const name = $input.value.trim();
    if (!name) { $err.textContent = 'Lütfen bir oyuncu adı gir.'; return; }
    if (!socket.connected) { $err.textContent = 'Sunucuya bağlanılamadı. Wi-Fi ve adresi kontrol et.'; return; }
    $btn.disabled = true;
    $err.textContent = '';
    socket.emit('player:join', { name, key: clientKey }, (res) => {
      $btn.disabled = false;
      if (!res || !res.ok) { $err.textContent = (res && res.error) || 'Katılım başarısız.'; return; }
      joined = true;
      lastName = res.player.name;
      showPlay(res.player);
    });
  }

  $btn.addEventListener('click', join);
  $input.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  // ---------- Joystick (pointer events; touch-action:none ile kaydirma yok) ----------
  const SEND_MS = 33;      // ~30 girdi/sn
  const DEADZONE = 0.12;
  let activeId = null, vx = 0, vy = 0, timer = null;
  const sent = { x: 0, y: 0, t: 0 };

  function draw() {
    const R = $stick.clientWidth * 0.29;
    $knob.style.transform = `translate(-50%,-50%) translate(${vx * R}px,${vy * R}px)`;
  }

  function update(e) {
    const r = $stick.getBoundingClientRect();
    const R = r.width * 0.29;
    let dx = (e.clientX - (r.left + r.width / 2)) / R;
    let dy = (e.clientY - (r.top + r.height / 2)) / R;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    if (len < DEADZONE) { dx = 0; dy = 0; }
    vx = dx; vy = dy;
    draw();
  }

  function send(force) {
    const x = Math.round(vx * 100) / 100;
    const y = Math.round(vy * 100) / 100;
    const now = performance.now();
    if (!force && x === sent.x && y === sent.y && now - sent.t < 150) return;
    if (!socket.connected) return;
    sent.x = x; sent.y = y; sent.t = now;
    socket.emit('player:input', { x, y });
  }

  function release() {
    if (activeId === null) return;
    activeId = null;
    clearInterval(timer); timer = null;
    vx = 0; vy = 0;
    draw();
    send(true); // sifir girdi: karakter durur
  }

  $zone.addEventListener('pointerdown', (e) => {
    if (activeId !== null) return; // tek parmak
    activeId = e.pointerId;
    $zone.setPointerCapture(e.pointerId);
    update(e);
    send(true);
    timer = setInterval(() => send(false), SEND_MS);
    e.preventDefault();
  });
  $zone.addEventListener('pointermove', (e) => { if (e.pointerId === activeId) update(e); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((n) =>
    $zone.addEventListener(n, (e) => { if (e.pointerId === activeId) release(); }));

  // iOS Safari: kaydirma, yakinlastirma, uzun basma menusunu engelle
  document.addEventListener('touchmove', (e) => { if (!e.target.closest('input')) e.preventDefault(); }, { passive: false });
  ['gesturestart', 'gesturechange', 'contextmenu'].forEach((n) =>
    document.addEventListener(n, (e) => e.preventDefault()));
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

  // ---------- Baglanti durumu ----------
  // Baglanti kopup geri gelirse ayni isimle otomatik yeniden katil
  socket.on('connect', () => {
    setConn(true);
    if (joined) {
      socket.emit('player:join', { name: lastName, key: clientKey }, (res) => { if (res && res.ok) showPlay(res.player); });
    }
  });
  socket.on('disconnect', () => {
    release();
    setConn(false); // ekranda BAGLANTI KESILDI gorunur; baglanti gelince otomatik yeniden katilir
  });
  socket.on('connect_error', () => setConn(false));
  setConn(socket.connected);
})();
