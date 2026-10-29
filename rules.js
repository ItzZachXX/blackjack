/*
 * Natural 21 - blackjack rules engine.
 * Table rules are configurable and fully enforced:
 *  - 1, 2, 6 or 8 decks dealt from a shoe with a cut card (reshuffle at about 75% penetration)
 *  - dealer stands on soft 17 (S17) or hits soft 17 (H17)
 *  - blackjack pays 3 to 2 or 6 to 5; a two-card 21 after a split is not a blackjack
 *  - dealer checks for blackjack when showing an ace or a ten-value card (US hole card rules)
 *  - insurance and even money offered against an ace, paying 2 to 1
 *  - double on any two cards, 9 to 11 only, or 10 and 11 only; double after split on or off
 *  - split pairs (optionally any two ten-value cards) up to 2, 3 or 4 hands; resplit aces on or off;
 *    split aces receive one card each unless hitting split aces is allowed
 *  - late surrender on the first two cards, or no surrender
 * The table state is a plain object so it can be saved and sent over the network.
 */
function NaturalRulesFactory(root) {
  'use strict';

  const RANK_CH = '23456789TJQKA';
  const SUIT_CH = 'shdc';
  const rankOf = (c) => (c >> 2) + 2;
  const cardCode = (c) => RANK_CH[rankOf(c) - 2] + SUIT_CH[c & 3];
  const value = (c) => { const r = rankOf(c); return r === 14 ? 11 : r >= 10 ? 10 : r; };
  const hiLo = (c) => { const v = value(c); return v <= 6 ? 1 : v >= 10 ? -1 : 0; };

  const PRESETS = {
    strip: { name: 'Las Vegas Strip', decks: 6, h17: false, bj: 1.5, double: 'any', das: true, maxHands: 4, rsa: false, hsa: false, surrender: true, splitTens: true, minBet: 5, maxBet: 500 },
    downtown: { name: 'Downtown Vegas', decks: 2, h17: true, bj: 1.5, double: 'any', das: true, maxHands: 4, rsa: false, hsa: false, surrender: false, splitTens: true, minBet: 5, maxBet: 500 },
    atlantic: { name: 'Atlantic City', decks: 8, h17: false, bj: 1.5, double: 'any', das: true, maxHands: 4, rsa: false, hsa: false, surrender: true, splitTens: true, minBet: 10, maxBet: 1000 },
    single: { name: 'Single deck, 6 to 5', decks: 1, h17: true, bj: 1.2, double: '10-11', das: false, maxHands: 2, rsa: false, hsa: false, surrender: false, splitTens: false, minBet: 5, maxBet: 200 }
  };

  /* ---------- hand values ---------- */
  function total(cards) {
    let t = 0, aces = 0;
    for (const c of cards) { t += value(c); if (rankOf(c) === 14) aces++; }
    while (t > 21 && aces) { t -= 10; aces--; }
    return { total: t, soft: aces > 0 && t <= 21 };
  }
  const isBlackjack = (h) => h.cards.length === 2 && !h.fromSplit && total(h.cards).total === 21;

  /* ---------- shoe ---------- */
  function rand(n) {
    if (root.crypto && root.crypto.getRandomValues) {
      const a = new Uint32Array(1); const lim = Math.floor(0x100000000 / n) * n;
      do { root.crypto.getRandomValues(a); } while (a[0] >= lim);
      return a[0] % n;
    }
    return Math.floor(Math.random() * n);
  }
  function newShoe(decks) {
    const s = [];
    for (let d = 0; d < decks; d++) for (let c = 0; c < 52; c++) s.push(c);
    for (let i = s.length - 1; i > 0; i--) { const j = rand(i + 1); const x = s[i]; s[i] = s[j]; s[j] = x; }
    return s;
  }

  /* ---------- table ---------- */
  function createTable(rules, players, bank) {
    const t = {
      v: 1, rules: Object.assign({}, rules),
      shoe: [], cut: 0, shoeSize: rules.decks * 52,
      seats: players.map((p) => ({ name: p.name, kind: p.kind || 'human', id: p.id || null, bank: bank, bets: [0], lastBets: [0], hands: [], insurance: 0, insDecided: false, evenMoney: false, out: false })),
      dealer: { cards: [], hidden: true },
      phase: 'betting', turn: null, round: 0, count: { running: 0, seen: 0 }, log: [], shuffled: false
    };
    shuffle(t);
    return t;
  }

  function shuffle(t) {
    t.shoe = newShoe(t.rules.decks);
    t.shoeSize = t.shoe.length;
    // Cut card about three quarters of the way in (a little earlier for small shoes)
    const pen = t.rules.decks === 1 ? 0.6 : t.rules.decks === 2 ? 0.68 : 0.75;
    t.cut = Math.round(t.shoeSize * (1 - pen));
    t.count = { running: 0, seen: 0 };
    t.discards = [];
    t.shuffled = true;
  }

  function draw(t, faceUp) {
    if (!t.shoe.length) { shuffle(t); t.log.push({ e: 'shuffle', mid: true }); }
    const c = t.shoe.pop();
    if (faceUp !== false) { t.count.running += hiLo(c); t.count.seen++; }
    return c;
  }
  const decksLeft = (t) => Math.max(0.25, t.shoe.length / 52);
  const trueCount = (t) => t.count.running / decksLeft(t);

  function totalBet(s) { return s.bets.reduce((a, b) => a + b, 0); }

  // Betting: amount for spot k of seat i
  function setBet(t, i, k, amount) {
    if (t.phase !== 'betting') return { ok: false, error: 'Bets are closed' };
    const s = t.seats[i];
    amount = Math.max(0, Math.round(amount));
    if (amount && amount < t.rules.minBet) return { ok: false, error: `The minimum bet is ${t.rules.minBet}` };
    if (amount > t.rules.maxBet) return { ok: false, error: `The maximum bet is ${t.rules.maxBet}` };
    const others = totalBet(s) - (s.bets[k] || 0);
    if (others + amount > s.bank) return { ok: false, error: 'Not enough chips' };
    while (s.bets.length <= k) s.bets.push(0);
    s.bets[k] = amount;
    return { ok: true };
  }

  function canDeal(t) {
    return t.phase === 'betting' && t.seats.some((s) => !s.out && totalBet(s) > 0);
  }

  function deal(t) {
    if (!canDeal(t)) return { ok: false, error: 'Place a bet first' };
    t.round++;
    t.log = [];
    t.shuffled = false;
    if (t.shoe.length <= t.cut) { shuffle(t); t.log.push({ e: 'shuffle' }); }
    // Cards from the last round go to the discard tray (cleared when the shoe is shuffled)
    if (!t.log.some((e) => e.e === 'shuffle')) {
      t.seats.forEach((s) => s.hands.forEach((h) => t.discards.push(...h.cards)));
      t.discards.push(...t.dealer.cards.filter((c) => c >= 0));
    }
    t.dealer = { cards: [], hidden: true };
    for (const s of t.seats) {
      s.hands = [];
      s.insurance = 0; s.insDecided = false; s.evenMoney = false;
      if (s.out) continue;
      s.bets.forEach((b, k) => {
        if (b > 0) {
          s.bank -= b;
          s.hands.push({ cards: [], bet: b, spot: k, doubled: false, fromSplit: false, splitAces: false, done: false, surrendered: false, result: null, payout: 0 });
        }
      });
      s.lastBets = s.bets.slice();
    }
    const order = [];
    t.seats.forEach((s, i) => s.hands.forEach((h, k) => order.push([i, k])));
    for (const [i, k] of order) t.seats[i].hands[k].cards.push(draw(t));
    t.dealer.cards.push(draw(t));
    for (const [i, k] of order) t.seats[i].hands[k].cards.push(draw(t));
    t.dealer.cards.push(draw(t, false)); // hole card, counted when revealed
    t.log.push({ e: 'deal' });
    const up = t.dealer.cards[0];
    if (rankOf(up) === 14) {
      t.phase = 'insurance';
      for (const s of t.seats) if (!s.hands.length) s.insDecided = true;
      if (t.seats.every((s) => s.insDecided)) afterInsurance(t);
      return { ok: true };
    }
    peek(t);
    return { ok: true };
  }

  // Insurance (up to half the original bets) or even money on a blackjack
  function insure(t, i, take) {
    if (t.phase !== 'insurance') return { ok: false, error: 'Insurance is not offered now' };
    const s = t.seats[i];
    if (s.insDecided) return { ok: false, error: 'Already decided' };
    if (take) {
      const allBJ = s.hands.every(isBlackjack);
      const cost = Math.floor(s.hands.reduce((a, h) => a + h.bet, 0) / 2);
      if (allBJ && s.hands.length === 1) { s.evenMoney = true; }
      else {
        if (cost > s.bank) return { ok: false, error: 'Not enough chips for insurance' };
        s.bank -= cost; s.insurance = cost;
      }
    }
    s.insDecided = true;
    t.log.push({ e: 'insurance', seat: i, take: !!take, even: s.evenMoney });
    if (t.seats.every((x) => x.insDecided)) afterInsurance(t);
    return { ok: true };
  }

  function afterInsurance(t) {
    // Even money: paid 1 to 1 right away, before the dealer checks
    t.seats.forEach((s, i) => {
      if (s.evenMoney) {
        const h = s.hands[0];
        h.done = true; h.result = 'even'; h.payout = h.bet * 2;
        s.bank += h.payout;
        t.log.push({ e: 'result', seat: i, hand: 0, result: 'even', amount: h.bet });
      }
    });
    peek(t);
  }

  function revealHole(t) {
    if (!t.dealer.hidden) return;
    t.dealer.hidden = false;
    const hole = t.dealer.cards[1];
    t.count.running += hiLo(hole); t.count.seen++;
    t.log.push({ e: 'hole', card: hole });
  }

  function peek(t) {
    const up = value(t.dealer.cards[0]);
    const dealerBJ = total(t.dealer.cards).total === 21;
    if ((up === 11 || up === 10) && dealerBJ) {
      revealHole(t);
      t.log.push({ e: 'dealerBJ' });
      t.seats.forEach((s, i) => {
        if (s.insurance) { const win = s.insurance * 3; s.bank += win; t.log.push({ e: 'insPaid', seat: i, amount: s.insurance * 2 }); }
        s.hands.forEach((h, k) => {
          if (h.result) return;
          h.done = true;
          if (isBlackjack(h)) { h.result = 'push'; h.payout = h.bet; s.bank += h.bet; }
          else { h.result = 'lose'; h.payout = 0; }
          t.log.push({ e: 'result', seat: i, hand: k, result: h.result, amount: h.result === 'push' ? 0 : -h.bet });
        });
      });
      t.phase = 'done'; t.turn = null;
      return;
    }
    if (up === 11) t.seats.forEach((s, i) => { if (s.insurance) t.log.push({ e: 'insLost', seat: i, amount: s.insurance }); });
    // Player blackjacks are paid now
    t.seats.forEach((s, i) => s.hands.forEach((h, k) => {
      if (!h.result && isBlackjack(h)) {
        h.done = true; h.result = 'blackjack';
        const win = Math.floor(h.bet * t.rules.bj);
        h.payout = h.bet + win; s.bank += h.payout;
        t.log.push({ e: 'result', seat: i, hand: k, result: 'blackjack', amount: win });
      }
    }));
    t.phase = 'playing';
    t.turn = null;
    advance(t);
  }

  function current(t) {
    if (!t.turn) return null;
    return t.seats[t.turn.seat].hands[t.turn.hand];
  }

  function advance(t) {
    const start = t.turn ? [t.turn.seat, t.turn.hand] : [0, -1];
    for (let i = start[0]; i < t.seats.length; i++) {
      const s = t.seats[i];
      for (let k = i === start[0] ? start[1] + 1 : 0; k < s.hands.length; k++) {
        const h = s.hands[k];
        if (!h.done) {
          // A split hand gets its second card when it comes into play
          if (h.cards.length === 1) {
            h.cards.push(draw(t));
            if (h.splitAces && !t.rules.hsa) { h.done = true; continue; }
            if (total(h.cards).total === 21) { h.done = true; continue; }
          }
          t.turn = { seat: i, hand: k };
          return;
        }
      }
    }
    t.turn = null;
    dealerPlay(t);
  }

  function pairRank(h) {
    const [a, b] = h.cards;
    return rankOf(a) === rankOf(b) || (value(a) === 10 && value(b) === 10);
  }

  // What the current hand may do
  function legal(t) {
    if (t.phase !== 'playing' || !t.turn) return null;
    const s = t.seats[t.turn.seat], h = current(t), r = t.rules;
    const two = h.cards.length === 2;
    const tot = total(h.cards).total;
    const handsNow = s.hands.length;
    let dbl = two && s.bank >= h.bet && (!h.fromSplit || r.das) && !(h.splitAces && !r.hsa);
    if (dbl && r.double === '9-11') dbl = !total(h.cards).soft && tot >= 9 && tot <= 11;
    if (dbl && r.double === '10-11') dbl = !total(h.cards).soft && tot >= 10 && tot <= 11;
    let split = two && s.bank >= h.bet && handsNow < r.maxHands;
    if (split) {
      const [a, b] = h.cards;
      split = r.splitTens ? (rankOf(a) === rankOf(b) || (value(a) === 10 && value(b) === 10)) : rankOf(a) === rankOf(b);
      if (split && rankOf(a) === 14 && h.fromSplit && !r.rsa) split = false;
    }
    return {
      hit: !(h.splitAces && !r.hsa),
      stand: true,
      double: dbl,
      split,
      surrender: r.surrender && two && !h.fromSplit && s.hands.length === 1
    };
  }

  function act(t, action) {
    const L = legal(t);
    if (!L) return { ok: false, error: 'Not your turn' };
    if (!L[action]) return { ok: false, error: `You cannot ${action} here` };
    const i = t.turn.seat, k = t.turn.hand;
    const s = t.seats[i], h = current(t);
    t.log.push({ e: 'act', seat: i, hand: k, a: action });
    if (action === 'hit') {
      h.cards.push(draw(t));
      const tot = total(h.cards).total;
      if (tot > 21) { h.done = true; h.result = 'bust'; t.log.push({ e: 'bust', seat: i, hand: k }); }
      else if (tot === 21) h.done = true;
    } else if (action === 'stand') {
      h.done = true;
    } else if (action === 'double') {
      s.bank -= h.bet; h.bet *= 2; h.doubled = true;
      h.cards.push(draw(t));
      h.done = true;
      if (total(h.cards).total > 21) { h.result = 'bust'; t.log.push({ e: 'bust', seat: i, hand: k }); }
    } else if (action === 'split') {
      s.bank -= h.bet;
      const aces = rankOf(h.cards[0]) === 14;
      const second = { cards: [h.cards.pop()], bet: h.bet, spot: h.spot, doubled: false, fromSplit: true, splitAces: aces, done: false, surrendered: false, result: null, payout: 0 };
      h.fromSplit = true; h.splitAces = aces;
      s.hands.splice(k + 1, 0, second);
      h.cards.push(draw(t));
      if (aces && !t.rules.hsa) h.done = true;
      else if (total(h.cards).total === 21) h.done = true;
    } else if (action === 'surrender') {
      h.done = true; h.surrendered = true; h.result = 'surrender';
      h.payout = Math.floor(h.bet / 2); s.bank += h.payout;
    }
    if (h.done) advance(t);
    return { ok: true };
  }

  function dealerPlay(t) {
    t.phase = 'dealer';
    revealHole(t);
    const live = t.seats.some((s) => s.hands.some((h) => !h.result));
    if (live) {
      for (;;) {
        const d = total(t.dealer.cards);
        if (d.total > 21) break;
        if (d.total > 17 || (d.total === 17 && !(d.soft && t.rules.h17))) break;
        t.dealer.cards.push(draw(t));
        t.log.push({ e: 'dealerHit' });
      }
    }
    settle(t);
  }

  function settle(t) {
    const d = total(t.dealer.cards).total;
    t.seats.forEach((s, i) => s.hands.forEach((h, k) => {
      if (h.result) {
        if (h.result === 'bust') t.log.push({ e: 'result', seat: i, hand: k, result: 'bust', amount: -h.bet });
        if (h.result === 'surrender') t.log.push({ e: 'result', seat: i, hand: k, result: 'surrender', amount: -(h.bet - h.payout) });
        return;
      }
      const p = total(h.cards).total;
      if (d > 21 || p > d) { h.result = 'win'; h.payout = h.bet * 2; }
      else if (p === d) { h.result = 'push'; h.payout = h.bet; }
      else { h.result = 'lose'; h.payout = 0; }
      s.bank += h.payout;
      t.log.push({ e: 'result', seat: i, hand: k, result: h.result, amount: h.payout - h.bet });
    }));
    t.phase = 'done'; t.turn = null;
  }

  // Back to betting for the next round; bets stay where they were if the player can afford them
  function nextRound(t) {
    if (t.phase !== 'done') return;
    t.phase = 'betting'; t.turn = null;
    for (const s of t.seats) {
      const want = s.lastBets.reduce((a, b) => a + b, 0);
      s.bets = want <= s.bank && want >= t.rules.minBet ? s.lastBets.slice() : s.lastBets.map(() => 0);
    }
  }

  // A copy that hides the shoe order and the dealer's hole card
  function publicView(t) {
    const v = JSON.parse(JSON.stringify(t));
    v.shoeLeft = t.shoe.length;
    v.shoe = [];
    if (v.dealer.hidden && v.dealer.cards.length > 1) v.dealer.cards[1] = -1;
    return v;
  }

  /* ---------- basic strategy ---------- */
  // Returns H (hit), S (stand), D (double), P (split) or R (surrender), already adjusted for what is allowed.
  const UPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  // Multi-deck basic strategy, adjusted for H17, double after split, surrender and small shoes
  function strategyRaw(cards, up, r, isFirst, allowSplit) {
    const { total: tot, soft } = total(cards);
    const u = value(up);
    const at = (row) => row[UPS.indexOf(u)];
    if (allowSplit !== false && cards.length === 2 && rankOf(cards[0]) === rankOf(cards[1])) {
      const v = value(cards[0]);
      if (v === 8 && u === 11 && r.h17 && r.surrender && isFirst) return 'R';
      const row = {
        11: 'PPPPPPPPPP',
        9: 'PPPPP-PP--',
        8: 'PPPPPPPPPP',
        7: 'PPPPPP----',
        6: r.das ? 'PPPPP-----' : '-PPPP-----',
        4: r.das ? '---PP-----' : '----------',
        3: r.das ? 'PPPPPP----' : '--PPPP----',
        2: r.das ? 'PPPPPP----' : '--PPPP----'
      }[v];
      if (row && at(row) === 'P') return 'P';
    }
    if (soft) {
      const row = {
        20: 'SSSSSSSSSS',
        19: r.h17 ? 'SSSSdSSSSS' : 'SSSSSSSSSS',
        18: r.h17 ? 'dddddSSHHH' : 'SddddSSHHH',
        17: 'HDDDDHHHHH',
        16: 'HHDDDHHHHH', 15: 'HHDDDHHHHH',
        14: 'HHHDDHHHHH', 13: 'HHHDDHHHHH'
      }[tot];
      if (tot >= 20) return 'S';
      return row ? at(row) : 'H';
    }
    if (tot >= 17) return tot === 17 && u === 11 && r.h17 && r.surrender && isFirst ? 'R' : 'S';
    if (tot === 16) { if (r.surrender && isFirst && u >= 9) return 'R'; return at('SSSSSHHHHH'); }
    if (tot === 15) { if (r.surrender && isFirst && (u === 10 || (u === 11 && r.h17))) return 'R'; return at('SSSSSHHHHH'); }
    if (tot === 13 || tot === 14) return at('SSSSSHHHHH');
    if (tot === 12) return at('HHSSSHHHHH');
    if (tot === 11) return at(r.h17 || r.decks <= 2 ? 'DDDDDDDDDD' : 'DDDDDDDDDH');
    if (tot === 10) return at('DDDDDDDDHH');
    if (tot === 9) return at(r.decks <= 2 ? 'DDDDDHHHHH' : 'HDDDDHHHHH');
    if (tot === 8 && r.decks === 1) return at('HHHDDHHHHH');
    return 'H';
  }

  // Basic strategy for the current hand, turned into an action the table allows
  function bestAction(t) {
    const L = legal(t);
    if (!L) return null;
    const h = current(t);
    const s = t.seats[t.turn.seat];
    const up = t.dealer.cards[0];
    const isFirst = s.hands.length === 1 && h.cards.length === 2 && !h.fromSplit;
    let raw = strategyRaw(h.cards, up, t.rules, isFirst, L.split);
    if (raw === 'R' && !L.surrender) raw = strategyRaw(h.cards, up, Object.assign({}, t.rules, { surrender: false }), false, L.split);
    let a;
    if (raw === 'P') a = 'split';
    else if (raw === 'R') a = 'surrender';
    else if (raw === 'D') a = L.double ? 'double' : 'hit';
    else if (raw === 'd') a = L.double ? 'double' : 'stand';
    else if (raw === 'S') a = 'stand';
    else a = 'hit';
    if (a === 'hit' && !L.hit) a = 'stand';
    const tot = total(h.cards);
    return { action: a, raw, total: tot.total, soft: tot.soft };
  }

  // Chance the next card busts a hand, from the cards still in the shoe
  function bustChance(t, cards, knownShoeLeft) {
    const tot = total(cards);
    if (tot.soft) return 0;
    const need = 21 - tot.total;
    if (need >= 10) return 0;
    // Remaining composition: full shoe minus every card seen
    const counts = new Array(12).fill(0);
    const decks = t.rules.decks;
    for (let v = 2; v <= 11; v++) counts[v] = (v === 10 ? 16 : 4) * decks;
    const seen = [];
    t.seats.forEach((s) => s.hands.forEach((h) => seen.push(...h.cards)));
    seen.push(...t.dealer.cards.filter((c) => c >= 0));
    if (t.discards) seen.push(...t.discards);
    for (const c of seen) counts[value(c)]--;
    let left = 0, bust = 0;
    for (let v = 2; v <= 11; v++) { const n = Math.max(0, counts[v]); left += n; if ((v === 11 ? 1 : v) > need) bust += n; }
    return left ? bust / left : 0;
  }

  const DEALER_BUST = { s17: { 2: 0.35, 3: 0.37, 4: 0.40, 5: 0.42, 6: 0.42, 7: 0.26, 8: 0.24, 9: 0.23, 10: 0.23, 11: 0.17 }, h17: { 2: 0.35, 3: 0.38, 4: 0.40, 5: 0.43, 6: 0.44, 7: 0.26, 8: 0.24, 9: 0.23, 10: 0.23, 11: 0.21 } };

  root.Natural = {
    PRESETS, RANK_CH, SUIT_CH, rankOf, cardCode, value, hiLo, total, isBlackjack,
    createTable, shuffle, setBet, canDeal, deal, insure, legal, act, nextRound, current, publicView,
    totalBet, trueCount, decksLeft, strategyRaw, bestAction, bustChance, DEALER_BUST
  };
  return root.Natural;
}
(function (g) {
  const N = NaturalRulesFactory(g);
  g.NaturalRulesFactory = NaturalRulesFactory;
  if (typeof module !== 'undefined' && module.exports) module.exports = N;
})(typeof globalThis !== 'undefined' ? globalThis : this);
