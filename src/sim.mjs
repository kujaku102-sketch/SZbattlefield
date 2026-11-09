// The trusted side of a CPU that tries moves ahead (it is NOT part of any CPU): it holds the real state of the match and hands out
// states the CPU may try moves on. A CPU never gets the real state or a way to reach it; it gets what this module builds.
//
//   leanClone(state)            a copy of an engine state without the parts a try never needs (log, events, history)
//   determinize(...)            a copy in which everything the seat cannot see is re-drawn at random:
//                                 the seat's own deck order, the opponent's hand, deck order and face-down cards;
//                               the random generator is re-seeded. The cards drawn from are the decklist minus the cards the seat can see by
//                               the rules (rulebook 4.5: the controller of a face-down card may look at it, the opponent may not), never the
//                               real hidden cards. A card an effect created is not a deck card and is not subtracted.
//   prior (SZB_SIM_PRIOR, --sim-prior of run.mjs): where the opponent's hidden cards are drawn from.
//     real  the opponent's decklist minus the cards the seat has seen (what this module always did; the seat's own deck is always its own list).
//     seen  only what the seat could know (the rule the game's CPU keeps: a CPU does not use the other side's deck): the cards of the library that the rules let a deck hold, of the
//           colours the seat has seen of that side (every colour while it has seen none), each with a weight of 1 plus 4 for each copy the seat has seen, no more copies of a name than the
//           rules allow (the other user card's same-name rule is public) less the copies the seat has seen. The opponent's decklist is not read.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const now = () => process.hrtime.bigint();
const msSince = (t) => Number(now() - t) / 1e6;

export async function loadSim(gameDir) {
  const imp = (p) => import(pathToFileURL(path.join(gameDir, p)).href);
  const G = {
    authority: await imp('src/game/runtime/authority.js'),
    port: await imp('src/adapters/local-runtime-port.js'),
    contract: await imp('src/adapters/port-contract.js'),
    tx: await imp('src/game/runtime/transaction.js'),
    bridge: await imp('src/game/runtime/command-bridge.js'),
    actions: await imp('src/game/runtime/transaction-actions.js'),
    record: await imp('src/game/runtime/match-record.js'),
    engine: await imp('src/game/engine.js'),
    shared: await imp('src/game/core/shared.js'),
    prepare: await imp('src/game/core/prepare.js'),
    rng: await imp('src/game/runtime/rng.js'),
    cards: await imp('src/data/cards.js'),
    decks: await imp('src/data/start-decks.js'),
    builder: await imp('src/game/deck-builder.js').catch(() => null)
  };
  const PRIOR = process.env.SZB_SIM_PRIOR === 'seen' ? 'seen' : 'real';
  const DECKLISTS = Object.fromEntries(G.decks.START_DECKS.map((deck) => [deck.id, deck.cards]));
  // a deck is named by a start deck id, or given as its list { card id: copies } (a custom deck: src/decks.mjs)
  const listOf = (deck) => (typeof deck === 'string' ? DECKLISTS[deck] : deck) ?? {};

  // The copy of the engine state used for trying moves: the engine's own copy for history, without the log, the event list and the
  // history (checked by probe/probe.mjs: the same move gives the same state, up to the clock-made choice request ids).
  function leanClone(state) {
    const rng = state.rng;
    const copy = structuredClone({ ...state, rng: null, history: [], log: [], events: [] });
    copy.rng = copy.runtimeContext ? G.shared.runtimeRng(copy.runtimeContext) : rng;
    return copy;
  }

  // The same copy, made about three times faster: the compiled effect of every card (a read-only structure the engine only reads) is shared
  // with the original instead of copied. probe/probe.mjs checks that the same move gives the same state on both kinds of copy.
  const ZONES = ['deck', 'hand', 'front', 'back', 'registry', 'trash', 'ban'];
  function shareClone(state) {
    const saved = [];                       // one entry per card in traversal order: [had a compiled property, its value]
    const walk = (cards, visit) => { for (const card of cards) { visit(card); walk(card.mounted ?? [], visit); } };
    const each = (root, visit) => { for (const holder of ['player', 'ai']) for (const zone of ZONES) walk(root.players[holder][zone], visit); };
    each(state, (card) => { const had = Object.hasOwn(card, 'compiled'); saved.push([had, card.compiled]); if (had) card.compiled = undefined; });
    let copy;
    try { copy = leanClone(state); }
    finally { let i = 0; each(state, (card) => { const [had, value] = saved[i]; i += 1; if (had) card.compiled = value; }); }
    let i = 0;
    each(copy, (card) => { const [had, value] = saved[i]; i += 1; if (had && value !== undefined) card.compiled = value; });
    return copy;
  }

  // What the seat sees of the cards that came from the decks, by the rules, counted by owner seat and card id (the same cards the query
  // shows, plus its own face-down cards, which the rulebook lets their controller look at). A card an effect created has a serial number
  // above the deck cards' (the identity ledger numbers the decks first); it is not a deck card, so it is left out.
  const serialOf = (card) => { const n = Number(String(card.identity?.instanceId ?? '').slice(2)); return Number.isSafeInteger(n) ? n : 0; };
  const HIDDEN_ZONES = ['hand', 'front', 'back', 'registry', 'trash', 'ban'];
  function visibleCounts(state, viewerPlayer, seatIds, deckLimit) {
    const counts = { 'seat-a': {}, 'seat-b': {} };
    const seatOf = { player: seatIds[0], ai: seatIds[1] };
    const count = (card) => { if (serialOf(card) > deckLimit) return; const seat = seatOf[card.owner]; if (seat) counts[seat][card.id] = (counts[seat][card.id] ?? 0) + 1; };
    const walk = (card, visible) => { if (visible) count(card); for (const child of card.mounted ?? []) walk(child, visible); };
    for (const holder of ['player', 'ai']) {
      for (const zone of HIDDEN_ZONES) {
        for (const card of state.players[holder][zone]) {
          const hidden = zone === 'hand' ? holder !== viewerPlayer : card.faceDown === true && holder !== viewerPlayer;
          walk(card, !hidden);
        }
      }
    }
    return counts;
  }

  let simSerial = 0;
  function simCard(id, owner, ownerSeat) {
    simSerial += 1;
    return { ...G.cards.createCardInstance(id, owner, simSerial), uid: `sim:${simSerial}`, ownerSeat };
  }

  // The hidden slots of the viewer's view of a state: the deck always; for the opponent also its hand and its face-down cards
  // (on the board, in the registry, in the trash and the ban). The viewer's own face-down cards are not hidden from it.
  function hiddenSlots(state, viewerPlayer, player) {
    const slots = [];
    const holder = state.players[player];
    holder.deck.forEach((_, index) => slots.push({ zone: 'deck', index }));
    if (player !== viewerPlayer) {
      holder.hand.forEach((_, index) => slots.push({ zone: 'hand', index }));
      for (const zone of ['front', 'back', 'registry', 'trash', 'ban']) holder[zone].forEach((card, index) => { if (card.faceDown === true) slots.push({ zone, index }); });
    }
    return slots;
  }

  // The 'seen' prior: a list of `count` card ids for one side's hidden slots, from what the seat has seen of that side and the rules of deck building (see the head of this file).
  const COPY_CAP_UNLIMITED = 6;
  function seenPool(holder, seenCounts, count, rand) {
    const deckRule = holder.user?.deckRule ?? '';
    const sameName = Number(deckRule.match(/同名(d+)枚/)?.[1] ?? 3);
    const rule = { sameName, sameNameByUser: /同名d+枚/.test(deckRule) };
    const library = G.builder?.BUILDABLE_CARDS ?? Object.values(G.cards.CARD_LIBRARY).filter((card) => /^STD-d{3}$/.test(card.id) && !card.token && !['VOb', 'Plugin'].includes(card.category));
    const limitOf = (card) => { const limit = G.builder?.copyLimit ? G.builder.copyLimit(card, rule) : sameName; return Number.isFinite(limit) ? limit : COPY_CAP_UNLIMITED; };
    const colours = new Set(Object.keys(seenCounts).map((id) => G.cards.CARD_LIBRARY[id]?.color).filter(Boolean));
    const entries = [];
    for (const card of library) {
      if (colours.size > 0 && card.color && !colours.has(card.color)) continue;
      const seenCopies = seenCounts[card.id] ?? 0;
      entries.push({ id: card.id, left: Math.max(0, limitOf(card) - seenCopies), weight: 1 + 4 * seenCopies });
    }
    const pool = [];
    let total = entries.reduce((sum, entry) => sum + (entry.left > 0 ? entry.weight : 0), 0);
    for (let n = 0; n < count && total > 0; n += 1) {
      let at = rand() * total;
      for (const entry of entries) {
        if (entry.left <= 0) continue;
        if (at < entry.weight) { pool.push(entry.id); entry.left -= 1; if (entry.left === 0) total -= entry.weight; break; }
        at -= entry.weight;
      }
    }
    return pool;
  }

  // engine: the real state (read to copy it and to count what the seat sees); deckIds: { player, ai } start deck ids, or the lists of custom decks.
  // Returns { state, ms: { clone, derive, fill, total }, plan } (plan: per owner, the pool and the slots; used by the checks).
  function determinize(engine, viewerPlayer, seatIds, deckIds, rand) {
    const t0 = now();
    const copy = shareClone(engine);
    const tClone = msSince(t0);

    const t1 = now();
    const deckLimit = Object.values(listOf(deckIds.player)).reduce((n, c) => n + c, 0) + Object.values(listOf(deckIds.ai)).reduce((n, c) => n + c, 0);
    const visible = visibleCounts(engine, viewerPlayer, seatIds, deckLimit);
    const owners = [['player', seatIds[0], deckIds.player], ['ai', seatIds[1], deckIds.ai]];
    const plan = owners.map(([player, seat, deckId]) => {
      const slots = hiddenSlots(copy, viewerPlayer, player);
      let pool = [];
      if (PRIOR === 'seen' && player !== viewerPlayer) {
        // the other side's list is not read; the pool is drawn in the order of the slots, so it is already shuffled
        pool = seenPool(engine.players[player], visible[seat], slots.length, rand);
      } else {
        for (const [id, copies] of Object.entries(listOf(deckId))) {
          const left = copies - (visible[seat][id] ?? 0);
          for (let i = 0; i < left; i += 1) pool.push(id);
        }
      }
      return { player, seat, pool, slots };
    });
    const tDerive = msSince(t1);

    const t2 = now();
    for (const { player, seat, pool, slots } of plan) {
      for (let i = pool.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      const holder = copy.players[player];
      // The decklist minus the seen cards does not always explain every hidden slot (see probe/diagnose-pool.mjs). A slot the pool cannot
      // fill gets a card drawn from the decklist: a real hidden card is never left in place.
      // (under the 'seen' prior the other side's pool always has a card for every slot, and its list is never read: asking for it is an error)
      const drawFromList = PRIOR === 'seen' && player !== viewerPlayer ? () => { throw new Error('sim: the other side list was asked for under the seen prior'); } : (() => {
        const list = Object.entries(listOf(deckIds[player]));
        const listTotal = list.reduce((n, [, copies]) => n + copies, 0);
        return () => { let at = Math.floor(rand() * listTotal); for (const [id, copies] of list) { if (at < copies) return id; at -= copies; } return list[0][0]; };
      })();
      slots.forEach((slot, n) => {
        const fresh = simCard(pool[n] ?? drawFromList(), player, seat);
        if (slot.zone === 'deck') holder.deck[slot.index] = fresh;
        else if (slot.zone === 'hand') holder.hand[slot.index] = G.prepare.hydrateCard(fresh);
        else if (slot.zone === 'registry' || slot.zone === 'trash' || slot.zone === 'ban') holder[slot.zone][slot.index] = { ...G.prepare.hydrateCard(fresh), faceDown: true };
        else {
          const old = holder[slot.zone][slot.index];
          holder[slot.zone][slot.index] = { ...G.prepare.hydrateCard(fresh), faceDown: true, sleep: old.sleep, summoningSick: old.summoningSick,
            residentActive: old.residentActive, layerRole: old.layerRole, slot: old.slot, placementOrder: old.placementOrder };
        }
      });
    }
    if (copy.runtimeContext) copy.runtimeContext.rngState = G.rng.createRngState({ seed: Math.floor(rand() * 0x100000000) >>> 0 }).value;
    const tFill = msSince(t2);
    return { state: copy, ms: { clone: tClone, derive: tDerive, fill: tFill, total: msSince(t0) }, plan };
  }

  return { G, DECKLISTS, leanClone, shareClone, visibleCounts, hiddenSlots, determinize, serialOf };
}
