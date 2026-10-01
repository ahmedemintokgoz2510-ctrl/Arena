/*
game.js = OYUN EKRANI MANTIGI (game.html icin; bilgisayar / akilli tahta)
- Sunucudan gelen oyuncu, konum, soru, sure ve sonuclari CIZER. Hicbir kural / konum burada belirlenmez.
- Dosyanin sonundaki ikinci blok QR kodu yukler.
*/
(() => {
  const socket = io();
  const WORLD_W = 1600, WORLD_H = 900; // server.js ile ayni olmali
  const MAX = 20;
  const $ = (id) => document.getElementById(id);
  const $counter = $('counter'), $status = $('status'), $world = $('world'), $panel = $('joinPanel');
  const $qtext = $('qtext'), $timer = $('timer'), $start = $('startBtn');
  const $winBox = $('winnerBox'), $winName = $('winName'), $winScore = $('winScore'), $reset = $('resetBtn');
  const zones = Array.from($world.querySelectorAll('.zone'));

  let players = [], phase = 'lobby', question = null, result = null, winner = null, deadline = 0;

  function setStatus(text, ok) {
    $status.textContent = text;
    $status.className = 'status ' + (ok ? 'ok' : 'bad');
  }

  // ---- Stickman karakterler (yalnizca sunucudan gelen konumu cizer) ----
  const chars = new Map(); // id -> { el, tag, pop, p, x, y, tx, ty, dirty, walking, moveT }
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
      '<i class="arm l"></i><i class="arm r"></i><i class="head"></i><span class="tag"></span><em class="pop"></em>';
    $world.appendChild(el);
    chars.set(p.id, { el, tag: el.querySelector('.tag'), pop: el.querySelector('.pop'), p, x: p.x, y: p.y, tx: p.x, ty: p.y, dirty: true, walking: false, moveT: 0 });
  }

  function paint(c) {
    const p = c.p;
    c.el.classList.toggle('out', !p.alive || p.waiting);
    c.tag.textContent = p.name + (phase !== 'lobby' && p.alive && !p.waiting ? ' · ' + p.score : '');
  }

  function syncChars(list) {
    const ids = new Set();
    list.forEach((p) => {
      ids.add(p.id);
      if (!chars.has(p.id)) makeChar(p);
      const c = chars.get(p.id);
      c.p = p; paint(c);
    });
    chars.forEach((c, id) => { if (!ids.has(id)) { c.el.remove(); chars.delete(id); } });
  }

  let last = performance.now();
  function frame(t) {
    const dt = Math.min((t - last) / 1000, 0.1);
    last = t;
    const k = 1 - Math.exp(-dt * 20); // yumusak takip
    chars.forEach((c) => {
      const dx = c.tx - c.x, dy = c.ty - c.y;
      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) { c.x += dx * k; c.y += dy * k; c.dirty = true; }
      if (Math.abs(dx) > 1.5 || Math.abs(dy) > 1.5) c.moveT = t;
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

  // ---- Arayuz (sunucu durumuna gore) ----
  function ui() {
    const alive = players.filter((p) => p.alive && !p.waiting).length;
    $counter.textContent = `OYUNCULAR: ${players.length}/${MAX}` + (phase !== 'lobby' && phase !== 'winner' ? ` · HAYATTA: ${alive}` : '');

    if (players.length === 0) $panel.classList.add('big'); // oyuncu yokken QR buyuk
    else if (!ui.seen) $panel.classList.remove('big');     // ilk oyuncuda kucult
    ui.seen = players.length > 0;

    let text = 'JOYSTICK İLE KARAKTERİNİ HAREKET ETTİR';
    if (phase === 'question' && question) text = question.text;
    else if (phase === 'result' && result && question) text = `Doğru cevap: ${result.correct} — ${question.options[result.correct]}`;
    else if (phase === 'winner') text = 'OYUN BİTTİ';
    $qtext.textContent = text;
    $qtext.classList.toggle('good', phase === 'result');

    $timer.classList.toggle('hidden', phase !== 'question');
    $start.classList.toggle('hidden', !(phase === 'lobby' && players.length > 0));

    ['A', 'B', 'C', 'D'].forEach((L, i) => {
      const z = zones[i];
      z.querySelector('span').textContent = question && phase !== 'lobby' ? question.options[L] : '';
      z.classList.toggle('ok', phase === 'result' && !!result && result.correct === L);
      z.classList.toggle('no', phase === 'result' && !!result && result.correct !== L);
    });

    chars.forEach((c, id) => {
      const r = phase === 'result' && result ? result.per[id] : null;
      c.el.classList.toggle('good', r === 'correct');
      c.el.classList.toggle('bad', r === 'wrong');
      c.pop.textContent = r === 'correct' ? '+100' : r === 'wrong' ? '−1 ❤️' : '';
      paint(c);
    });

    $winBox.classList.toggle('hidden', !(phase === 'winner' && winner));
    if (phase === 'winner' && winner) {
      $winName.textContent = winner.names.join(' & ');
      $winScore.textContent = 'Puan: ' + winner.score;
    }
  }

  setInterval(() => {
    if (phase !== 'question') return;
    const t = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    $timer.textContent = t;
    $timer.classList.toggle('low', t <= 5);
  }, 200);

  $start.addEventListener('click', () => socket.emit('game:start'));
  $reset.addEventListener('click', () => socket.emit('game:reset'));

  socket.on('connect', () => {
    setStatus('● SUNUCU BAĞLI', true);
    socket.emit('board:join'); // yeniden baglanmada da tekrar katil
  });
  socket.on('disconnect', () => setStatus('● BAĞLANTI BEKLENİYOR', false));
  socket.on('connect_error', () => setStatus('● BAĞLANTI BEKLENİYOR', false));

  socket.on('players:update', (list) => { players = list; syncChars(list); ui(); });
  socket.on('state:update', (list) => {
    list.forEach(([id, x, y]) => {
      const c = chars.get(id);
      if (c) { c.tx = x; c.ty = y; }
    });
  });
  socket.on('game:state', (s) => {
    phase = s.phase; question = s.question || null; result = s.result || null; winner = s.winner || null;
    deadline = performance.now() + (s.endsIn || 0);
    ui();
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
