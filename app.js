/* Natural 21 - application: table UI, game flow, coach, count tracker, online tables */
(function () {
  'use strict';

  const N = window.Natural;
  const { cardSVG, backSVG, chipSVG, rackChip, icon, BACKS } = window.NaturalArt;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v) => Number(v || 0).toLocaleString('en-US');
  const signed = (v) => (v > 0 ? '+' : v < 0 ? '-' : '') + fmt(Math.abs(v));
  const UP_NAME = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'ace' };
  const ACTION_NAME = { hit: 'Hit', stand: 'Stand', double: 'Double down', split: 'Split', surrender: 'Surrender' };
  const CHIPS = [5, 25, 100, 500, 1000];

  /* ---------------- Storage ---------------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('natural.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('natural.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem('natural.' + k); } catch (e) { /* ignore */ } }
  };
  const DEFAULTS = { ui: 'dark', felt: 'teal', back: 'coral', four: false, sound: true, fast: false, alerts: true, showCount: false, name: '' };
  const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);
  const FELTS = [{ id: 'teal', c: '#17645d' }, { id: 'green', c: '#1f6e3f' }, { id: 'navy', c: '#1d4068' }, { id: 'wine', c: '#6e2433' }, { id: 'graphite', c: '#3c424d' }];
  const START_BANK = 1000;

  function applyTheme() {
    document.documentElement.dataset.theme = settings.ui;
    document.documentElement.dataset.felt = settings.felt;
    const btn = $('#navTheme');
    if (btn) btn.innerHTML = icon(settings.ui === 'dark' ? 'sun' : 'moon');
    const meta = $('meta[name=theme-color]');
    if (meta) meta.content = settings.ui === 'dark' ? '#0e1014' : '#f4f5f7';
  }
  function fillIcons(root) {
    $$('[data-icon]', root).forEach((el) => { if (el.dataset.iconDone) return; el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)); el.dataset.iconDone = '1'; });
  }

  /* ---------------- Sound ---------------- */
  const Sound = {
    ctx: null,
    tone(freq, start, dur, type, gain) {
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, c.currentTime + start);
      g.gain.exponentialRampToValueAtTime(gain || 0.14, c.currentTime + start + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
      o.connect(g); g.connect(c.destination);
      o.start(c.currentTime + start); o.stop(c.currentTime + start + dur + 0.02);
    },
    play(kind, n) {
      if (!settings.sound) return;
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
        if (kind === 'chip') { this.tone(2200, 0, 0.04, 'triangle', 0.08); this.tone(1700, 0.035, 0.05, 'triangle', 0.07); }
        else if (kind === 'deal') { for (let i = 0; i < Math.min(n || 1, 8); i++) this.tone(1300 - i * 30, i * 0.16, 0.03, 'square', 0.025); }
        else if (kind === 'win') { [523, 659, 784].forEach((f, i) => this.tone(f, i * 0.08, 0.25, 'sine', 0.1)); }
        else if (kind === 'bj') { [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, i * 0.07, 0.3, 'triangle', 0.09)); }
        else if (kind === 'lose') { this.tone(220, 0, 0.18, 'sine', 0.1); this.tone(165, 0.12, 0.25, 'sine', 0.09); }
        else if (kind === 'push') { this.tone(440, 0, 0.12, 'sine', 0.08); }
        else if (kind === 'shuffle') { for (let i = 0; i < 14; i++) this.tone(900 + Math.random() * 900, i * 0.03, 0.02, 'square', 0.015); }
        else if (kind === 'turn') { this.tone(660, 0, 0.08, 'sine', 0.1); this.tone(880, 0.07, 0.1, 'sine', 0.08); }
      } catch (e) { /* no audio */ }
    }
  };
  function toast(msg, ms) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), ms || 2600);
  }

  /* ---------------- Game state ---------------- */
  let G = null;
  let seen = new Set();
  let timers = { next: null, clock: null };
  const isHost = () => G && (G.mode !== 'online' || Net.role === 'host');
  const blankStats = () => ({ hands: 0, wins: 0, losses: 0, pushes: 0, bj: 0, net: 0, biggest: 0, decisions: 0, correct: 0, streak: 0, best: 0 });

  function startGame(cfg, resume) {
    clearTimers();
    seen = new Set();
    if (resume) { G = resume; G.token = (G.token || 0) + 1; }
    else {
      const bank = cfg.mode === 'solo' ? store.get('bank', START_BANK) : cfg.bank;
      const table = N.createTable(cfg.rules, cfg.players, bank);
      if (cfg.mode === 'solo') table.seats[0].bets = new Array(cfg.hands || 1).fill(0);
      G = { cfg, mode: cfg.mode, table, mySeat: cfg.mySeat || 0, sel: { seat: 0, spot: 0 }, stats: cfg.players.map(blankStats), history: [], hintsUsed: {}, hint: null, token: 1, deadline: 0, ready: {}, away: {}, statSeat: 0 };
      G.table.seats.forEach((s) => { s.lastBets = s.bets.map(() => 0); });
    }
    $('#chatTab').classList.toggle('hidden', G.mode !== 'online');
    switchTab('points');
    showView('game');
    renderAll();
    if (isHost()) pump();
  }
  function clearTimers() { clearTimeout(timers.next); clearInterval(timers.clock); timers = { next: null, clock: null }; }

  // Seats this device controls
  function mine(i) {
    if (!G) return false;
    if (G.mode === 'online') return i === G.mySeat;
    return G.table.seats[i].kind === 'human';
  }

  function afterChange(prevLog) {
    const t = G.table;
    if (t.phase === 'done' && !G._settled) onRoundDone();
    if (t.phase !== 'done') G._settled = false;
    renderAll();
    broadcast();
    save();
    pump();
  }

  // Host-side driver: timers for online play and moving to the next round
  function pump() {
    clearInterval(timers.clock);
    if (!G || !isHost()) return;
    const t = G.table;
    const token = G.token;
    G.deadline = 0;
    if (t.phase === 'done') {
      clearTimeout(timers.next);
      timers.next = setTimeout(() => {
        if (!G || G.token !== token || G.table.phase !== 'done') return;
        N.nextRound(G.table); G.ready = {};
        G.table.seats.forEach((s, i) => { if (s.bank < G.table.rules.minBet && !s.out && N.totalBet(s) === 0) { /* broke */ } });
        afterChange();
      }, settings.fast ? 900 : 1800);
      return;
    }
    if (G.mode !== 'online') return;
    let secs = 0, onExpire = null;
    if (t.phase === 'betting') {
      const active = t.seats.filter((s, i) => !s.out && !G.away[i]);
      if (!active.length) return;
      secs = G.cfg.betTimer || 15;
      onExpire = () => { if (N.canDeal(G.table)) hostDeal(); else pump(); };
    } else if (t.phase === 'insurance') {
      secs = 10;
      onExpire = () => { G.table.seats.forEach((s, i) => { if (!s.insDecided) N.insure(G.table, i, false); }); afterChange(); };
    } else if (t.phase === 'playing' && t.turn) {
      const i = t.turn.seat;
      secs = G.away[i] ? 4 : (G.cfg.shot || 20);
      onExpire = () => { if (G.table.turn && G.table.turn.seat === i) { toast(`${G.table.seats[i].name} ran out of time and stands`); N.act(G.table, 'stand'); afterChange(); } };
    }
    if (!secs) return;
    G.deadline = Date.now() + secs * 1000;
    broadcast();
    timers.clock = setInterval(() => {
      if (!G || G.token !== token) { clearInterval(timers.clock); return; }
      updateTimers();
      if (Date.now() >= G.deadline) { clearInterval(timers.clock); onExpire(); }
    }, 250);
  }

  function hostDeal() {
    const t = G.table;
    // Online: seats that did not bet sit this round out
    const res = N.deal(t);
    if (!res.ok) { toast(res.error); return; }
    G.hint = null; G.ready = {};
    if (t.log.some((e) => e.e === 'shuffle')) { Sound.play('shuffle'); toast('Fresh shoe: the cards were shuffled'); }
    afterChange();
  }

  function onRoundDone() {
    G._settled = true;
    const t = G.table;
    const lines = [`Round ${t.round}. Dealer ${dealerText(t)}.`];
    let myNet = 0, anyBJ = false, anyWin = false;
    t.seats.forEach((s, i) => {
      if (!s.hands.length) return;
      const st = G.stats[i];
      let net = 0;
      s.hands.forEach((h, k) => {
        st.hands++;
        const ev = t.log.find((e) => e.e === 'result' && e.seat === i && e.hand === k);
        const amt = ev ? ev.amount : 0;
        net += amt;
        if (h.result === 'win' || h.result === 'blackjack' || h.result === 'even') st.wins++;
        else if (h.result === 'push') st.pushes++;
        else st.losses++;
        if (h.result === 'blackjack') { st.bj++; anyBJ = anyBJ || mine(i); }
        if (amt > 0 && mine(i)) anyWin = true;
        lines.push(`${s.name}: ${handDesc(h)}, ${resultWord(h.result)} (${signed(amt)})`);
      });
      for (const e of t.log) if (e.seat === i && e.e === 'insPaid') net += e.amount;
      for (const e of t.log) if (e.seat === i && e.e === 'insLost') net -= e.amount;
      st.net += net;
      st.biggest = Math.max(st.biggest, net);
      if (mine(i)) myNet += net;
    });
    G.history.push(lines);
    if (G.history.length > 40) G.history.shift();
    if (G.mode === 'solo') store.set('bank', t.seats[0].bank);
    setTimeout(() => Sound.play(anyBJ ? 'bj' : myNet > 0 || anyWin ? 'win' : myNet < 0 ? 'lose' : 'push'), 400);
  }
  const resultWord = (r) => ({ win: 'win', lose: 'lose', push: 'push', bust: 'bust', blackjack: 'blackjack', surrender: 'surrender', even: 'even money' }[r] || r);
  function handDesc(h) {
    if (N.isBlackjack(h)) return 'blackjack';
    const t = N.total(h.cards);
    return `${t.soft && t.total < 21 ? 'soft ' : ''}${t.total}${h.doubled ? ' doubled' : ''}`;
  }
  function dealerText(t) {
    const d = N.total(t.dealer.cards.filter((c) => c >= 0));
    if (t.dealer.cards.length === 2 && d.total === 21 && !t.dealer.hidden) return 'has blackjack';
    return d.total > 21 ? `busts with ${d.total}` : `has ${d.total}`;
  }

  function save() {
    if (!G || G.mode === 'online') return;
    store.set('resume', { G, at: Date.now() });
  }

  /* ---------------- Player actions ---------------- */
  function recordDecision(i, chosen, best, label) {
    const st = G.stats[i];
    st.decisions++;
    if (chosen === best) { st.correct++; st.streak++; st.best = Math.max(st.best, st.streak); }
    else {
      st.streak = 0;
      if (settings.alerts && mine(i)) toast(`Basic strategy says ${label}`, 3200);
    }
  }

  function playerAct(action) {
    const t = G.table;
    if (t.phase !== 'playing' || !t.turn || !mine(t.turn.seat)) return;
    const i = t.turn.seat;
    const best = N.bestAction(t);
    if (best) recordDecision(i, action, best.action, `${ACTION_NAME[best.action].toLowerCase()} with ${best.soft ? 'soft ' : ''}${best.total} against a dealer ${UP_NAME[N.value(t.dealer.cards[0])]}`);
    if (G.mode === 'online' && Net.role === 'guest') { Net.send({ t: 'act', round: t.round, action }); G.table.turn = null; renderAll(); return; }
    const res = N.act(t, action);
    if (!res.ok) { toast(res.error); return; }
    G.hint = null;
    Sound.play(action === 'stand' ? 'chip' : 'deal');
    afterChange();
  }

  function insureAct(i, take) {
    const t = G.table;
    const tc = N.trueCount(t);
    recordDecision(i, take ? 'take' : 'decline', tc >= 3 ? 'take' : 'decline', tc >= 3 ? 'take insurance at a true count of +3 or more' : 'decline insurance');
    if (G.mode === 'online' && Net.role === 'guest') { Net.send({ t: 'ins', round: t.round, take }); t.seats[i].insDecided = true; renderAll(); return; }
    const res = N.insure(t, i, take);
    if (!res.ok) { toast(res.error); return; }
    if (take) Sound.play('chip');
    afterChange();
  }

  function addChip(v) {
    const t = G.table;
    if (t.phase === 'done') { N.nextRound(t); G.ready = {}; }
    if (t.phase !== 'betting') return;
    const { seat, spot } = G.sel;
    if (!mine(seat)) return;
    const s = t.seats[seat];
    const cur = s.bets[spot] || 0;
    const want = Math.min(cur + v, t.rules.maxBet);
    if (want === cur) { toast(`The table maximum is ${fmt(t.rules.maxBet)}`); return; }
    setBet(seat, spot, want);
  }
  function setBet(seat, spot, amount) {
    const t = G.table;
    if (G.mode === 'online' && Net.role === 'guest') {
      const s = t.seats[seat];
      const others = s.bets.reduce((a, b, k) => a + (k === spot ? 0 : b), 0);
      if (amount && (amount < t.rules.minBet && amount !== 0)) { /* allow building up to the minimum */ }
      if (others + amount > s.bank) { toast('Not enough chips'); return; }
      while (s.bets.length <= spot) s.bets.push(0);
      s.bets[spot] = amount;
      Net.send({ t: 'bet', spot, amount });
      Sound.play('chip'); renderAll();
      return;
    }
    const s = t.seats[seat];
    const others = s.bets.reduce((a, b, k) => a + (k === spot ? 0 : b), 0);
    if (others + amount > s.bank) { toast('Not enough chips'); return; }
    while (s.bets.length <= spot) s.bets.push(0);
    s.bets[spot] = amount; // below-minimum amounts are allowed while building a bet, and checked on deal
    Sound.play('chip');
    renderAll(); broadcast(); save();
  }
  function betsValid(t) {
    for (const s of t.seats) for (const b of s.bets) if (b && b < t.rules.minBet) return `Each bet must be at least ${t.rules.minBet}`;
    return null;
  }
  function pressDeal() {
    const t = G.table;
    if (t.phase === 'done') { N.nextRound(t); G.ready = {}; }
    if (t.phase !== 'betting') return;
    const err = betsValid(t);
    if (err) { toast(err); return; }
    if (G.mode === 'online') {
      if (Net.role === 'guest') { Net.send({ t: 'ready' }); G.ready[G.mySeat] = true; renderAll(); return; }
      G.ready[0] = true;
      maybeAllReady();
      renderAll();
      return;
    }
    if (!N.canDeal(t)) { toast('Place a bet first'); return; }
    hostDeal();
  }
  // Online: deal as soon as every connected player has pressed ready and at least one bet is down
  function maybeAllReady() {
    const t = G.table;
    const everyone = t.seats.every((s, i) => s.out || G.away[i] || G.ready[i]);
    if (everyone && N.canDeal(t)) hostDeal();
    else broadcast();
  }
  function rebet(mult) {
    const t = G.table;
    if (t.phase === 'done') { N.nextRound(t); G.ready = {}; }
    if (t.phase !== 'betting') return;
    const i = G.sel.seat;
    if (!mine(i)) return;
    const s = t.seats[i];
    const want = s.lastBets.map((b) => Math.min(t.rules.maxBet, b * mult));
    if (want.reduce((a, b) => a + b, 0) > s.bank) { toast('Not enough chips for that bet'); return; }
    want.forEach((b, k) => setBet(i, k, b));
  }
  function clearBets() {
    const t = G.table;
    if (t.phase === 'done') { N.nextRound(t); G.ready = {}; }
    if (t.phase !== 'betting') return;
    const i = G.sel.seat;
    if (!mine(i)) return;
    t.seats[i].bets.forEach((b, k) => setBet(i, k, 0));
  }

  /* ---------------- Rendering ---------------- */
  let dealBatch = 0;
  function cardEl(c, key) {
    const el = document.createElement('div');
    el.className = 'bjcard';
    const k = key + ':' + c;
    if (!seen.has(k)) {
      seen.add(k);
      el.classList.add('new');
      el.style.animationDelay = (dealBatch++ * (settings.fast ? 0.07 : 0.13)) + 's';
    }
    el.innerHTML = c < 0 ? backSVG(settings.back) : cardSVG(N.cardCode(c), settings.four);
    return el;
  }

  function spotPos(n, k) {
    const mobile = window.matchMedia('(max-width: 640px)').matches;
    if (n === 1) return { x: 50, y: mobile ? 68 : 70 };
    const x0 = mobile ? 20 : 16, x1 = 100 - x0;
    const x = x0 + (k * (x1 - x0)) / (n - 1);
    const y = (mobile ? 62 : 58) + (mobile ? 14 : 16) * Math.sin((Math.PI * (x - x0 + 6)) / (x1 - x0 + 12));
    return { x, y };
  }

  function renderTable() {
    const t = G.table;
    dealBatch = 0;
    // Felt print follows the rules
    $('#printPay').textContent = `BLACKJACK PAYS ${t.rules.bj === 1.5 ? '3 TO 2' : '6 TO 5'}`;
    $('#printRule').textContent = t.rules.h17 ? 'DEALER HITS SOFT 17' : 'DEALER MUST STAND ON ALL 17s';
    // Dealer
    const dc = $('#dealerCards'); dc.innerHTML = '';
    const showHole = !t.dealer.hidden;
    t.dealer.cards.forEach((c, k) => dc.appendChild(cardEl(k === 1 && !showHole ? -1 : c, 'd' + t.round + '-' + k + (k === 1 && showHole ? 'u' : ''))));
    const dt = $('#dealerTotal');
    if (t.dealer.cards.length) {
      const vis = t.dealer.cards.filter((c, k) => c >= 0 && (k !== 1 || showHole));
      const d = N.total(vis);
      dt.classList.remove('hidden');
      dt.className = 'badge' + (d.total > 21 ? ' bust' : '');
      dt.textContent = showHole && t.dealer.cards.length === 2 && d.total === 21 ? 'BJ' : d.total;
    } else dt.classList.add('hidden');
    const dealerCardsBatch = dealBatch;
    // Shoe
    const left = t.shoeLeft != null ? t.shoeLeft : t.shoe.length;
    const pct = Math.max(0, Math.min(1, left / t.shoeSize));
    $('#shoe').innerHTML = `<svg viewBox="0 0 70 60"><path d="M6 14 L52 8 L64 52 L12 56 Z" fill="rgba(0,0,0,.45)" stroke="rgba(255,255,255,.3)" stroke-width="1.5"/>
      <rect x="16" y="${50 - 34 * pct}" width="34" height="${34 * pct}" rx="2" fill="#fff" opacity=".85" transform="rotate(-7 33 33)"/>
      <rect x="16" y="${50 - 34 * (t.cut / t.shoeSize)}" width="34" height="2.5" fill="#ff7a6b" transform="rotate(-7 33 33)"/></svg><small>${left} cards</small>`;
    // Count chip
    const cc = $('#countChip');
    cc.classList.toggle('hidden', !settings.showCount);
    if (settings.showCount) cc.innerHTML = `Running <b>${signed(t.count.running) || '0'}</b><br>True <b>${tcText(t)}</b>`;
    // Seats
    const box = $('#spots'); box.innerHTML = '';
    const n = t.seats.length;
    t.seats.forEach((s, i) => {
      const pos = spotPos(n, i);
      const el = document.createElement('div');
      const isTurn = t.turn && t.turn.seat === i && t.phase === 'playing';
      const deciding = t.phase === 'insurance' && !s.insDecided && s.hands.length;
      el.className = 'spot' + (isTurn || deciding ? ' turn' : '') + (!s.hands.length && t.phase !== 'betting' ? ' idle' : '');
      el.style.left = pos.x + '%'; el.style.top = pos.y + '%';
      // Hands
      const hands = document.createElement('div'); hands.className = 'hands';
      s.hands.forEach((h, k) => {
        const he = document.createElement('div');
        he.className = 'hand' + (s.hands.length > 2 ? ' small' : '') + (isTurn && t.turn.hand === k ? ' active' : '');
        const row = document.createElement('div'); row.className = 'cards-row';
        h.cards.forEach((c, j) => row.appendChild(cardEl(c, `s${t.round}-${i}-${k}-${j}`)));
        const meta = document.createElement('div'); meta.className = 'meta';
        const tt = N.total(h.cards);
        const bj = N.isBlackjack(h);
        meta.innerHTML = `<span class="badge ${tt.total > 21 ? 'bust' : bj ? 'bj' : ''}">${bj ? 'BJ' : (tt.soft && tt.total < 21 ? tt.total - 10 + '/' : '') + tt.total}</span>`;
        if (h.result && (t.phase === 'done' || h.result === 'bust' || h.result === 'blackjack' || h.result === 'surrender' || h.result === 'even')) {
          meta.insertAdjacentHTML('beforeend', `<span class="result-tag ${h.result}" style="animation:pop .2s ease ${(dealBatch * (settings.fast ? 0.07 : 0.13)).toFixed(2)}s backwards">${esc(resultWord(h.result))}</span>`);
        }
        he.appendChild(row); he.appendChild(meta);
        hands.appendChild(he);
      });
      el.appendChild(hands);
      // Bet circles (one per spot)
      const circles = document.createElement('div'); circles.className = 'bet-circles';
      const spots = t.phase === 'betting' ? s.bets.map((b, k) => ({ b, k })) : s.hands.length ? groupBets(s) : s.bets.map((b, k) => ({ b, k }));
      spots.forEach(({ b, k }) => {
        const c = document.createElement('button');
        c.className = 'bet-circle' + (b ? ' has' : '') + (t.phase === 'betting' && G.sel.seat === i && G.sel.spot === k && mine(i) ? ' sel' : '');
        c.type = 'button';
        c.setAttribute('aria-label', `${s.name} betting spot ${k + 1}${b ? ', bet ' + b : ''}`);
        c.innerHTML = (b ? chipSVG(b) : '') + (b ? `<span class="amt">${fmt(b)}</span>` : '');
        c.onclick = () => { if (mine(i)) { G.sel = { seat: i, spot: k }; G.statSeat = i; renderAll(); } };
        circles.appendChild(c);
      });
      el.appendChild(circles);
      const plate = document.createElement('div'); plate.className = 'plate';
      let tag = '';
      if (G.mode === 'online') tag = i === G.mySeat ? '<span class="tagx">You</span>' : `<span class="live ${G.awayView && G.awayView[i] ? 'off' : ''}"></span>`;
      if (G.mode === 'online' && t.phase === 'betting' && (G.readyView || G.ready)[i]) tag += '<span class="tagx">Ready</span>';
      plate.innerHTML = `<div class="nm">${esc(s.name)}${tag}</div><div class="bk">${fmt(s.bank)}</div>${(isTurn || deciding || (t.phase === 'betting' && G.mode === 'online')) && G.deadline ? '<div class="timer"><i></i></div>' : ''}`;
      el.appendChild(plate);
      box.appendChild(el);
    });
    updateTimers();
    const fresh = dealBatch;
    if (fresh > 0 && fresh !== dealerCardsBatch) Sound.play('deal', fresh);
    else if (fresh > 0) Sound.play('deal', fresh);
  }
  function groupBets(s) {
    // During a round show the bet riding on each original spot
    const by = {};
    s.hands.forEach((h) => { by[h.spot] = (by[h.spot] || 0) + h.bet; });
    return Object.keys(by).map((k) => ({ b: by[k], k: +k }));
  }
  function tcText(t) { const v = N.trueCount(t); return (v > 0 ? '+' : '') + v.toFixed(1); }

  function updateTimers() {
    if (!G || !G.deadline) return;
    const t = G.table;
    const secs = t.phase === 'betting' ? (G.cfg.betTimer || 15) : t.phase === 'insurance' ? 10 : (G.cfg.shot || 20);
    const left = Math.max(0, G.deadline - Date.now());
    $$('.timer i').forEach((el) => { el.style.width = Math.min(100, (left / (secs * 1000)) * 100) + '%'; });
  }

  // The seat whose controls should show on this device
  function activeSeat() {
    const t = G.table;
    if (t.phase === 'playing' && t.turn && mine(t.turn.seat)) return t.turn.seat;
    if (t.phase === 'insurance') {
      const i = t.seats.findIndex((s, j) => s.hands.length && !s.insDecided && mine(j));
      return i;
    }
    if (t.phase === 'betting' || t.phase === 'done') return mine(G.sel.seat) ? G.sel.seat : -1;
    return -1;
  }

  function renderControls() {
    const t = G.table;
    const box = $('#controls');
    const i = activeSeat();
    let html = '';
    if ((t.phase === 'betting' || t.phase === 'done') && i >= 0) {
      const s = t.seats[i];
      const room = s.bank - (t.phase === 'betting' ? N.totalBet(s) : 0);
      const multi = G.mode === 'local' || s.bets.length > 1;
      html += `<div class="rack">${CHIPS.map((v) => `<button class="chipbtn" data-chip="${v}" ${v > Math.max(room, 0) || v > t.rules.maxBet ? 'disabled' : ''} aria-label="Add ${v}">${rackChip(v)}</button>`).join('')}</div>`;
      const last = s.lastBets.reduce((a, b) => a + b, 0);
      const readyMine = G.mode === 'online' && (G.readyView || G.ready)[i];
      html += `<div class="ctl-row">
        <button class="btn" data-c="clear">Clear</button>
        <button class="btn" data-c="rebet" ${!last || last > s.bank ? 'disabled' : ''}>Rebet ${last ? fmt(last) : ''}</button>
        <button class="btn" data-c="double" ${!last || last * 2 > s.bank ? 'disabled' : ''}>Double ${last ? fmt(last * 2) : ''}</button>
        <button class="btn primary" data-c="deal" ${readyMine ? 'disabled' : ''}>${G.mode === 'online' ? (readyMine ? 'Ready' : 'I am ready') : 'Deal'} <kbd>Enter</kbd></button></div>`;
      const note = G.mode === 'local' ? `Betting for ${esc(s.name)}. Tap a player's circle to bet for them. Bets ${fmt(t.rules.minBet)} to ${fmt(t.rules.maxBet)}.`
        : multi ? `Tap a betting circle to choose where chips go. Bets ${fmt(t.rules.minBet)} to ${fmt(t.rules.maxBet)}.` : `Table limits ${fmt(t.rules.minBet)} to ${fmt(t.rules.maxBet)}.`;
      html += `<div class="ctl-note">${s.bank < t.rules.minBet && N.totalBet(s) === 0 ? `${esc(s.name)} is out of chips. ${G.mode === 'solo' ? 'Use Reset chips to start again.' : ''}` : note}</div>`;
    } else if (t.phase === 'insurance' && i >= 0) {
      const s = t.seats[i];
      const allBJ = s.hands.length === 1 && N.isBlackjack(s.hands[0]);
      const cost = Math.floor(s.hands.reduce((a, h) => a + h.bet, 0) / 2);
      html += `<div class="ctl-note">${G.mode === 'local' ? esc(s.name) + ': ' : ''}The dealer shows an ace. ${allBJ ? 'You have blackjack. Take even money (paid 1 to 1 now) or play on for 3 to 2?' : `Insurance costs ${fmt(cost)} and pays 2 to 1 if the dealer has blackjack.`}</div>
        <div class="ctl-row"><button class="btn" data-c="noins">${allBJ ? 'No thanks' : 'No insurance'}</button><button class="btn primary" data-c="ins" ${!allBJ && cost > s.bank ? 'disabled' : ''}>${allBJ ? 'Even money' : `Insure ${fmt(cost)}`}</button></div>`;
    } else if (t.phase === 'playing' && i >= 0) {
      const L = N.legal(t);
      const sugg = G.hint && G.hint.kind === 'play' ? G.hint.action : null;
      const b = (a, key, label) => `<button class="btn ${a === 'hit' ? 'primary' : ''} ${sugg === a ? 'suggest' : ''}" data-c="${a}" ${L && L[a] ? '' : 'disabled'}>${label} <kbd>${key}</kbd></button>`;
      const h = N.current(t);
      html += `<div class="ctl-note">${G.mode === 'local' ? esc(t.seats[i].name) + ', ' : ''}${t.seats[i].hands.length > 1 ? `hand ${t.turn.hand + 1} of ${t.seats[i].hands.length}: ` : ''}${handDesc(h)}</div>
        <div class="ctl-row">${b('hit', 'H', 'Hit')}${b('stand', 'S', 'Stand')}${b('double', 'D', 'Double')}${b('split', 'P', 'Split')}${t.rules.surrender ? b('surrender', 'R', 'Surrender') : ''}</div>`;
    } else {
      let msg = '';
      if (t.phase === 'playing' && t.turn) msg = `Waiting for ${t.seats[t.turn.seat].name}.`;
      else if (t.phase === 'insurance') msg = 'Waiting for insurance decisions.';
      else if (t.phase === 'dealer') msg = 'Dealer is playing.';
      else if (t.phase === 'betting') msg = G.mode === 'online' ? 'Waiting for bets.' : '';
      html = `<div class="ctl-note">${esc(msg)}</div>`;
    }
    box.innerHTML = html;
  }
  $('#controls').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-chip]');
    if (chip) { addChip(+chip.dataset.chip); return; }
    const b = e.target.closest('[data-c]');
    if (!b || b.disabled) return;
    const c = b.dataset.c;
    const t = G.table;
    if (c === 'clear') clearBets();
    else if (c === 'rebet') rebet(1);
    else if (c === 'double') rebet(2);
    else if (c === 'deal') pressDeal();
    else if (c === 'ins' || c === 'noins') { const i = activeSeat(); if (i >= 0) insureAct(i, c === 'ins'); }
    else if (['hit', 'stand', 'double', 'split', 'surrender'].includes(c) && t.phase === 'playing') playerAct(c);
  });

  function renderStatus() {
    const t = G.table;
    let main = '', sub = '';
    const r = t.rules;
    if (t.phase === 'betting') main = G.mode === 'online' ? 'Place your bets' : 'Place your bet';
    else if (t.phase === 'insurance') main = 'Insurance?';
    else if (t.phase === 'playing' && t.turn) main = mine(t.turn.seat) ? (G.mode === 'local' ? `${t.seats[t.turn.seat].name}, your move` : 'Your move') : `${t.seats[t.turn.seat].name} is playing`;
    else if (t.phase === 'dealer') main = 'Dealer plays';
    else if (t.phase === 'done') main = `Dealer ${dealerText(t)}`;
    sub = `${r.decks} ${r.decks === 1 ? 'deck' : 'decks'}, dealer ${r.h17 ? 'hits' : 'stands on'} soft 17, blackjack pays ${r.bj === 1.5 ? '3 to 2' : '6 to 5'}${r.surrender ? ', late surrender' : ''}. Round ${t.round || 1}.`;
    $('#status').innerHTML = `<span class="turn-dot" style="background:var(--accent)"></span><div><span class="stxt">${esc(main)}</span><small>${esc(sub)}</small></div>`;
  }

  /* ---------------- Coach ---------------- */
  function adviceFor() {
    const t = G.table;
    const i = activeSeat();
    if (i < 0) return null;
    const up = t.dealer.cards[0];
    const upv = up != null ? N.value(up) : 0;
    const bustTable = t.rules.h17 ? N.DEALER_BUST.h17 : N.DEALER_BUST.s17;
    const tc = N.trueCount(t);
    if (t.phase === 'playing') {
      const best = N.bestAction(t);
      const h = N.current(t);
      const tot = N.total(h.cards);
      const reasons = [];
      const desc = `${tot.soft ? 'soft ' : ''}${tot.total}`;
      const pair = h.cards.length === 2 && N.rankOf(h.cards[0]) === N.rankOf(h.cards[1]);
      reasons.push(`Basic strategy for ${pair ? 'a pair of ' + (N.value(h.cards[0]) === 11 ? 'aces' : N.value(h.cards[0]) + 's') : desc} against a dealer ${UP_NAME[upv]}`);
      reasons.push(`A dealer showing ${UP_NAME[upv] === 'ace' ? 'an ace' : 'a ' + UP_NAME[upv]} busts about ${Math.round(bustTable[upv] * 100)}% of the time`);
      const a = best.action;
      if (a === 'split' && (N.value(h.cards[0]) === 11 || N.value(h.cards[0]) === 8)) reasons.push('Always split aces and eights');
      else if (a === 'split') reasons.push('Two hands start stronger than this total against that card');
      if (a === 'double' && tot.total === 11) reasons.push('11 is the best total to double: any ten makes 21');
      else if (a === 'double') reasons.push('Good chance to finish strong with one card while the dealer is weak');
      if (a === 'stand' && tot.total >= 12 && tot.total <= 16 && upv <= 6) reasons.push('Let the dealer take the risk of busting');
      if (a === 'hit' && !tot.soft && tot.total >= 12 && tot.total <= 16 && upv >= 7) reasons.push('The dealer will often reach 17 or more, so standing on this total usually loses');
      if (a === 'hit' && tot.soft) reasons.push('A soft hand cannot bust with one more card');
      if (a === 'surrender') reasons.push('This hand loses well over half the time. Surrendering gets half your bet back');
      if (!tot.soft && tot.total >= 12) reasons.push(`If you hit, the next card busts you ${Math.round(N.bustChance(t, h.cards) * 100)}% of the time, counting cards left in the shoe`);
      return { kind: 'play', seat: i, action: a, label: ACTION_NAME[a], reasons };
    }
    if (t.phase === 'insurance') {
      const s = t.seats[i];
      const allBJ = s.hands.length === 1 && N.isBlackjack(s.hands[0]);
      const take = tc >= 3;
      return {
        kind: 'ins', seat: i, label: take ? (allBJ ? 'Take even money' : 'Take insurance') : (allBJ ? 'Decline even money' : 'Decline insurance'),
        reasons: take ? [`The true count is ${tcText(t)}, so the shoe is rich in tens and insurance pays off`, 'Card counters insure at a true count of +3 or more']
          : ['Insurance pays 2 to 1, but the dealer has blackjack less than one time in three', `It only pays off when many tens are left. The true count is ${tcText(t)}`, allBJ ? 'Playing on wins 3 to 2 most of the time, which beats even money on average' : 'Over time, insurance loses about 7% of what you put in']
      };
    }
    if (t.phase === 'betting' || t.phase === 'done') {
      const reasons = [`The true count is ${tcText(t)}`];
      let label = 'Bet the minimum';
      if (tc >= 2) { label = 'Raise your bet'; reasons.push('A positive count means more tens and aces are left, which favours you', 'Card counters bet more as the true count rises'); }
      else reasons.push('At a neutral or negative count the house has the edge, so keep bets small', 'Never bet more than you are comfortable losing, even with play chips');
      return { kind: 'bet', seat: i, label, reasons };
    }
    return null;
  }

  function renderHint() {
    const body = $('#hintBody'), btn = $('#hintBtn');
    const i = activeSeat();
    const t = G.table;
    const used = i >= 0 ? (G.hintsUsed[i] || 0) : 0;
    $('#hintCount').textContent = G.cfg.hints === false ? 'Coach off' : `Hints used: ${used}`;
    btn.disabled = G.cfg.hints === false || i < 0 || t.phase === 'dealer';
    if (G.hint && G.hint.seat === i && G.hint.phase === t.phase + ':' + t.round + ':' + (t.turn ? t.turn.hand + ':' + N.current(t).cards.length : '')) {
      body.innerHTML = `<div class="best">${esc(G.hint.label)}</div><div class="reasons">${G.hint.reasons.map((r) => `<span class="reason">${esc(r)}</span>`).join('')}</div>`;
      btn.lastElementChild.textContent = 'Hide advice';
      return;
    }
    btn.lastElementChild.textContent = 'Ask the coach';
    const st = i >= 0 ? G.stats[i] : null;
    const acc = st && st.decisions ? ` Your strategy accuracy is ${Math.round((st.correct / st.decisions) * 100)}%.` : '';
    if (G.cfg.hints === false) body.textContent = 'The coach is turned off for this table.';
    else if (t.phase === 'playing' && i >= 0) body.textContent = 'Ask the coach for the basic strategy play and why it works.' + acc;
    else if (t.phase === 'insurance' && i >= 0) body.textContent = 'Not sure about insurance? Ask the coach.';
    else if (i >= 0) body.textContent = 'The coach can suggest a bet based on the count, and helps with every decision once the cards are dealt.' + acc;
    else body.textContent = 'Wait for your turn, then ask the coach.';
  }
  function toggleHint() {
    if (G.hint && G.hint.seat === activeSeat()) { G.hint = null; renderHint(); renderControls(); return; }
    const adv = adviceFor();
    if (!adv) return;
    const t = G.table;
    adv.phase = t.phase + ':' + t.round + ':' + (t.turn ? t.turn.hand + ':' + N.current(t).cards.length : '');
    G.hint = adv;
    G.hintsUsed[adv.seat] = (G.hintsUsed[adv.seat] || 0) + 1;
    renderHint(); renderControls();
  }

  /* ---------------- Side panels ---------------- */
  function renderPoints() {
    const t = G.table;
    const n = t.seats.length;
    if (G.statSeat >= n) G.statSeat = 0;
    const i = G.mode === 'online' ? (G.statSeat ?? G.mySeat) : G.statSeat;
    const s = t.seats[i], st = (G.statsView || G.stats)[i] || blankStats();
    const acc = st.decisions ? Math.round((st.correct / st.decisions) * 100) + '%' : '-';
    const tabs = n > 1 ? `<div class="who-row">${t.seats.map((x, j) => `<button data-who="${j}" class="${j === i ? 'on' : ''}">${esc(x.name)}</button>`).join('')}</div>` : '';
    $('#pointsPanel').innerHTML = `${tabs}<div class="stat-grid">
      <div><span>Chips</span><b>${fmt(s.bank)}</b></div>
      <div><span>Net this session</span><b class="${st.net > 0 ? 'up' : st.net < 0 ? 'down' : ''}">${signed(st.net) || '0'}</b></div>
      <div><span>Hands played</span><b>${st.hands}</b></div>
      <div><span>Won, lost, pushed</span><b>${st.wins}-${st.losses}-${st.pushes}</b></div>
      <div><span>Blackjacks</span><b>${st.bj}</b></div>
      <div><span>Biggest win</span><b>${fmt(st.biggest)}</b></div>
      <div><span>Strategy accuracy</span><b>${acc}</b></div>
      <div><span>Best streak</span><b>${st.best}</b></div></div>
      <p class="pt-note" style="margin-top:10px">Chips are your points. Strategy accuracy compares each of your decisions with basic strategy for these table rules.</p>`;
    $$('[data-who]', $('#pointsPanel')).forEach((b) => b.onclick = () => { G.statSeat = +b.dataset.who; renderPoints(); });
  }
  function renderCount() {
    const t = G.table;
    const left = t.shoeLeft != null ? t.shoeLeft : t.shoe.length;
    const dealt = t.shoeSize - left;
    $('#countPanel').innerHTML = `<div class="stat-grid">
      <div><span>Running count</span><b>${signed(t.count.running) || '0'}</b></div>
      <div><span>True count</span><b>${tcText(t)}</b></div>
      <div><span>Decks left</span><b>${(left / 52).toFixed(1)}</b></div>
      <div><span>Cards seen</span><b>${t.count.seen}</b></div></div>
      <div class="pen" title="How far into the shoe the dealer is. The marker is the cut card."><i style="width:${(dealt / t.shoeSize) * 100}%"></i><b style="left:${(1 - t.cut / t.shoeSize) * 100}%"></b></div>
      <p class="pt-note">${Math.round((dealt / t.shoeSize) * 100)}% of the shoe dealt. It is reshuffled at the cut card.</p>
      <div class="hilo"><div><b>+1</b>2 to 6</div><div><b>0</b>7 to 9</div><div><b>-1</b>10 to A</div></div>
      <p class="pt-note" style="margin-top:10px">Hi-Lo card counting: add each card's points as it is dealt for the running count, then divide by the decks left for the true count. A higher true count means more tens and aces remain, which helps the player.</p>
      <label class="toggle" style="border:0;padding-bottom:0"><span>Show the count on the table</span><span class="switch"><input type="checkbox" id="cShow" ${settings.showCount ? 'checked' : ''}><span></span></span></label>`;
    $('#cShow').onchange = (e) => { settings.showCount = e.target.checked; saveSettings(); renderTable(); };
  }
  function renderHistory() {
    const lines = [];
    for (const block of (G.historyView || G.history).slice(-15).reverse()) block.forEach((ln, k) => lines.push(k === 0 ? `<div class="h-sep">${esc(ln)}</div>` : `<div>${esc(ln)}</div>`));
    $('#histList').innerHTML = lines.join('') || '<div>No rounds yet.</div>';
  }
  function renderToolbar() {
    $('#resetBtn').disabled = G.mode !== 'solo';
  }
  function renderAll() {
    if (!G) return;
    renderStatus(); renderTable(); renderControls(); renderHint(); renderPoints(); renderCount(); renderHistory(); renderToolbar();
  }

  /* ---------------- Modals ---------------- */
  let modalHandler = null;
  function openModal(html, handler, wide) {
    const m = $('#modal');
    m.className = 'modal' + (wide ? ' wide' : '');
    m.innerHTML = html; fillIcons(m);
    modalHandler = handler;
    $('#modalBack').classList.remove('hidden');
  }
  function closeModal() { $('#modalBack').classList.add('hidden'); $('#modal').innerHTML = ''; modalHandler = null; }
  $('#modalBack').addEventListener('click', (e) => {
    if (e.target.id === 'modalBack' || e.target.closest('[data-close]')) { const h = modalHandler; closeModal(); if (h) h('close'); return; }
    const a = e.target.closest('[data-act]');
    if (a && modalHandler) modalHandler(a.dataset.act, a);
  });
  function confirmBox(title, text, okLabel, onOk, danger) {
    openModal(`<div class="m-head"><div><h3>${esc(title)}</h3><p>${esc(text)}</p></div></div>
      <div class="m-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(okLabel)}</button></div>`,
    (act) => { if (act === 'ok') { closeModal(); onOk(); } else if (act === 'cancel') closeModal(); });
  }
  function seg(name, items, value, big) {
    return `<div class="seg ${big ? 'big' : ''}" data-seg="${name}">${items.map((it) => `<button type="button" data-v="${it.id}" class="${String(it.id) === String(value) ? 'on' : ''}">${esc(it.label)}${big && it.sub ? `<small>${esc(it.sub)}</small>` : ''}</button>`).join('')}</div>`;
  }
  function wireSegs(root, state, onChange) {
    $$('[data-seg]', root).forEach((s) => s.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      $$('button', s).forEach((x) => x.classList.toggle('on', x === b));
      state[s.dataset.seg] = b.dataset.v;
      if (onChange) onChange(s.dataset.seg, b.dataset.v);
    }));
  }
  function toggleRow(id, label, sub, on) {
    return `<label class="toggle"><span>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span><span class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></span></label>`;
  }

  // Table rules picker shared by every setup screen
  const PRESET_ITEMS = Object.keys(N.PRESETS).map((k) => ({ id: k, label: N.PRESETS[k].name })).concat({ id: 'custom', label: 'Custom' });
  function rulesHTML(st) {
    const r = st.rules;
    return `<div class="field"><span class="lbl">Table rules</span>${seg('preset', PRESET_ITEMS, st.preset)}</div>
      <div id="customRules" class="${st.preset === 'custom' ? '' : 'hidden'}">
        <div class="field"><span class="lbl">Decks</span>${seg('decks', [1, 2, 6, 8].map((v) => ({ id: v, label: String(v) })), r.decks)}</div>
        <div class="field-row">
          <div class="field"><span class="lbl">Dealer soft 17</span>${seg('h17', [{ id: 0, label: 'Stands' }, { id: 1, label: 'Hits' }], r.h17 ? 1 : 0)}</div>
          <div class="field"><span class="lbl">Blackjack pays</span>${seg('bj', [{ id: 1.5, label: '3 to 2' }, { id: 1.2, label: '6 to 5' }], r.bj)}</div>
        </div>
        <div class="field"><span class="lbl">Double down on</span>${seg('double', [{ id: 'any', label: 'Any two cards' }, { id: '9-11', label: '9 to 11' }, { id: '10-11', label: '10 and 11' }], r.double)}</div>
        <div class="field"><span class="lbl">Split up to</span>${seg('maxHands', [2, 3, 4].map((v) => ({ id: v, label: v + ' hands' })), r.maxHands)}</div>
        <div class="field">
          ${toggleRow('rDas', 'Double after split', 'Allow doubling on a hand made by splitting', r.das)}
          ${toggleRow('rSur', 'Late surrender', 'Give up half your bet after the dealer checks for blackjack', r.surrender)}
          ${toggleRow('rRsa', 'Resplit aces', 'Split again if a split ace gets another ace', r.rsa)}
          ${toggleRow('rHsa', 'Hit split aces', 'Otherwise split aces get one card each', r.hsa)}
          ${toggleRow('rTens', 'Split any tens', 'Allow splitting two different ten-value cards, like K and Q', r.splitTens)}
        </div>
      </div>`;
  }
  function readRules(st) {
    if (st.preset !== 'custom') return Object.assign({}, N.PRESETS[st.preset]);
    const r = st.rules;
    return {
      name: 'Custom', decks: +r.decks, h17: !!+r.h17, bj: +r.bj, double: r.double, maxHands: +r.maxHands,
      das: $('#rDas').checked, surrender: $('#rSur').checked, rsa: $('#rRsa').checked, hsa: $('#rHsa').checked, splitTens: $('#rTens').checked,
      minBet: 5, maxBet: 500
    };
  }
  function wireRules(st) {
    return (key, val) => {
      if (key === 'preset') { $('#customRules').classList.toggle('hidden', val !== 'custom'); return; }
      if (['decks', 'h17', 'bj', 'double', 'maxHands'].includes(key)) st.rules[key] = val;
    };
  }

  function setupSolo() {
    const st = { preset: 'strip', hands: '1', rules: Object.assign({}, N.PRESETS.strip) };
    const bank = store.get('bank', START_BANK);
    openModal(`
      <div class="m-head"><div><h3>Solo vs Dealer</h3><p>You have ${fmt(bank)} chips saved on this device.</p></div><button class="m-close" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="field"><label for="nMe">Your name</label><input type="text" id="nMe" maxlength="16" placeholder="You" value="${esc(settings.name)}"></div>
      <div class="field"><span class="lbl">Hands each round</span>${seg('hands', [1, 2, 3].map((v) => ({ id: String(v), label: String(v) })), st.hands)}</div>
      ${rulesHTML(st)}
      <div class="field">${toggleRow('optHints', 'Allow the coach', 'Basic strategy advice on every decision', true)}</div>
      <div class="m-actions"><button class="btn primary block" data-act="start">${icon('play')}Sit down</button></div>`,
    (act) => {
      if (act !== 'start') return;
      const name = $('#nMe').value.trim(); settings.name = name; saveSettings();
      const rules = readRules(st);
      const hints = $('#optHints').checked;
      closeModal();
      startGame({ mode: 'solo', rules, hands: +st.hands, players: [{ name: name || 'You', kind: 'human' }], hints, mySeat: 0 });
    }, true);
    const onRule = wireRules(st);
    wireSegs($('#modal'), st, onRule);
  }

  function setupLocal() {
    const st = { players: '2', preset: 'strip', bank: '1000', rules: Object.assign({}, N.PRESETS.strip) };
    const names = () => Array.from({ length: +st.players }, (_, k) => `<div class="field"><label for="pn${k}">Player ${k + 1}</label><input type="text" id="pn${k}" maxlength="16" placeholder="Player ${k + 1}"></div>`).join('');
    openModal(`
      <div class="m-head"><div><h3>Pass &amp; Play</h3><p>Everyone plays against the same dealer. Each player has their own chips.</p></div><button class="m-close" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="field"><span class="lbl">Players</span>${seg('players', [2, 3, 4, 5].map((v) => ({ id: String(v), label: String(v) })), st.players)}</div>
      <div class="field-row" id="nameRows">${names()}</div>
      <div class="field"><span class="lbl">Starting chips</span>${seg('bank', [{ id: '500', label: '500' }, { id: '1000', label: '1,000' }, { id: '5000', label: '5,000' }], st.bank)}</div>
      ${rulesHTML(st)}
      <div class="field">${toggleRow('optHints', 'Allow the coach', 'Each player can ask for advice', true)}</div>
      <div class="m-actions"><button class="btn primary block" data-act="start">${icon('play')}Start</button></div>`,
    (act) => {
      if (act !== 'start') return;
      const players = Array.from({ length: +st.players }, (_, k) => ({ name: ($('#pn' + k).value.trim() || `Player ${k + 1}`).slice(0, 16), kind: 'human' }));
      const rules = readRules(st);
      const hints = $('#optHints').checked;
      closeModal();
      startGame({ mode: 'local', rules, bank: +st.bank, players, hints, mySeat: -1 });
    }, true);
    const onRule = wireRules(st);
    wireSegs($('#modal'), st, (k, v) => { if (k === 'players') $('#nameRows').innerHTML = names(); else onRule(k, v); });
  }

  /* ---------------- Online (PeerJS, host-authoritative) ---------------- */
  const PREFIX = 'natural21-v1-';
  const myToken = (() => { try { let t = sessionStorage.getItem('natural.token'); if (!t) { t = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('natural.token', t); } return t; } catch (e) { return Math.random().toString(36).slice(2, 10); } })();
  const Net = {
    peer: null, role: null, code: null, conns: new Map(), conn: null, connected: false, lobby: [], hostCfg: null,
    genCode() { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)]; return s; },
    close() {
      try { this.conns.forEach((c) => c.conn.close()); } catch (e) { /* ignore */ }
      try { if (this.conn) this.conn.close(); } catch (e) { /* ignore */ }
      try { if (this.peer) this.peer.destroy(); } catch (e) { /* ignore */ }
      this.peer = null; this.conn = null; this.conns = new Map(); this.connected = false; this.role = null; this.lobby = [];
    },
    host(cfg, onReady, tries) {
      this.close();
      this.role = 'host'; this.hostCfg = cfg;
      const code = this.genCode(); this.code = code;
      const peer = new window.Peer(PREFIX + code, { debug: 0 });
      this.peer = peer;
      this.lobby = [{ name: cfg.name, token: myToken, host: true }];
      peer.on('open', () => onReady(code));
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id' && (tries || 0) < 4) { this.host(cfg, onReady, (tries || 0) + 1); return; }
        if (err.type === 'peer-unavailable') return;
        toast('Connection problem: ' + (err.type || 'unknown'));
      });
      peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) { /* ignore */ } });
      peer.on('connection', (conn) => {
        conn.on('data', (msg) => hostOnData(conn, msg));
        conn.on('close', () => hostOnClose(conn));
        conn.on('error', () => {});
      });
    },
    join(code, name, onErr) {
      this.close();
      this.role = 'guest'; this.code = code; this.myName = name;
      const peer = new window.Peer({ debug: 0 });
      this.peer = peer;
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { onErr('Could not reach that table. Check the code and that the host still has it open.'); this.close(); } }, 15000);
      peer.on('open', () => { const conn = peer.connect(PREFIX + code, { reliable: true }); this.attachGuest(conn, () => { settled = true; clearTimeout(timer); }); });
      peer.on('error', (err) => {
        if (settled && err.type !== 'peer-unavailable') { toast('Connection problem: ' + err.type); return; }
        settled = true; clearTimeout(timer);
        onErr(err.type === 'peer-unavailable' ? 'Table not found. Check the code and try again.' : 'Could not connect (' + err.type + ').');
        this.close();
      });
    },
    attachGuest(conn, onOpen) {
      this.conn = conn;
      conn.on('open', () => { this.connected = true; if (onOpen) onOpen(); conn.send({ t: 'join', name: this.myName, token: myToken }); });
      conn.on('data', (msg) => guestOnData(msg));
      conn.on('close', () => {
        if (this.conn !== conn) return;
        this.connected = false; this.conn = null;
        toast('Lost connection to the table. Reconnecting...', 3500);
        setTimeout(() => { if (this.role === 'guest' && this.peer && !this.peer.destroyed) this.attachGuest(this.peer.connect(PREFIX + this.code, { reliable: true })); }, 1500);
      });
      conn.on('error', () => {});
    },
    send(obj) { if (this.conn && this.conn.open) { try { this.conn.send(obj); } catch (e) { /* ignore */ } } },
    sendTo(conn, obj) { if (conn && conn.open) { try { conn.send(obj); } catch (e) { /* ignore */ } } }
  };

  function lobbyHTML() {
    const cap = Net.role === 'host' ? Net.hostCfg.seats : (Net.lobbyCap || 5);
    return `<div class="lobby-list">${Net.lobby.map((p) => `<div><span>${esc(p.name)}</span><small>${p.host ? 'Host' : 'Joined'}</small></div>`).join('')}</div><p class="pt-note">${Net.lobby.length} of ${cap} seats taken.</p>`;
  }
  function refreshLobby() {
    const slot = $('#lobbySlot'); if (slot) slot.innerHTML = lobbyHTML();
    Net.conns.forEach((c) => Net.sendTo(c.conn, { t: 'lobby', players: Net.lobby.map((p) => ({ name: p.name, host: !!p.host })), cap: Net.hostCfg.seats }));
  }
  function hostOnData(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'join') {
      const name = String(msg.name || 'Guest').slice(0, 16);
      const token = String(msg.token || conn.peer);
      if (G && G.mode === 'online') {
        const seat = G.table.seats.findIndex((s) => s.kind === 'remote' && s.id === token);
        if (seat >= 0) { Net.conns.set(conn.peer, { conn, token, name, seat }); delete G.away[seat]; toast(`${name} reconnected`); sendState(conn.peer); return; }
        Net.sendTo(conn, { t: 'full', reason: 'The game has already started.' }); setTimeout(() => conn.close(), 400); return;
      }
      if (Net.lobby.length >= Net.hostCfg.seats) { Net.sendTo(conn, { t: 'full', reason: 'That table is full.' }); setTimeout(() => conn.close(), 400); return; }
      Net.conns.set(conn.peer, { conn, token, name, seat: -1 });
      Net.lobby = Net.lobby.filter((p) => p.token !== token).concat({ name, token });
      Sound.play('turn'); toast(`${name} joined the table`);
      refreshLobby();
      return;
    }
    const c = Net.conns.get(conn.peer);
    if (!c || !G) { if (c && msg.t === 'chat') relayChat(c, msg); return; }
    const t = G.table;
    if (msg.t === 'bet' && t.phase === 'betting') {
      const s = t.seats[c.seat];
      const amount = Math.max(0, Math.min(t.rules.maxBet, Math.round(+msg.amount || 0)));
      const spot = Math.max(0, Math.min(2, +msg.spot || 0));
      const others = s.bets.reduce((a, b, k) => a + (k === spot ? 0 : b), 0);
      if (others + amount <= s.bank) { while (s.bets.length <= spot) s.bets.push(0); s.bets[spot] = amount; delete G.ready[c.seat]; }
      broadcast();
    } else if (msg.t === 'ready' && t.phase === 'betting') {
      if (betsValid(t)) { sendState(conn.peer); return; }
      G.ready[c.seat] = true; maybeAllReady();
    } else if (msg.t === 'act' && t.phase === 'playing' && t.turn && t.turn.seat === c.seat && msg.round === t.round) {
      const res = N.act(t, String(msg.action));
      if (res.ok) { G.hint = null; afterChange(); } else sendState(conn.peer);
    } else if (msg.t === 'ins' && t.phase === 'insurance' && msg.round === t.round) {
      const res = N.insure(t, c.seat, !!msg.take);
      if (res.ok) afterChange(); else sendState(conn.peer);
    } else if (msg.t === 'chat') relayChat(c, msg);
  }
  function relayChat(c, msg) {
    const text = String(msg.text || '').slice(0, 200);
    if (!text) return;
    addChat(`${c.name}: ${text}`, 'them');
    Net.conns.forEach((o) => { if (o !== c) Net.sendTo(o.conn, { t: 'chat', text: `${c.name}: ${text}` }); });
  }
  function hostOnClose(conn) {
    const c = Net.conns.get(conn.peer);
    if (!c) return;
    Net.conns.delete(conn.peer);
    if (G && G.mode === 'online' && c.seat >= 0) {
      G.away[c.seat] = true;
      toast(`${c.name} disconnected. They will sit out until they return.`, 3500);
      G.table.seats[c.seat].bets = G.table.seats[c.seat].bets.map(() => 0);
      broadcast();
      if (G.table.turn && G.table.turn.seat === c.seat) pump();
      if (G.table.phase === 'betting') maybeAllReady();
    } else { Net.lobby = Net.lobby.filter((p) => p.token !== c.token); refreshLobby(); }
  }
  function sendState(peerId) {
    const c = Net.conns.get(peerId);
    if (!c || !G) return;
    Net.sendTo(c.conn, { t: 'state', view: N.publicView(G.table), seat: c.seat, meta: { stats: G.stats, history: G.history.slice(-15), ready: G.ready, away: G.away, deadline: G.deadline ? G.deadline - Date.now() : 0, cfg: { hints: G.cfg.hints, shot: G.cfg.shot, betTimer: G.cfg.betTimer } } });
  }
  function broadcast() { if (G && G.mode === 'online' && Net.role === 'host') Net.conns.forEach((c, id) => sendState(id)); }

  function guestOnData(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'lobby') {
      Net.lobby = msg.players || []; Net.lobbyCap = msg.cap;
      const slot = $('#lobbySlot');
      if (!slot) openModal(`<div class="m-head"><div><h3>You joined the table</h3><p>Waiting for the host to start.</p></div><button class="m-close" data-close aria-label="Leave">${icon('x')}</button></div><div id="lobbySlot">${lobbyHTML()}</div><div class="waiting"><span class="spinner"></span>Waiting for the host...</div>`, (act) => { if (act === 'close') Net.close(); });
      else slot.innerHTML = lobbyHTML();
    } else if (msg.t === 'state') {
      const first = !G || G.mode !== 'online';
      if (first) {
        closeModal();
        G = { mode: 'online', cfg: msg.meta.cfg, table: msg.view, mySeat: msg.seat, sel: { seat: msg.seat, spot: 0 }, stats: msg.meta.stats, history: msg.meta.history, hintsUsed: {}, hint: null, token: 1, deadline: 0, ready: {}, away: {}, statSeat: msg.seat };
        $('#chatTab').classList.remove('hidden');
        showView('game');
        toast('You are seated. Place your bet.');
      } else {
        const prevRound = G.table.round;
        G.table = msg.view; G.mySeat = msg.seat; G.stats = msg.meta.stats; G.history = msg.meta.history;
        if (G.table.round !== prevRound) G.hint = null;
      }
      G.sel = { seat: msg.seat, spot: Math.min(G.sel.spot || 0, G.table.seats[msg.seat].bets.length - 1) };
      G.readyView = msg.meta.ready; G.awayView = msg.meta.away;
      G.deadline = msg.meta.deadline ? Date.now() + msg.meta.deadline : 0;
      G.cfg = Object.assign(G.cfg || {}, msg.meta.cfg);
      renderAll();
      clearInterval(timers.clock);
      if (G.deadline) timers.clock = setInterval(updateTimers, 250);
      if (G.table.phase === 'playing' && G.table.turn && G.table.turn.seat === G.mySeat) Sound.play('turn');
    } else if (msg.t === 'chat') addChat(String(msg.text || '').slice(0, 240), 'them');
    else if (msg.t === 'full') { toast(msg.reason || 'That table is full.'); Net.close(); }
    else if (msg.t === 'ended') { toast('The host closed the table.', 4000); Net.close(); goHome(true); }
  }

  function setupOnline(joinCode) {
    const st = { seats: '5', preset: 'strip', bank: '1000', tab: joinCode ? 'join' : 'create', rules: Object.assign({}, N.PRESETS.strip) };
    openModal(`
      <div class="m-head"><div><h3>Play online</h3><p>Host a table and share the link, or join a friend's table.</p></div><button class="m-close" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="tabs" style="margin-bottom:16px">
        <button class="tab ${st.tab === 'create' ? 'active' : ''}" data-act="tab" data-t="create">Host a table</button>
        <button class="tab ${st.tab === 'join' ? 'active' : ''}" data-act="tab" data-t="join">Join a table</button>
      </div>
      <div class="field"><label for="nMe">Your name</label><input type="text" id="nMe" maxlength="16" placeholder="Player" value="${esc(settings.name)}"></div>
      <div id="createPane" class="${st.tab === 'create' ? '' : 'hidden'}">
        <div class="field"><span class="lbl">Seats</span>${seg('seats', [2, 3, 4, 5].map((v) => ({ id: String(v), label: String(v) })), st.seats)}</div>
        <div class="field"><span class="lbl">Starting chips</span>${seg('bank', [{ id: '500', label: '500' }, { id: '1000', label: '1,000' }, { id: '5000', label: '5,000' }], st.bank)}</div>
        ${rulesHTML(st)}
        <div class="field">${toggleRow('optHints', 'Allow the coach', 'Everyone can ask for strategy advice', true)}</div>
        <div id="roomSlot"></div>
        <div class="m-actions" id="createActions"><button class="btn primary block" data-act="create">${icon('link')}Open the table</button></div>
      </div>
      <div id="joinPane" class="${st.tab === 'join' ? '' : 'hidden'}">
        <div class="field"><label for="codeIn">Table code</label><input type="text" id="codeIn" maxlength="6" placeholder="ABC123" value="${esc(joinCode || '')}" style="text-transform:uppercase;font-family:var(--mono);letter-spacing:.15em"></div>
        <div class="waiting hidden" id="joinWait"><span class="spinner"></span>Connecting...</div>
        <div class="m-actions"><button class="btn primary block" data-act="join">${icon('globe')}Join table</button></div>
      </div>`,
    (act, el) => {
      if (act === 'close') { if (!G || G.mode !== 'online') Net.close(); return; }
      if (act === 'tab') {
        st.tab = el.dataset.t;
        $$('.tabs .tab', $('#modal')).forEach((x) => x.classList.toggle('active', x.dataset.t === st.tab));
        $('#createPane').classList.toggle('hidden', st.tab !== 'create');
        $('#joinPane').classList.toggle('hidden', st.tab !== 'join');
        return;
      }
      if (act === 'copy') {
        const v = $('#roomLink').value; const done = () => toast('Link copied');
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, () => { $('#roomLink').select(); document.execCommand('copy'); done(); });
        else { $('#roomLink').select(); document.execCommand('copy'); done(); }
        return;
      }
      if (act === 'begin') { hostBegin(); return; }
      const name = ($('#nMe').value.trim() || 'Player').slice(0, 16);
      settings.name = $('#nMe').value.trim(); saveSettings();
      if (typeof window.Peer !== 'function') { toast('Online play needs an internet connection. Check your connection and reload.'); return; }
      if (act === 'create') {
        const rules = readRules(st);
        el.disabled = true; el.innerHTML = '<span class="spinner"></span>Opening the table...';
        Net.host({ name, seats: +st.seats, bank: +st.bank, rules, hints: $('#optHints').checked }, (code) => {
          const link = `${location.origin}${location.pathname}?table=${code}`;
          $('#createActions').innerHTML = `<button class="btn primary block" data-act="begin">${icon('play')}Start the game</button>`;
          $('#roomSlot').innerHTML = `<div class="room-box"><div style="font-size:12px;color:var(--muted);font-weight:700;letter-spacing:.06em;text-transform:uppercase">Table code</div>
            <div class="room-code">${code}</div><div class="room-link"><input readonly value="${esc(link)}" id="roomLink"><button class="btn" data-act="copy">${icon('copy')}Copy link</button></div>
            <div id="lobbySlot">${lobbyHTML()}</div></div>`;
        });
      } else if (act === 'join') {
        const code = $('#codeIn').value.trim().toUpperCase();
        if (code.length < 4) { toast('Enter the table code your friend sent you.'); return; }
        $('#joinWait').classList.remove('hidden');
        Net.join(code, name, (err) => { $('#joinWait').classList.add('hidden'); toast(err); });
      }
    }, true);
    const onRule = wireRules(st);
    wireSegs($('#modal'), st, onRule);
  }
  function hostBegin() {
    const h = Net.hostCfg;
    const guests = [...Net.conns.values()];
    if (!guests.length) { toast('Wait for at least one friend to join.'); return; }
    const players = [{ name: h.name, kind: 'human' }].concat(guests.map((g) => ({ name: g.name, kind: 'remote', id: g.token })));
    guests.forEach((g, k) => { g.seat = k + 1; });
    closeModal();
    startGame({ mode: 'online', rules: h.rules, bank: h.bank, players, hints: h.hints, mySeat: 0, shot: 20, betTimer: 15 });
    broadcast();
  }

  function addChat(text, who) {
    if (!text) return;
    const log = $('#chatLog');
    const el = document.createElement('div');
    el.className = 'chat-msg ' + (who === 'me' ? 'me' : '');
    el.textContent = text; log.appendChild(el); log.scrollTop = log.scrollHeight;
    if (who === 'them' && $('[data-panel=chat]').classList.contains('hidden')) $('#chatDot').classList.remove('hidden');
  }
  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#chatInput'); const text = inp.value.trim();
    if (!text) return;
    if (Net.role === 'host') Net.conns.forEach((c) => Net.sendTo(c.conn, { t: 'chat', text: `${Net.hostCfg.name}: ${text}` }));
    else if (Net.connected) Net.send({ t: 'chat', text });
    else { toast('Not connected'); return; }
    addChat(`You: ${text}`, 'me'); inp.value = '';
  });

  /* ---------------- Views ---------------- */
  function showView(v) {
    $('#home').classList.toggle('hidden', v !== 'home');
    $('#game').classList.toggle('hidden', v !== 'game');
    window.scrollTo(0, 0);
  }
  function goHome(force) {
    const leave = () => {
      clearTimers();
      if (G && G.mode === 'online') { if (Net.role === 'host') Net.conns.forEach((c) => Net.sendTo(c.conn, { t: 'ended' })); setTimeout(() => Net.close(), 200); }
      G = null; renderHome(); showView('home');
    };
    if (!force && G && G.mode === 'online') {
      confirmBox(Net.role === 'host' ? 'Close this table?' : 'Leave this table?', Net.role === 'host' ? 'The game ends for everyone.' : 'You will lose your seat.', Net.role === 'host' ? 'Close table' : 'Leave', leave, true);
      return;
    }
    leave();
  }
  function switchTab(name) {
    $$('.tab[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.panel[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    if (name === 'chat') $('#chatDot').classList.add('hidden');
  }
  function renderHome() {
    const r = store.get('resume', null);
    const slot = $('#resumeSlot');
    if (r && r.G && r.G.table) {
      const t = r.G.table;
      const label = r.G.mode === 'solo' ? `Solo, ${t.rules.name || 'custom rules'}` : t.seats.map((s) => s.name).join(', ');
      slot.innerHTML = `<div class="resume"><div><strong>Continue your table</strong><span>${esc(label)}, round ${t.round}</span></div>
        <div class="row"><button class="btn ghost" id="resumeDrop">Discard</button><button class="btn primary" id="resumeGo">Resume</button></div></div>`;
      $('#resumeGo').onclick = () => {
        // An unfinished round is replayed from betting so no cards are lost
        const g = r.G;
        if (g.mode === 'solo') g.table.seats[0].bank = Math.max(g.table.seats[0].bank, 0);
        startGame(g.cfg, g);
      };
      $('#resumeDrop').onclick = () => { store.del('resume'); renderHome(); };
    } else slot.innerHTML = '';
  }

  function openSettings() {
    openModal(`
      <div class="m-head"><div><h3>Settings</h3><p>Saved on this device.</p></div><button class="m-close" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="field"><span class="lbl">Appearance</span>${seg('ui', [{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }], settings.ui)}</div>
      <div class="field"><span class="lbl">Table felt</span><div class="swatches">${FELTS.map((f) => `<button class="swatch felt-sw ${f.id === settings.felt ? 'on' : ''}" data-act="felt" data-f="${f.id}" aria-label="${f.id} felt" style="background:${f.c}"></button>`).join('')}</div></div>
      <div class="field"><span class="lbl">Card back</span><div class="swatches">${Object.keys(BACKS).map((k) => `<button class="swatch back-sw ${k === settings.back ? 'on' : ''}" data-act="back" data-b="${k}" aria-label="${k} card back">${backSVG(k)}</button>`).join('')}</div></div>
      <div class="field">
        ${toggleRow('sAlerts', 'Mistake alerts', 'Tell me when a decision differs from basic strategy', settings.alerts)}
        ${toggleRow('sCount', 'Show the count on the table', 'Running and true count in the corner of the table', settings.showCount)}
        ${toggleRow('sFour', 'Four-colour deck', 'Blue diamonds and green clubs', settings.four)}
        ${toggleRow('sFast', 'Fast dealing', 'Shorter animations and pauses', settings.fast)}
        ${toggleRow('sSound', 'Sounds', 'Cards, chips and results', settings.sound)}
      </div>
      <div class="m-actions"><button class="btn primary" data-act="done">Done</button></div>`,
    (act, el) => {
      if (act === 'felt') { settings.felt = el.dataset.f; $$('.felt-sw', $('#modal')).forEach((s) => s.classList.toggle('on', s === el)); applyTheme(); saveSettings(); }
      else if (act === 'back') { settings.back = el.dataset.b; $$('.back-sw', $('#modal')).forEach((s) => s.classList.toggle('on', s === el)); saveSettings(); if (G) { seen = new Set(); renderAll(); } }
      else if (act === 'done') closeModal();
    });
    const m = $('#modal');
    $('[data-seg=ui]', m).addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; $$('button', b.parentNode).forEach((x) => x.classList.toggle('on', x === b)); settings.ui = b.dataset.v; applyTheme(); saveSettings(); });
    const bind = (id, key, after) => $('#' + id, m).addEventListener('change', (e) => { settings[key] = e.target.checked; saveSettings(); if (after) after(); });
    bind('sAlerts', 'alerts');
    bind('sCount', 'showCount', () => G && renderAll());
    bind('sFour', 'four', () => { if (G) { seen = new Set(); renderAll(); } });
    bind('sFast', 'fast');
    bind('sSound', 'sound');
  }

  function openRules() {
    openModal(`
      <div class="m-head"><div><h3>How the rules work</h3><p>Everything below is enforced automatically, using the table rules chosen for the game.</p></div><button class="m-close" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="rules">
        <h4>The goal</h4><p>Beat the dealer by finishing closer to 21 without going over. Number cards count their value, face cards count 10, and aces count 1 or 11. A hand with an ace counted as 11 is called soft.</p>
        <h4>The deal</h4><p>Place a bet within the table limits. Everyone gets two cards face up. The dealer gets one face up and one face down (the hole card).</p>
        <h4>Blackjack</h4><p>An ace and a ten-value card as your first two cards is a blackjack and pays 3 to 2 (or 6 to 5 at some tables). Two cards making 21 after a split count as 21, not blackjack.</p>
        <h4>The dealer checks</h4><p>When the dealer shows an ace or a ten, they check the hole card for blackjack before anyone plays. If the dealer has blackjack, all hands lose except other blackjacks, which push.</p>
        <h4>Insurance and even money</h4><p>When the dealer shows an ace, you may insure for up to half your bet. Insurance pays 2 to 1 if the dealer has blackjack. With a blackjack of your own, you can take even money instead: paid 1 to 1 straight away.</p>
        <h4>Your choices</h4>
        <ul>
          <li><b>Hit:</b> take another card. Going over 21 is a bust and loses right away.</li>
          <li><b>Stand:</b> keep your total.</li>
          <li><b>Double down:</b> double your bet and take exactly one more card. Which totals you may double on depends on the table.</li>
          <li><b>Split:</b> two cards of the same rank become two hands, each with its own bet. Split aces get one card each unless the table allows hitting them.</li>
          <li><b>Surrender:</b> at tables that allow it, give up your first two cards and get half your bet back.</li>
        </ul>
        <h4>The dealer plays</h4><p>The dealer has no choices: they draw until reaching 17 or more. At "hits soft 17" tables, the dealer also draws on a soft 17.</p>
        <h4>Winning</h4><p>A win pays 1 to 1. A tie is a push and your bet is returned.</p>
        <h4>The shoe</h4><p>Cards are dealt from a shoe of 1 to 8 decks. When the cut card comes out, the shoe is shuffled before the next round.</p>
        <h4>Play chips</h4><p>Chips have no cash value and cannot be bought or sold. No real money is ever involved.</p>
      </div>
      <div class="m-actions"><button class="btn primary" data-close>Got it</button></div>`, null, true);
  }

  /* ---------------- Wiring ---------------- */
  function init() {
    applyTheme();
    fillIcons(document);
    $('#brandMark').innerHTML = `<svg viewBox="0 0 64 64" width="28" height="28"><rect x="11" y="17" width="25" height="35" rx="4" fill="#1d0f0d" transform="rotate(-13 23.5 34.5)"/><g transform="rotate(9 38 32)"><rect x="25" y="13" width="26" height="37" rx="4" fill="#fff" stroke="#1d0f0d" stroke-width="2"/><path d="M38 44 C32.6 40.2 30.6 37.6 30.6 34.9 C30.6 32.7 32.4 31.1 34.4 31.1 C35.9 31.1 37.2 32 38 33.3 C38.8 32 40.1 31.1 41.6 31.1 C43.6 31.1 45.4 32.7 45.4 34.9 C45.4 37.6 43.4 40.2 38 44 Z" fill="#e5483a"/></g></svg>`;
    renderHome();
    $$('.mode-card').forEach((c) => c.addEventListener('click', () => {
      const m = c.dataset.mode;
      if (m === 'solo') setupSolo(); else if (m === 'local') setupLocal(); else setupOnline();
    }));
    $('#brandBtn').onclick = () => goHome();
    $('#navPlay').onclick = () => goHome();
    $('#navRules').onclick = openRules;
    $('#navSettings').onclick = openSettings;
    $('#navTheme').onclick = () => { settings.ui = settings.ui === 'dark' ? 'light' : 'dark'; applyTheme(); saveSettings(); };
    $('#hintBtn').onclick = toggleHint;
    $('#newBtn').onclick = () => {
      if (!G) return;
      if (G.mode === 'online') { goHome(); return; }
      confirmBox('Start a new table?', G.mode === 'solo' ? 'Your chips are kept. Session stats start over.' : 'The current game ends.', 'New table', () => { clearTimers(); store.del('resume'); if (G.mode === 'solo') setupSolo(); else setupLocal(); });
    };
    $('#resetBtn').onclick = () => {
      if (!G || G.mode !== 'solo') return;
      confirmBox('Reset your chips?', `Your chips go back to ${fmt(START_BANK)}.`, 'Reset chips', () => {
        const t = G.table;
        if (t.phase !== 'betting' && t.phase !== 'done') { toast('Finish this round first.'); return; }
        if (t.phase === 'done') N.nextRound(t);
        t.seats[0].bank = START_BANK; t.seats[0].bets = t.seats[0].bets.map(() => 0);
        store.set('bank', START_BANK); renderAll(); save();
      });
    };
    $$('.tab[data-tab]').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
    document.addEventListener('keydown', (e) => {
      if (!G || $('#game').classList.contains('hidden') || e.target.closest('input, textarea')) return;
      if (!$('#modalBack').classList.contains('hidden')) { if (e.key === 'Escape') { const h = modalHandler; closeModal(); if (h) h('close'); } return; }
      const k = e.key.toLowerCase();
      const t = G.table;
      if (t.phase === 'playing') {
        const map = { h: 'hit', s: 'stand', d: 'double', p: 'split', r: 'surrender' };
        if (map[k]) { const L = N.legal(t); if (L && L[map[k]] && mine(t.turn.seat)) playerAct(map[k]); }
      } else if ((t.phase === 'betting' || t.phase === 'done') && k === 'enter' && document.activeElement.tagName !== 'BUTTON') pressDeal();
      if (k === 'c' && e.shiftKey) { settings.showCount = !settings.showCount; saveSettings(); renderAll(); }
    });
    window.addEventListener('resize', () => { if (G) renderTable(); });
    window.addEventListener('beforeunload', (e) => { if (G && G.mode === 'online') { e.preventDefault(); e.returnValue = ''; } });
    const code = new URLSearchParams(location.search).get('table');
    if (code) { const open = () => setupOnline(code.toUpperCase().slice(0, 6)); if (document.readyState === 'complete') open(); else window.addEventListener('load', open); }
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    window.__natural = { get G() { return G; }, startGame, playerAct, pressDeal, addChip, insureAct, settings };
  }
  init();
})();
