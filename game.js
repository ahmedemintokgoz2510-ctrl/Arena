/*
game.js = OYUN EKRANI MANTIGI (game.html icin; bilgisayar / akilli tahta)
- Sunucudan gelen durumu, oyunculari, konumlari, soruyu ve sonuclari CIZER. Hicbir kural / konum burada belirlenmez.
- 2.5D: zemin CSS perspektifiyle yatirilir; karakterler ayni matematikle zemine yerlestirilir (uzaktakiler kucuk).
- Dosyanin sonundaki ikinci blok QR kodu yukler.
*/
(() => {
  const socket = io();
  const WORLD_W = 1600, WORLD_H = 900, MAX = 20; // server.js ile ayni
  const TILT = 26, TH = TILT * Math.PI / 180, SIN = Math.sin(TH), COS = Math.cos(TH), K = 1.8; // perspektif ayari
  const $ = (id) => document.getElementById(id);
  const $setup = $('setup'), $lobby = $('lobby'), $game = $('game'), $status = $('status');
  const $cards = $('cards'), $open = $('openLobby'), $start = $('startBtn'), $change = $('changeSubject');
  const $lobbySubject = $('lobbySubject'), $lobbyCount = $('lobbyCount'), $plist = $('plist');
  const $counter = $('counter'), $qmeta = $('qmeta'), $qtext = $('qtext'), $timer = $('timer');
  const $plane = $('plane'), $floor = $('floor'), $world = $('world');
  const $winBox = $('winnerBox'), $winName = $('winName'), $winScore = $('winScore'), $reset = $('resetBtn');
  const zones = Array.from($floor.querySelectorAll('.zone'));
  const LETTERS = ['A', 'B', 'C', 'D'];

  let players = [], phase = 'setup', subject = null, subjects = null, question = null, result = null;
  let winner = null, deadline = 0, round = 0, zoneY = 400;

  function setStatus(text, ok) {
    $status.textContent = text;
    $status.className = 'status ' + (ok ? 'ok' : 'bad');
  }

  // ---- 2.5D yerlestirme ----
  const chars = new Map(); // id -> { el, tag, pop, p, x, y, tx, ty, zone, dirty, walking, moveT }
  let pw = 1, ph = 1, FW = 1, FH = 1, midY = 0;

  function measure() {
    pw = $plane.clientWidth || 1; ph = $plane.clientHeight || 1;
    const sb = K / (K - 0.5 * SIN), st = K / (K + 0.5 * SIN); // alt kenar buyuk, ust kenar kucuk
    FW = pw / sb;
    FH = ph / (0.5 * COS * (sb + st));
    midY = 0.25 * FH * COS * (sb - st);
    Object.assign($floor.style, {
      width: FW + 'px', height: FH + 'px', left: (pw - FW) / 2 + 'px', top: (ph - FH) / 2 - midY + 'px',
      transform: `perspective(${K * FH}px) rotateX(${TILT}deg)`,
    });
    chars.forEach((c) => { c.dirty = true; });
  }
  new ResizeObserver(measure).observe($plane);
  measure();

  function makeChar(p) {
    const el = document.createElement('div');
    el.className = 'char';
    el.style.setProperty('--c', p.color);
    el.innerHTML = '<div class="shadow"></div><div class="ring"></div><div class="fig">' +
      '<i class="leg l"></i><i class="leg r"></i><i class="torso"></i><i class="arm l"></i><i class="arm r"></i>' +
      '<i class="head"></i><span class="tag"></span><em class="pop"></em></div>';
    $world.appendChild(el);
    chars.set(p.id, { el, tag: el.querySelector('.tag'), pop: el.querySelector('.pop'), p, x: p.x, y: p.y, tx: p.x, ty: p.y, zone: '', dirty: true, walking: false, moveT: 0, z: -1 });
  }

  function paint(c) {
    const p = c.p;
    c.el.classList.toggle('out', !p.alive);
    c.el.classList.toggle('wait', !!p.waiting && p.alive);
    c.tag.textContent = p.name + (phase !== 'lobby' && phase !== 'setup' && p.alive && !p.waiting ? ' · ' + p.score : '');
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
        const v = c.y / WORLD_H - 0.5, s = K / (K - v * SIN); // perspektif olcegi
        const sx = pw / 2 + (c.x / WORLD_W - 0.5) * FW * s, sy = ph / 2 - midY + v * FH * COS * s;
        c.el.style.transform = `translate3d(${sx}px,${sy}px,0) scale(${s})`;
        const z = Math.round(c.y);
        if (z !== c.z) { c.z = z; c.el.style.zIndex = z; } // asagidaki (yakin) karakter one gelir
        c.dirty = false;
      }
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- Cevap bolgesi vurgusu (sunucunun hesapladigi bolgeye gore) ----
  let zsig = '';
  function zoneGlow() {
    const cnt = { A: 0, B: 0, C: 0, D: 0 };
    chars.forEach((c) => { if (c.zone && c.p.alive && !c.p.waiting) cnt[c.zone]++; });
    const sig = phase + JSON.stringify(cnt);
    if (sig === zsig) return;
    zsig = sig;
    LETTERS.forEach((L, i) => zones[i].classList.toggle('on', phase === 'question' && cnt[L] > 0));
  }

  // ---- Arayuz (sunucu durumuna gore) ----
  function renderCards() {
    if (!subjects || $cards.childElementCount) return;
    subjects.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'sc'; b.dataset.id = s.id; b.style.setProperty('--c', s.color);
      b.innerHTML = '<span class="ic"></span><span class="nm"></span><span class="ck">✓</span>';
      b.querySelector('.ic').textContent = s.icon;
      b.querySelector('.nm').textContent = s.name;
      b.addEventListener('click', () => socket.emit('game:subject', s.id));
      $cards.appendChild(b);
    });
  }

  function fitQuestion(text) { // uzun sorular icin yazi boyutu
    const n = text.length;
    $qtext.style.fontSize = n <= 60 ? '2.4em' : n <= 110 ? '1.9em' : n <= 180 ? '1.5em' : '1.25em';
  }

  function ui() {
    const inGame = phase === 'question' || phase === 'result' || phase === 'winner';
    $setup.classList.toggle('hidden', phase !== 'setup');
    $lobby.classList.toggle('hidden', phase !== 'lobby');
    $game.classList.toggle('hidden', !inGame);
    if (inGame) measure();

    // ders secimi
    renderCards();
    $cards.querySelectorAll('.sc').forEach((b) => b.classList.toggle('sel', !!subject && b.dataset.id === subject.id));
    $open.disabled = !subject;

    // lobi
    $lobbySubject.textContent = subject ? `${subject.icon} ${subject.name}` : '';
    $lobbyCount.textContent = `OYUNCULAR ${players.length}/${MAX}`;
    $plist.innerHTML = '';
    players.forEach((p) => {
      const li = document.createElement('li');
      const dot = document.createElement('i'); dot.style.background = p.color;
      li.appendChild(dot); li.appendChild(document.createTextNode(p.name)); // textContent: guvenli
      $plist.appendChild(li);
    });
    $start.disabled = !(subject && players.length > 0);
    $start.textContent = players.length > 0 ? 'OYUNU BAŞLAT' : 'OYUNCU BEKLENİYOR...';

    // oyun
    const alive = players.filter((p) => p.alive && !p.waiting).length;
    $counter.textContent = `OYUNCULAR: ${players.length}/${MAX}` + (phase === 'question' || phase === 'result' ? ` · HAYATTA: ${alive}` : '');
    $qmeta.textContent = (subject ? subject.name + ' • ' : '') + `Soru ${round}`;
    let text = '';
    if (phase === 'question' && question) text = question.text;
    else if (phase === 'result' && result && question) text = `Doğru cevap: ${result.correct} — ${question.options[result.correct]}`;
    else if (phase === 'winner') text = 'OYUN BİTTİ';
    $qtext.textContent = text; fitQuestion(text);
    $qtext.classList.toggle('good', phase === 'result');
    $timer.classList.toggle('hidden', phase !== 'question');

    // bolgeler: cevap metni + sonuc renkleri (dogru = yesil, yanlis oyuncu olan bolge = kirmizi)
    const wrongZ = new Set();
    if (phase === 'result' && result) chars.forEach((c, id) => { if (result.per[id] === 'wrong' && c.zone) wrongZ.add(c.zone); });
    zones.forEach((z, i) => {
      const L = LETTERS[i];
      const ok = phase === 'result' && !!result && result.correct === L;
      const bad = phase === 'result' && !ok && wrongZ.has(L);
      z.querySelector('span').textContent = question && inGame ? question.options[L] : '';
      z.classList.toggle('ok', ok);
      z.classList.toggle('bad', bad);
      z.classList.toggle('no', phase === 'result' && !ok && !bad);
    });
    $floor.style.setProperty('--zy', (zoneY / WORLD_H * 100) + '%');
    zsig = ''; zoneGlow();

    // karakter efektleri
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

  $open.addEventListener('click', () => socket.emit('game:lobby'));
  $change.addEventListener('click', () => socket.emit('game:setup'));
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
    list.forEach(([id, x, y, z]) => {
      const c = chars.get(id);
      if (c) { c.tx = x; c.ty = y; c.zone = z; }
    });
    zoneGlow();
  });
  socket.on('game:state', (s) => {
    const prev = phase;
    phase = s.phase; subject = s.subject || null; question = s.question || null; result = s.result || null;
    winner = s.winner || null; round = s.round || 0; zoneY = s.zoneY || zoneY;
    if (s.subjects) subjects = s.subjects;
    deadline = performance.now() + (s.endsIn || 0);
    ui();
    if (phase === 'question' && round === 1 && prev !== 'question') { // oyun basinda herkes kendi halkasini gorsun
      chars.forEach((c) => c.el.classList.add('new'));
      setTimeout(() => chars.forEach((c) => c.el.classList.remove('new')), 4000);
    }
  });
})();

// QR katilim paneli (lobide gorunur) - Socket.IO kodundan bagimsiz
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
