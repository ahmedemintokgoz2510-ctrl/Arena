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
  const $count = $('count'), $msg = $('msg'), $zoneBox = $('zoneBox'), $zoneLetter = $('zoneLetter'), $dot = $('colorDot'), $map = $('miniMap');

  let joined = false, lastName = '', myId = '';
  const me = { lives: 3, score: 0, alive: true, waiting: false, last: null, zone: '' }; // sunucudan gelen kopya (zone sadece gosterim)
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
    // Bulundugun bolge (sadece gosterim; cevap sure bitince sunucuda konumundan belirlenir)
    const showZone = phase === 'question' && canPlay();
    $zoneBox.className = 'zonebox' + (showZone && me.zone ? ' z-' + me.zone : '') + (showZone ? '' : ' idle');
    $zoneLetter.textContent = showZone ? (me.zone || '–') : '';
    $conn.classList.toggle('res-ok', phase === 'result' && me.last === 'correct');
    $conn.classList.toggle('res-bad', phase === 'result' && me.last === 'wrong');
    $conn.classList.toggle('locked', !canPlay());
    queueMap();
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
  socket.on('me:zone', (z) => { me.zone = z || ''; render(); });
  socket.on('me:update', (m) => { Object.assign(me, m); render(); if (!canPlay()) release(); });

  // ---------- Mini harita (sadece gosterim): tum oyuncular nokta, sen = buyuk + "SEN" ----------
  const WORLD_W = 1600, WORLD_H = 900, ZONE_Y = 300; // server.js ile ayni
  const ZCOL = ['#f87171', '#60a5fa', '#fbbf24', '#c084fc'];
  const ctx = $map.getContext('2d');
  let dots = [], mw = 0, mh = 0, mapRaf = 0;
  function sizeMap() {
    const r = window.devicePixelRatio || 1;
    mw = $map.clientWidth; mh = $map.clientHeight;
    $map.width = Math.round(mw * r); $map.height = Math.round(mh * r);
    ctx.setTransform(r, 0, 0, r, 0, 0);
    drawMap();
  }
  function drawMap() {
    mapRaf = 0;
    if (!mw) return;
    ctx.clearRect(0, 0, mw, mh);
    ctx.fillStyle = '#b9e29c'; ctx.fillRect(0, 0, mw, mh);
    const zy = ZONE_Y / WORLD_H * mh, zw = mw / 4;
    const hot = phase === 'question' && me.zone ? 'ABCD'.indexOf(me.zone) : -1;
    for (let i = 0; i < 4; i++) {
      ctx.globalAlpha = i === hot ? 0.95 : 0.55;
      ctx.fillStyle = ZCOL[i]; ctx.fillRect(i * zw + 1, zy, zw - 2, mh - zy - 1);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff'; ctx.font = '900 ' + Math.round(mh * 0.17) + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('ABCD'[i], i * zw + zw / 2, zy + (mh - zy) / 2);
    }
    let mine = null;
    dots.forEach((d) => {
      const x = d[1] / WORLD_W * mw, y = d[2] / WORLD_H * mh;
      if (d[0] === myId) { mine = [x, y, d[3]]; return; }
      ctx.globalAlpha = d[4] ? 1 : 0.3;
      ctx.fillStyle = d[3]; ctx.beginPath(); ctx.arc(x, y, 3.2, 0, 6.283); ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.stroke();
    });
    ctx.globalAlpha = 1;
    if (mine) { // kendi karakterin: beyaz halka + renkli buyuk nokta + SEN etiketi
      const t = performance.now() / 400, pr = 7 + Math.sin(t) * 1.5;
      ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(mine[0], mine[1], pr, 0, 6.283); ctx.stroke();
      ctx.fillStyle = mine[2]; ctx.beginPath(); ctx.arc(mine[0], mine[1], 5, 0, 6.283); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#1d2b3a'; ctx.stroke();
      ctx.font = '900 11px sans-serif'; ctx.textBaseline = 'alphabetic';
      const ty = mine[1] > 22 ? mine[1] - pr - 4 : mine[1] + pr + 12;
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.strokeText('SEN', mine[0], ty);
      ctx.fillStyle = '#1d2b3a'; ctx.fillText('SEN', mine[0], ty);
    }
  }
  function queueMap() { if (!mapRaf) mapRaf = requestAnimationFrame(drawMap); }
  socket.on('map:update', (list) => { dots = list; queueMap(); });
  setInterval(() => { if (!$conn.classList.contains('hidden')) queueMap(); }, 400); // SEN halkasi nabzi
  window.addEventListener('resize', sizeMap);

  // ---------- Katilim ----------
  function showPlay(player) {
    myId = player.id;
    $name.textContent = player.name;
    const col = player.color || '#3b82f6';
    $conn.style.setProperty('--pc', col);
    $dot.style.background = col;
    $err.textContent = '';
    $join.classList.add('hidden');
    $conn.classList.remove('hidden');
    sizeMap();
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
