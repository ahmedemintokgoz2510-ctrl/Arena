/*
controller.js = TELEFON KUMANDASI MANTIGI (controller.html icin)
- Isim girip katilma, sanal joystick (pointer events), baglanti durumu.
- Can / puan / elenme bilgisi SADECE sunucudan gelir (me:update); telefon kendi basina belirleyemez.
- Sunucuya sadece joystick yonunu (-1..1) yollar. Baglanti kopup gelirse otomatik yeniden katilir.
*/
(() => {
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const $join = $('joinView'), $conn = $('connectedView'), $input = $('nameInput'), $btn = $('joinBtn');
  const $err = $('err'), $name = $('playerName'), $zone = $('stickZone'), $stick = $('stick'), $knob = $('knob');
  const $connJoin = $('connJoin'), $hudMid = $('hudMid'), $hearts = $('hearts'), $score = $('score');
  const $count = $('count'), $msg = $('msg');

  let joined = false, lastName = '', myId = '';
  const me = { lives: 3, score: 0, alive: true, waiting: false, last: null }; // sunucudan gelen kopya
  let phase = 'lobby', winner = null, deadline = 0;

  // Telefonun kalici kimligi (sekme basina): yeniden baglaninca ayni oyuncu taninir
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

  const canPlay = () => me.alive && !me.waiting && (phase === 'lobby' || phase === 'question');

  function render() {
    $hearts.textContent = '❤️'.repeat(Math.max(0, me.lives)) + '🖤'.repeat(Math.max(0, 3 - me.lives));
    $score.textContent = 'PUAN: ' + me.score;
    let msg = '', cls = '';
    if (phase === 'winner') msg = winner && winner.ids.includes(myId) ? 'KAZANDIN! 🏆' : 'OYUN BİTTİ';
    else if (!me.alive) { msg = 'ELENDİN'; cls = 'bad'; }
    else if (me.waiting) msg = 'SIRADAKİ OYUNU BEKLE';
    else if (phase === 'lobby') msg = 'OYUNUN BAŞLAMASINI BEKLE';
    else if (phase === 'question') msg = 'CEVAP BÖLGESİNE GİT';
    else if (phase === 'result') {
      if (me.last === 'correct') { msg = 'DOĞRU! +100'; cls = 'ok'; }
      else if (me.last === 'wrong') { msg = 'YANLIŞ! −1 CAN'; cls = 'bad'; }
    }
    $msg.textContent = msg;
    $msg.className = 'msg ' + cls;
    $conn.classList.toggle('locked', !canPlay());
  }

  setInterval(() => {
    const t = phase === 'question' ? Math.max(0, Math.ceil((deadline - performance.now()) / 1000)) : '';
    if ($count.textContent !== String(t)) $count.textContent = t;
  }, 250);

  socket.on('game:state', (s) => {
    phase = s.phase; winner = s.winner || null;
    deadline = performance.now() + (s.endsIn || 0);
    render();
    if (!canPlay()) release();
  });
  socket.on('me:update', (m) => { Object.assign(me, m); render(); if (!canPlay()) release(); });

  // ---------- Katilim ----------
  function showPlay(player) {
    myId = player.id;
    $name.textContent = player.name;
    $knob.style.background = player.color || '#3b82f6';
    $err.textContent = '';
    $join.classList.add('hidden');
    $conn.classList.remove('hidden');
  }

  function join() {
    const name = $input.value.trim();
    if (!name) { $err.textContent = 'Lütfen adını yaz.'; $input.focus(); return; }
    if (!socket.connected) { $err.textContent = 'Sunucuya bağlanılamadı. İnterneti kontrol et.'; return; }
    $btn.disabled = true;
    $err.textContent = '';
    socket.emit('player:join', { name, key: clientKey }, (res) => {
      $btn.disabled = false;
      if (!res || !res.ok) { $err.textContent = (res && res.error) || 'Katılım başarısız.'; return; }
      joined = true;
      lastName = res.player.name;
      Object.assign(me, { lives: res.player.lives, score: res.player.score, alive: res.player.alive, waiting: res.player.waiting });
      showPlay(res.player);
      render();
    });
  }

  $btn.addEventListener('click', join);
  $input.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  // ---------- Joystick (pointer events; touch-action:none ile kaydirma yok) ----------
  const SEND_MS = 33, DEADZONE = 0.12;
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
    const x = Math.round(vx * 100) / 100, y = Math.round(vy * 100) / 100;
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
    if (activeId !== null || !canPlay()) return; // tek parmak; elenen/bekleyen oynayamaz
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
  ['gesturestart', 'gesturechange', 'contextmenu'].forEach((n) => document.addEventListener(n, (e) => e.preventDefault()));
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

  // ---------- Baglanti durumu ----------
  socket.on('connect', () => {
    setConn(true);
    if (joined) {
      socket.emit('player:join', { name: lastName, key: clientKey }, (res) => { if (res && res.ok) showPlay(res.player); });
    }
  });
  socket.on('disconnect', () => { release(); setConn(false); });
  socket.on('connect_error', () => setConn(false));
  setConn(socket.connected);
})();
