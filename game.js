/*
game.js = OYUN EKRANI MANTIGI (game.html icin; bilgisayar / akilli tahta)
- Sunucudan gelen oyuncu, konum, bolge, ders, soru, sure ve sonuclari CIZER. Hicbir kural / konum burada belirlenmez.
- 2.5D gorunum: dunya koordinatlari (1600x900) sadece ekrana PERSPEKTIFLI olarak yansitilir (project()).
  Sunucudaki bolge mantigi (y>=300, 4 sutun) ile gorunen bolge birebir aynidir.
- Dosyanin sonundaki ikinci blok QR kodu yukler.
*/
(() => {
  const socket = io();
  const WORLD_W = 1600, WORLD_H = 900; // server.js ile ayni olmali
  const ZONE_Y = 300;                   // server.js ZONE_Y ile ayni
  const SC0 = 0.78;                     // perspektif: arenanin en ustu en altin %78'i genislikte
  const MAX = 20;
  const $ = (id) => document.getElementById(id);
  const $stage = $('stage'), $counter = $('counter'), $status = $('status'), $world = $('world'), $floor = $('floor');
  const $panel = $('joinPanel'), $chip = $('subjectChip'), $timer = $('timer');
  const $qmeta = $('qmeta'), $qtext = $('qtext'), $qbar = $('qbar');
  const $lobbySubject = $('lobbySubject'), $lobbyCount = $('lobbyCount'), $chips = $('chips');
  const $start = $('startBtn'), $change = $('changeBtn');
  const $picker = $('picker'), $subjects = $('subjects');
  const $winBox = $('winnerBox'), $winName = $('winName'), $winScore = $('winScore'), $reset = $('resetBtn');
  const $lb = $('leaderboard'), $conf = $('confetti');
  const labels = Array.from($world.querySelectorAll('.zlabel'));
  const LETTERS = ['A', 'B', 'C', 'D'];

  let players = [], phase = 'lobby', question = null, result = null, winner = null, deadline = 0;
  let subject = null, subjects = [], round = 0, picking = false, barKey = '', totalMs = 15000, lbKey = '', confettiOn = false;

  function setStatus(text, ok) {
    $status.textContent = text;
    $status.className = 'status ' + (ok ? 'ok' : 'bad');
  }

  // ---- 2.5D projeksiyon ----
  let ww = 1, wh = 1;
  function project(x, y) {
    const f = y / WORLD_H, sc = SC0 + (1 - SC0) * f;
    return [ww / 2 + (x - WORLD_W / 2) / WORLD_W * ww * sc, f * wh, sc];
  }

  // ---- Zemin: kalinligi olan arena plakasi + yukseltilmis A/B/C/D platformlari (SVG) ----
  let zonePolys = [];
  function PP(x, y, dy) { const p = project(x, y); return [p[0], p[1] + (dy || 0)]; }
  function poly(list, cls) { return `<polygon class="${cls}" points="${list.map((q) => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' ')}"/>`; }
  function buildFloor() {
    const T = wh * 0.055, D = wh * 0.05; // plaka ve platform kalinligi (px)
    const X0 = -60, X1 = WORLD_W + 60, Y0 = -40, Y1 = WORLD_H + 40;
    let h = '';
    h += poly([PP(X0, Y1, T * 0.6), PP(X1, Y1, T * 0.6), PP(X1, Y1, T * 1.7), PP(X0, Y1, T * 1.7)], 'slabShadow');
    h += poly([PP(X0, Y1), PP(X1, Y1), PP(X1, Y1, T), PP(X0, Y1, T)], 'slabFront');
    h += poly([PP(X0, Y0), PP(X1, Y0), PP(X1, Y1), PP(X0, Y1)], 'slabTop');
    for (let i = 0; i < 9; i++) {
      h += poly([PP(0, i * 100), PP(WORLD_W, i * 100), PP(WORLD_W, (i + 1) * 100), PP(0, (i + 1) * 100)], 'band ' + (i % 2 ? 'b1' : 'b0'));
    }
    for (let i = 0; i < 4; i++) {
      const x0 = i * WORLD_W / 4, x1 = (i + 1) * WORLD_W / 4, L = LETTERS[i];
      h += `<g class="plat p${L}" data-z="${L}">`;
      h += poly([PP(x0, WORLD_H, D * 0.5), PP(x1, WORLD_H, D * 0.5), PP(x1, WORLD_H, D * 1.5), PP(x0, WORLD_H, D * 1.5)], 'pShadow');
      h += poly([PP(x0, WORLD_H), PP(x1, WORLD_H), PP(x1, WORLD_H, D), PP(x0, WORLD_H, D)], 'pFront');
      h += poly([PP(x0, ZONE_Y), PP(x1, ZONE_Y), PP(x1, WORLD_H), PP(x0, WORLD_H)], 'pTop');
      h += poly([PP(x0 + 14, ZONE_Y + 24), PP(x1 - 14, ZONE_Y + 24), PP(x1 - 14, WORLD_H - 20), PP(x0 + 14, WORLD_H - 20)], 'pInner');
      h += '</g>';
    }
    $floor.setAttribute('viewBox', `0 0 ${ww} ${wh}`);
    $floor.innerHTML = h;
    zonePolys = Array.from($floor.querySelectorAll('.plat'));
    labels.forEach((el, i) => {
      const [lx0, ly] = project(i * WORLD_W / 4, ZONE_Y), [lx1] = project((i + 1) * WORLD_W / 4, ZONE_Y);
      el.style.left = lx0 + 'px'; el.style.width = (lx1 - lx0) + 'px';
      el.style.top = ly + 'px'; el.style.height = (project(0, ZONE_Y + 240)[1] - ly) + 'px';
    });
  }

  function measure() {
    ww = $world.clientWidth || 1;
    wh = $world.clientHeight || 1;
    buildFloor();
    zoneState();
    chars.forEach((c) => { c.dirty = true; });
  }

  // ---- Karakterler (yalnizca sunucudan gelen konumu cizer) ----
  const chars = new Map(); // id -> { el, tag, pop, p, x, y, tx, ty, zone, dirty, walking, moveT, z }

  function makeChar(p) {
    const el = document.createElement('div');
    el.className = 'char';
    el.style.setProperty('--c', p.color);
    el.innerHTML = '<u class="shadow"></u><u class="ring"></u><div class="body"><i class="leg l"></i><i class="leg r"></i><i class="torso"></i>' +
      '<i class="arm l"></i><i class="arm r"></i><i class="head"></i></div><span class="tag"></span><em class="pop"></em>';
    $world.appendChild(el);
    chars.set(p.id, { el, tag: el.querySelector('.tag'), pop: el.querySelector('.pop'), p, x: p.x, y: p.y, tx: p.x, ty: p.y, zone: p.zone || '', dirty: true, walking: false, moveT: 0, z: -1 });
  }

  function paint(c) {
    const p = c.p;
    c.el.classList.toggle('gone', !p.alive);
    c.el.classList.toggle('wait', p.alive && p.waiting);
    let t = p.name; // her karakterin ustunde ismi yazar
    if (!p.alive) t += ' · ELENDİ';
    else if (p.waiting) t += ' · bekliyor';
    if (c.tag.textContent !== t) c.tag.textContent = t;
  }

  function syncChars(list) {
    const ids = new Set();
    list.forEach((p) => {
      ids.add(p.id);
      if (!chars.has(p.id)) makeChar(p);
      const c = chars.get(p.id);
      c.p = p; c.zone = p.zone || ''; paint(c);
    });
    chars.forEach((c, id) => { if (!ids.has(id)) { c.el.remove(); chars.delete(id); } });
  }

  function pulse(id, ms) { // "beni bul": karakter kisa sure vurgulanir
    const c = chars.get(id);
    if (!c) return;
    c.el.classList.add('find');
    clearTimeout(c.findT);
    c.findT = setTimeout(() => c.el.classList.remove('find'), ms || 3000);
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
        const [px, py, sc] = project(c.x, c.y);
        c.el.style.transform = `translate3d(${px.toFixed(1)}px,${py.toFixed(1)}px,0) scale(${(sc * 1.1).toFixed(3)})`;
        const z = Math.round(c.y) + 10;
        if (z !== c.z) { c.z = z; c.el.style.zIndex = z; } // asagidaki karakter one gelir
        c.dirty = false;
      }
    });
    requestAnimationFrame(frame);
  }

  // ---- Bolge vurgulari (sadece gosterim; sunucudan gelen bolge bilgisi) ----
  function zoneState() {
    const count = { A: 0, B: 0, C: 0, D: 0 };
    chars.forEach((c) => {
      const inZ = !!c.zone && c.p.alive && !c.p.waiting;
      if (inZ) count[c.zone]++;
      c.el.classList.toggle('inz', inZ && phase === 'question'); // platformdayken kollar havada
    });
    const q = phase === 'question', r = phase === 'result' && result;
    zonePolys.forEach((z) => {
      const L = z.dataset.z;
      z.classList.toggle('on', q && count[L] > 0);
      z.classList.toggle('ok', !!r && result.correct === L);
      z.classList.toggle('no', !!r && result.correct !== L);
    });
    labels.forEach((el) => {
      const L = el.dataset.z;
      el.classList.toggle('on', q && count[L] > 0);
      el.classList.toggle('ok', !!r && result.correct === L);
      el.classList.toggle('no', !!r && result.correct !== L);
      el.querySelector('em').textContent = q && count[L] > 0 ? '👤 ' + count[L] : '';
    });
  }

  // ---- Ders kartlari ----
  function buildSubjects() {
    $subjects.innerHTML = '';
    subjects.forEach((s) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'scard'; b.dataset.id = s.id;
      b.innerHTML = '<span class="sicon"></span><span class="sname"></span>';
      b.querySelector('.sicon').textContent = s.icon;
      b.querySelector('.sname').textContent = s.name;
      b.addEventListener('click', () => { picking = false; socket.emit('subject:select', s.id); ui(); });
      $subjects.appendChild(b);
    });
  }

  function startBar() { // sure cubugu: kalan sure boyunca soldan sagdan eriyen cizgi
    const key = phase + ':' + round;
    if (key === barKey) return;
    barKey = key;
    $qbar.style.transition = 'none'; $qbar.style.width = '100%';
    if (phase !== 'question') return;
    void $qbar.offsetWidth;
    const ms = Math.max(0, deadline - performance.now());
    $qbar.style.transition = `width ${ms}ms linear`; $qbar.style.width = '0%';
  }

  // ---- Arayuz (sunucu durumuna gore) ----
  function ui() {
    $stage.dataset.phase = phase;
    const alive = players.filter((p) => p.alive && !p.waiting).length;
    $counter.textContent = `OYUNCULAR: ${players.length}/${MAX}` + (phase !== 'lobby' && phase !== 'winner' ? ` · HAYATTA: ${alive}` : '');

    const subjText = subject ? subject.icon + ' ' + subject.name : '';
    $chip.textContent = subjText;
    $chip.classList.toggle('hidden', !subject || phase === 'lobby');

    // Soru karti
    $qmeta.textContent = subject ? `${subject.name} • SORU ${round}` : '';
    let text = '';
    if (phase === 'question' && question) text = question.text;
    else if (phase === 'result' && result && question) text = `Doğru cevap: ${result.correct} — ${question.options[result.correct]}`;
    else if (phase === 'winner') text = 'OYUN BİTTİ';
    $qtext.textContent = text;
    $qtext.className = 'qtext' + (text.length > 110 ? ' xl' : text.length > 60 ? ' long' : '') + (phase === 'result' ? ' good' : '');
    $timer.classList.toggle('hidden', phase !== 'question');
    startBar();

    // Lobi karti
    $lobbySubject.textContent = subject ? subjText : 'Ders seçilmedi';
    $lobbyCount.textContent = `OYUNCULAR ${players.length}/${MAX}`;
    const names = players.map((p) => p.name + '|' + p.color).join('\n');
    if ($chips.dataset.k !== names) {
      $chips.dataset.k = names;
      $chips.innerHTML = '';
      players.forEach((p) => {
        const s = document.createElement('span');
        s.className = 'pchip'; s.style.setProperty('--c', p.color);
        s.textContent = p.name;
        $chips.appendChild(s);
      });
      if (!players.length) $chips.innerHTML = '<span class="empty">QR kodu okutan oyuncular burada görünür.</span>';
    }
    const canStart = !!subject && players.length > 0;
    $start.disabled = !canStart;
    $start.textContent = !subject ? 'ÖNCE DERS SEÇ' : players.length ? 'OYUNU BAŞLAT' : 'OYUNCU BEKLENİYOR';

    // Ders secici (yalnizca lobide)
    $picker.classList.toggle('hidden', !(phase === 'lobby' && (!subject || picking)));
    $subjects.querySelectorAll('.scard').forEach((b) => b.classList.toggle('sel', !!subject && b.dataset.id === subject.id));

    zoneState();
    chars.forEach((c, id) => {
      const r = phase === 'result' && result ? result.per[id] : null;
      c.el.classList.toggle('good', r === 'correct');
      c.el.classList.toggle('bad', r === 'wrong');
      c.pop.textContent = r === 'correct' ? '+100' : r === 'wrong' ? '−1 ❤️' : '';
      paint(c);
    });

    // Cevap bolgesi yazilari
    labels.forEach((el, i) => {
      const t = question && phase !== 'lobby' ? question.options[LETTERS[i]] : '';
      const sp = el.querySelector('span');
      sp.textContent = t;
      sp.className = t.length > 40 ? 'xl' : t.length > 18 ? 'long' : '';
    });

    // Siralama (ilk 3) - yalnizca oyun sirasinda
    const showLb = phase === 'question' || phase === 'result';
    $lb.classList.toggle('hidden', !showLb);
    if (showLb) {
      const top = players.filter((p) => !p.waiting).sort((a, b) => (b.alive - a.alive) || b.score - a.score || b.lives - a.lives).slice(0, 3);
      const k = top.map((p) => p.name + p.score + p.lives).join('|');
      if (k !== lbKey) {
        lbKey = k;
        $lb.innerHTML = '<b>SIRALAMA</b>';
        top.forEach((p, i) => {
          const r = document.createElement('div');
          r.className = 'lbrow'; r.style.setProperty('--c', p.color);
          r.textContent = `${i + 1}. ${p.name} · ${p.score} · ` + (p.alive ? '❤️'.repeat(Math.max(0, p.lives)) : '✖');
          $lb.appendChild(r);
        });
      }
    }

    $winBox.classList.toggle('hidden', !(phase === 'winner' && winner));
    if (phase === 'winner' && winner && !confettiOn) {
      confettiOn = true;
      const cols = ['#f87171', '#60a5fa', '#fbbf24', '#c084fc', '#34d399'];
      $conf.innerHTML = '';
      for (let i = 0; i < 28; i++) {
        const c = document.createElement('i');
        c.style.left = (Math.random() * 100).toFixed(1) + '%';
        c.style.background = cols[i % cols.length];
        c.style.animationDelay = (Math.random() * 1.5).toFixed(2) + 's';
        c.style.animationDuration = (2.2 + Math.random() * 1.6).toFixed(2) + 's';
        $conf.appendChild(c);
      }
    } else if (phase !== 'winner') { confettiOn = false; }
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
    $timer.style.setProperty('--p', Math.max(0, Math.min(100, (deadline - performance.now()) / totalMs * 100)).toFixed(1));
  }, 200);

  $start.addEventListener('click', () => socket.emit('game:start'));
  $change.addEventListener('click', () => { picking = true; ui(); });
  $picker.addEventListener('click', (e) => { if (e.target === $picker && subject) { picking = false; ui(); } });
  $reset.addEventListener('click', () => socket.emit('game:reset'));

  socket.on('connect', () => {
    setStatus('● SUNUCU BAĞLI', true);
    socket.emit('board:join'); // yeniden baglanmada da tekrar katil
  });
  socket.on('disconnect', () => setStatus('● BAĞLANTI BEKLENİYOR', false));
  socket.on('connect_error', () => setStatus('● BAĞLANTI BEKLENİYOR', false));

  socket.on('subjects:list', (list) => { subjects = list || []; buildSubjects(); ui(); });
  socket.on('players:update', (list) => { players = list; syncChars(list); ui(); });
  socket.on('state:update', (list) => {
    let zc = false;
    list.forEach(([id, x, y, z]) => {
      const c = chars.get(id);
      if (c) { c.tx = x; c.ty = y; if ((z || '') !== c.zone) { c.zone = z || ''; zc = true; } }
    });
    if (zc) zoneState();
  });
  socket.on('game:state', (s) => {
    phase = s.phase; question = s.question || null; result = s.result || null; winner = s.winner || null;
    subject = s.subject || null; round = s.round || 0;
    deadline = performance.now() + (s.endsIn || 0);
    if (phase === 'question') totalMs = Math.max(1000, s.endsIn || 15000);
    ui();
  });
  socket.on('player:find', (d) => { if (d) pulse(d.id, 3000); });
  socket.on('player:joined', (d) => { if (d) setTimeout(() => pulse(d.id, 1800), 150); });

  $panel.addEventListener('click', () => $panel.classList.toggle('big')); // QR'a dokun: buyut/kucult

  new ResizeObserver(measure).observe($world);
  measure();
  requestAnimationFrame(frame);
})();

// QR katilim paneli - Socket.IO kodundan bagimsiz
(() => {
  const $qrBox = document.getElementById('qrBox'), $qrBox2 = document.getElementById('qrBox2');
  const $joinUrl = document.getElementById('joinUrl');
  let lastUrl = '';

  async function loadJoinInfo() {
    try {
      const res = await fetch('/api/join-info', { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok) {
        lastUrl = '';
        $qrBox.textContent = $qrBox2.textContent = data.error || 'QR kod oluşturulamadı.';
        $joinUrl.textContent = '';
        return;
      }
      if (data.url !== lastUrl) { // sadece adres degisince yeniden ciz
        lastUrl = data.url;
        $qrBox.innerHTML = data.svg; // svg sunucuda yerel uretilir
        $qrBox2.innerHTML = data.svg;
        $joinUrl.textContent = data.url;
      }
    } catch (e) { /* sonraki denemede tekrar dene */ }
  }

  loadJoinInfo();
  setInterval(loadJoinInfo, 10000);
})();
