// Does "decklist minus the cards the seat sees" equal the real hidden cards of the owner, and if not, why?
// (Stage 1, wall 2. src/sim.mjs counts what the seat sees by the rules, own face-down cards included, and leaves effect-made cards out.)
//
// For every position, every owner P and every card id x where the pool and the real hidden slots disagree:
//     diff = pool - hidden = (D - Co) + (HidQ - Fgn) + Other - Hc + T5
//   D     copies of x in P's decklist
//   Co    cards of id x owned by P that came from the deck (serial number up to the size of both decks) and exist anywhere in the real state
//   HidQ  those of them that sit in the OTHER player's hidden slots,  Fgn: deck cards of x, owned by the other player, in P's hidden slots
//   Other those of them outside every zone (in the middle of an effect) or in a place the zone rules do not cover
//   Hc    cards of id x in P's hidden slots that an effect created (serial above the decks') whoever owns them
//   T5    max(0, V - D): the seat has seen more deck copies than the decklist holds
// Terms: T1 = D - Co (deck cards that are in no place of the state), T3 = HidQ - Fgn (cards that changed hands), T4 = Other,
// T6 = -Hc (created cards inside hidden slots), T5. The sum must equal diff in every case (checked).
// Also checked: the rule-based count of what the seat sees equals what its query shows plus its own face-down cards (observationAgrees).
//
//   node probe/diagnose-pool.mjs --games 49 --out <dir> [--commit <sha>] [--cache <dir>]
import path from 'node:path';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolveGameDir, describeGame } from '../src/game-dir.mjs';
import { loadSim } from '../src/sim.mjs';
import { positions } from './positions.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, index, all) => {
  if (token.startsWith('--')) pairs.push([token.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true]);
  return pairs;
}, []));
const outDir = path.resolve(args.out ?? 'cpu-bench-out/diagnose-pool');
const gameDir = resolveGameDir(typeof args.commit === 'string' ? args.commit : null);
const sim = await loadSim(gameDir);
const { G } = sim;
const isCard = (v) => v !== null && typeof v === 'object' && typeof v.uid === 'string' && typeof v.id === 'string' && typeof v.category === 'string';
let rand = 1; const r = () => { rand = (Math.imul(rand, 1664525) + 1013904223) >>> 0; return rand / 4294967296; };

// Every card of the real state with where it is: { card, holder, zone | inflight, nested }
function census(engine) {
  const found = new Map();
  const add = (card, place) => { if (!found.has(card.uid)) found.set(card.uid, { card, ...place }); };
  const seen = new Set();
  const inside = (card, place) => {
    for (const [key, value] of Object.entries(card)) {
      if (key === 'compiled' || value === null || typeof value !== 'object') continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        if (isCard(item) && !seen.has(item)) { seen.add(item); const nested = `${place.nested ? `${place.nested}>` : ''}${key}`; add(item, { ...place, nested }); inside(item, { ...place, nested }); }
      }
    }
  };
  for (const [holder, player] of Object.entries(engine.players)) {
    for (const [zone, list] of Object.entries(player)) {
      if (!Array.isArray(list)) continue;
      for (const card of list) if (isCard(card)) { seen.add(card); add(card, { holder, zone }); }
    }
  }
  for (const [holder, player] of Object.entries(engine.players)) for (const [zone, list] of Object.entries(player)) if (Array.isArray(list)) for (const card of list) if (isCard(card)) inside(card, { holder, zone });
  const guard = new Set();
  const walk = (value, key) => {
    if (value === null || typeof value !== 'object' || guard.has(value)) return;
    guard.add(value);
    if (isCard(value)) { add(value, { holder: null, zone: null, inflight: key }); return; }
    for (const v of Object.values(value)) walk(v, key);
  };
  for (const [key, value] of Object.entries(engine)) {
    if (['players', 'runtimeContext', 'log', 'events', 'history', 'rng'].includes(key)) continue;
    walk(value, key);
  }
  return [...found.values()];
}

const label = (c) => c.inflight ? `in-flight:${c.inflight}` : c.nested ? `${c.holder}.${c.zone}>${c.nested}` : `${c.holder}.${c.zone}`;

// what the query shows of each owner's cards, by id (cardRef counted once)
function observedCounts(observation) {
  const counts = { 'seat-a': {}, 'seat-b': {} }; const seen = new Set();
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (typeof value.cardRef === 'string' && value.definition?.id) {
      if (seen.has(value.cardRef)) return; seen.add(value.cardRef);
      const owner = value.ownerSeat ?? value.controllerSeat;
      if (counts[owner]) counts[owner][value.definition.id] = (counts[owner][value.definition.id] ?? 0) + 1;
    }
    Object.values(value).forEach(walk);
  };
  observation.seats.forEach(walk);
  return counts;
}

function diagnose(position) {
  const { authority, seat } = position;
  const engine = authority.engineState;
  const seatIds = authority.metadata.seatIds;
  const viewer = seat === seatIds[0] ? 'player' : 'ai';
  const port = G.port.createLocalRuntimeCoordinator({ authority, sessionGeneration: 1 }).value.bind({ seatId: seat }).value;
  const observation = port.query().value.observation;
  const startOptions = authority.metadata.startOptions;
  const deckIds = { player: startOptions.playerDeckId, ai: startOptions.aiDeckId };
  const seatOf = { player: seatIds[0], ai: seatIds[1] };
  const det = sim.determinize(engine, viewer, seatIds, deckIds, r);
  const deckLimit = ['player', 'ai'].reduce((n, p) => n + Object.values(sim.DECKLISTS[deckIds[p]] ?? {}).reduce((a, b) => a + b, 0), 0);
  const cards = census(engine);
  const isDeck = (c) => sim.serialOf(c.card) <= deckLimit;
  const out = { game: position.game, index: position.index, fraction: position.fraction, viewer, terms: [], observationAgrees: true, observationDiffs: [] };

  // zone rules for the viewer: 'visible', 'hidden:<holder>' (a hidden slot of that holder), or 'other'
  const rule = (c) => {
    if (c.inflight) return 'other';
    if (c.nested) return (c.zone === 'deck' || (c.zone === 'hand' && c.holder !== viewer) || (c.card.faceDown && c.holder !== viewer)) ? 'other' : 'visible';
    if (c.zone === 'deck') return `hidden:${c.holder}`;
    if (c.zone === 'hand') return c.holder === viewer ? 'visible' : `hidden:${c.holder}`;
    if (['front', 'back', 'registry', 'trash', 'ban'].includes(c.zone)) return c.card.faceDown === true && c.holder !== viewer ? `hidden:${c.holder}` : 'visible';
    return 'other';
  };

  // the rule-based count of what the seat sees (all cards, created ones too) against what its query shows + its own face-down cards
  const ruleAll = { 'seat-a': {}, 'seat-b': {} };
  for (const c of cards) if (rule(c) === 'visible' && seatOf[c.card.owner]) { const m = ruleAll[seatOf[c.card.owner]]; m[c.card.id] = (m[c.card.id] ?? 0) + 1; }
  const observed = observedCounts(observation);
  for (const c of cards) if (!c.inflight && !c.nested && c.card.faceDown === true && c.holder === viewer && seatOf[c.card.owner]) { const m = observed[seatOf[c.card.owner]]; m[c.card.id] = (m[c.card.id] ?? 0) + 1; }
  for (const sId of seatIds) for (const id of new Set([...Object.keys(ruleAll[sId]), ...Object.keys(observed[sId])])) {
    if ((ruleAll[sId][id] ?? 0) !== (observed[sId][id] ?? 0)) { out.observationAgrees = false; out.observationDiffs.push({ seat: sId, id, rule: ruleAll[sId][id] ?? 0, observed: observed[sId][id] ?? 0 }); }
  }

  for (const player of ['player', 'ai']) {
    const other = player === 'player' ? 'ai' : 'player';
    const list = sim.DECKLISTS[deckIds[player]] ?? {};
    const pool = det.plan.find((p) => p.player === player).pool;
    const hiddenHeld = sim.hiddenSlots(engine, viewer, player).map(({ zone, index }) => engine.players[player][zone][index]);
    const count = (items) => items.reduce((m, id) => ({ ...m, [id]: (m[id] ?? 0) + 1 }), {});
    const poolCount = count(pool); const heldCount = count(hiddenHeld.map((c) => c.id));
    for (const x of new Set([...Object.keys(poolCount), ...Object.keys(heldCount)])) {
      const diff = (poolCount[x] ?? 0) - (heldCount[x] ?? 0);
      if (diff === 0) continue;
      const owned = cards.filter((c) => c.card.owner === player && c.card.id === x && isDeck(c));
      const D = list[x] ?? 0; const Co = owned.length;
      const Vo = owned.filter((c) => rule(c) === 'visible').length;
      const HidQ = owned.filter((c) => rule(c) === `hidden:${other}`).length;
      const Fgn = hiddenHeld.filter((c) => c.id === x && c.owner === other && sim.serialOf(c) <= deckLimit).length;
      const Hc = hiddenHeld.filter((c) => c.id === x && sim.serialOf(c) > deckLimit).length;
      const otherCards = owned.filter((c) => rule(c) === 'other');
      const terms = { T1: D - Co, T3: HidQ - Fgn, T4: otherCards.length, T6: -Hc, T5: Math.max(0, Vo - D) };
      out.terms.push({ player, id: x, diff, D, Co, Vo, ...terms, sumOk: terms.T1 + terms.T3 + terms.T4 + terms.T6 + terms.T5 === diff,
        other: otherCards.map(label) });
    }
  }
  out.mismatch = out.terms.length > 0;
  return out;
}

mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'terms.jsonl');
writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({ game: describeGame(gameDir), node: process.version, games: Number(args.games ?? 49), positionsPerGame: Number(args.positions ?? 12) }, null, 2));
const rows = [];
let count = 0;
for await (const position of positions({ sim, gameDir, games: Number(args.games ?? 49), perGame: Number(args.positions ?? 12), cacheDir: typeof args.cache === 'string' ? args.cache : null })) {
  const row = diagnose(position);
  rows.push(row);
  appendFileSync(outFile, `${JSON.stringify(row)}\n`);
  count += 1;
  if (count % 50 === 0) console.log(`${count} positions`);
}

const bad = rows.filter((row) => row.mismatch);
const terms = bad.flatMap((row) => row.terms.map((t) => ({ ...t, game: row.game, index: row.index })));
const tally = (items) => items.reduce((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});
const top = (obj, n = 12) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
const withTerm = (key) => bad.filter((row) => row.terms.some((t) => t[key] !== 0)).length;
const summary = {
  positions: rows.length, mismatching: bad.length, entries: terms.length, sumIdentityHolds: terms.every((t) => t.sumOk),
  positionsWithTerm: { T1_deckCardMissing: withTerm('T1'), T3_changedHands: withTerm('T3'), T4_inFlight: withTerm('T4'), T6_createdInHiddenSlots: withTerm('T6'), T5: withTerm('T5') },
  onlyT4: bad.filter((row) => row.terms.every((t) => t.T1 === 0 && t.T3 === 0 && t.T6 === 0 && t.T5 === 0)).length,
  observationAgreesWithRules: { agree: rows.filter((row) => row.observationAgrees).length, differ: rows.filter((row) => !row.observationAgrees).length,
    examples: rows.filter((row) => !row.observationAgrees).slice(0, 5).map((row) => ({ at: `${row.game}#${row.index}`, diffs: row.observationDiffs.slice(0, 3) })) },
  T4Where: top(tally(terms.flatMap((t) => t.other))), T4Positions: bad.filter((row) => row.terms.some((t) => t.T4 !== 0)).map((row) => `${row.game}#${row.index}`),
  ids: top(tally(terms.map((t) => t.id))), names: Object.fromEntries([...new Set(terms.map((t) => t.id))].map((id) => [id, G.cards.CARD_LIBRARY[id]?.name ?? null]))
};
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
