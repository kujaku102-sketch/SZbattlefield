// Stage 1, first question: how long does it take to try ONE move outside the runtime (no validation, no projection, no references)?
//
//   try one move = copy the engine state -> apply one command to the copy -> read the resulting state
//
// and, so that the CPU never looks at what its seat cannot see, the state it tries moves on is a DETERMINIZED one:
//   the seat's own deck order and the opponent's hand, deck order and face-down cards are re-drawn at random from the cards the seat
//   cannot place (opponent's decklist minus the cards it has seen), and the random generator is re-seeded.
// The pool is computed from the seat's query (what it sees) and the deck lists; the real hidden cards are read only by the CHECK
// (to prove the pool is the right one), never by the filling.
//
//   node probe/probe.mjs --games 49 --out cpu-bench-out/probe [--positions 12] [--reps 3] [--commit <sha>]
//
// Positions are taken from games played by the current CPU (the same table as cpu-bench), before one command of the match.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveGameDir, describeGame } from '../src/game-dir.mjs';
import { loadCpu } from '../cpus/index.mjs';
import { playGame, startDeckIds } from '../src/play.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, index, all) => {
  if (token.startsWith('--')) pairs.push([token.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true]);
  return pairs;
}, []));
const outDir = path.resolve(args.out ?? 'cpu-bench-out/probe');
const gameCount = Number(args.games ?? 49);
const perGame = Number(args.positions ?? 12);
const reps = Number(args.reps ?? 3);
const gameDir = resolveGameDir(typeof args.commit === 'string' ? args.commit : null);
const SEATS = ['seat-a', 'seat-b'];

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
  decks: await imp('src/data/start-decks.js')
};
const DECKLISTS = Object.fromEntries(G.decks.START_DECKS.map((deck) => [deck.id, deck.cards]));

const now = () => process.hrtime.bigint();
const msSince = (t) => Number(now() - t) / 1e6;

// ---- the copy of the engine state used for trying moves. Same as the engine's own copy for history, without the parts a
// try never needs (the log, the event list, the history). Whether that changes any result is checked, not assumed.
function leanClone(state) {
  const rng = state.rng;
  const copy = structuredClone({ ...state, rng: null, history: [], log: [], events: [] });
  copy.rng = copy.runtimeContext ? G.shared.runtimeRng(copy.runtimeContext) : rng;
  return copy;
}

// ---- determinization -------------------------------------------------------------------------------------------
// Cards a seat has seen, by owner: every card object of the query that carries a definition (own hand, both boards, registries,
// trashes, bans, and what lies under or on them), once per cardRef.
function visibleCounts(observation) {
  const counts = { 'seat-a': {}, 'seat-b': {} };
  const seen = new Set();
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (typeof value.cardRef === 'string' && value.definition?.id) {
      if (seen.has(value.cardRef)) return;
      seen.add(value.cardRef);
      const owner = value.ownerSeat ?? value.controllerSeat;
      if (counts[owner]) counts[owner][value.definition.id] = (counts[owner][value.definition.id] ?? 0) + 1;
    }
    for (const item of Object.values(value)) walk(item);
  };
  for (const seat of observation.seats) walk(seat);
  return counts;
}

let simSerial = 0;
function simCard(id, owner, ownerSeat) {
  simSerial += 1;
  return { ...G.cards.createCardInstance(id, owner, simSerial), uid: `sim:${simSerial}`, ownerSeat };
}

// Returns { state, ms: { clone, derive, fill, total }, check } where check compares the pool with the real hidden cards.
function determinize(engine, viewerPlayer, observation, seatIds, deckIds, rand) {
  const t0 = now();
  const copy = leanClone(engine);
  const tClone = msSince(t0);

  const t1 = now();
  const visible = visibleCounts(observation);
  const owners = [['player', seatIds[0], deckIds.player], ['ai', seatIds[1], deckIds.ai]];
  const plan = owners.map(([player, seat, deckId]) => {
    const pool = [];
    const list = DECKLISTS[deckId] ?? {};
    for (const [id, copies] of Object.entries(list)) {
      const left = copies - (visible[seat][id] ?? 0);
      for (let i = 0; i < left; i += 1) pool.push(id);
    }
    // Slots that are hidden from the viewer: the deck always; for the opponent also the hand and the face-down cards on the board.
    const slots = [];
    const holder = copy.players[player];
    holder.deck.forEach((_, index) => slots.push({ zone: 'deck', index }));
    if (player !== viewerPlayer) {
      holder.hand.forEach((_, index) => slots.push({ zone: 'hand', index }));
      for (const zone of ['front', 'back']) holder[zone].forEach((card, index) => { if (card.faceDown === true) slots.push({ zone, index }); });
    }
    return { player, seat, pool, slots };
  });
  const tDerive = msSince(t1);

  const t2 = now();
  for (const { player, seat, pool, slots } of plan) {
    // Fisher-Yates with the CPU's own generator
    for (let i = pool.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const holder = copy.players[player];
    // The decklist minus the seen cards does not always explain every hidden slot (cards an effect created look like deck cards; see the
    // pool check). A slot the pool cannot fill gets a card drawn from the decklist: a real hidden card is never left in place.
    const list = Object.entries(DECKLISTS[deckIds[player]] ?? {});
    const listTotal = list.reduce((n, [, copies]) => n + copies, 0);
    const drawFromList = () => { let at = Math.floor(rand() * listTotal); for (const [id, copies] of list) { if (at < copies) return id; at -= copies; } return list[0][0]; };
    slots.forEach((slot, n) => {
      const id = pool[n] ?? drawFromList();
      const fresh = simCard(id, player, seat);
      if (slot.zone === 'deck') holder.deck[slot.index] = fresh;
      else if (slot.zone === 'hand') holder.hand[slot.index] = G.prepare.hydrateCard(fresh);
      else {
        const old = holder[slot.zone][slot.index];
        holder[slot.zone][slot.index] = { ...G.prepare.hydrateCard(fresh), faceDown: true, sleep: old.sleep, summoningSick: old.summoningSick,
          residentActive: old.residentActive, layerRole: old.layerRole, slot: old.slot, placementOrder: old.placementOrder };
      }
    });
  }
  if (copy.runtimeContext) copy.runtimeContext.rngState = G.rng.createRngState({ seed: Math.floor(rand() * 0x100000000) >>> 0 }).value;
  const tFill = msSince(t2);

  // CHECK (not part of the CPU's work): is the pool the multiset of the real hidden cards of that owner, and did no real hidden card object survive?
  const check = { poolMatches: true, mismatches: [], leaked: 0, slotCount: 0, poolCount: 0 };
  for (const { player, pool, slots } of plan) {
    const real = engine.players[player];
    const hiddenReal = [...real.deck.map((c) => c.id)];
    if (player !== viewerPlayer) {
      hiddenReal.push(...real.hand.map((c) => c.id));
      for (const zone of ['front', 'back']) for (const c of real[zone]) if (c.faceDown === true) hiddenReal.push(c.id);
    }
    const a = [...pool].sort().join(','); const b = hiddenReal.sort().join(',');
    check.slotCount += slots.length; check.poolCount += pool.length;
    if (a !== b) {
      check.poolMatches = false;
      const count = (list) => list.reduce((m, id) => ({ ...m, [id]: (m[id] ?? 0) + 1 }), {});
      const p = count(pool); const h = count(hiddenReal); const diff = {};
      for (const id of new Set([...Object.keys(p), ...Object.keys(h)])) if ((p[id] ?? 0) !== (h[id] ?? 0)) diff[id] = (p[id] ?? 0) - (h[id] ?? 0);
      check.mismatches.push({ player, pool: pool.length, hidden: hiddenReal.length, diff });
    }
    const hiddenOf = (zones) => [...zones.deck, ...(player !== viewerPlayer ? [...zones.hand, ...zones.front.filter((c) => c.faceDown), ...zones.back.filter((c) => c.faceDown)] : [])];
    const realUids = new Set(hiddenOf(real).map((c) => c.uid));
    const cp = copy.players[player];
    for (const card of hiddenOf(cp)) if (realUids.has(card.uid)) check.leaked += 1;
  }
  return { state: copy, ms: { clone: tClone, derive: tDerive, fill: tFill, total: msSince(t0) }, check };
}

// ---- one position ------------------------------------------------------------------------------------------------
const round = (v) => Math.round(v * 1000) / 1000;
// the engine names a choice request with the clock (SEL-<number>): two applications of the same move differ in it, so it is masked
const strip = (state) => JSON.stringify({ ...state, rng: null, history: null, log: null, events: null }).replace(/SEL-\d+/g, 'SEL-#');

function probe(authority, command, seat, meta, rand) {
  const engine = authority.engineState;
  const viewerPlayer = seat === authority.metadata.seatIds[0] ? 'player' : 'ai';
  const result = { ...meta, seat, action: command.action.type, ms: {}, kinds: {}, checks: {} };
  const t0 = now();
  const context = { matchId: authority.metadata.matchId, actorSeat: seat };
  // as the transaction does: actions that read no references get the authority without its reference state
  const base = { metadata: authority.metadata, revision: authority.revision, engineState: authority.engineState, journal: authority.journal };
  let prepared = G.bridge.prepareRuntimeCommand(authority, context, command, {});
  if (!prepared.ok && prepared.error.code === 'INVALID_AUTHORITY') prepared = G.bridge.prepareRuntimeCommand(base, context, command, {});
  result.ms.prepare = round(msSince(t0));
  if (!prepared.ok) { result.skipped = `prepare:${prepared.error.code}`; return result; }
  if (prepared.value.kind === 'retry') { result.skipped = 'retry'; return result; }
  const adapter = prepared.value.adapter;
  if (G.actions.classifyPreparedRuntimeAction(adapter).value?.kind !== 'supported') { result.skipped = 'unsupported'; return result; }
  const runtime = { metadata: authority.metadata, referenceState: authority.referenceState };
  const apply = (state) => { const t = now(); const r = G.actions.applyPreparedRuntimeAction(state, adapter, runtime); return [r, msSince(t)]; };

  result.size = { log: engine.log.length, events: engine.events.length, hand: engine.players[viewerPlayer].hand.length,
    deck: engine.players[viewerPlayer].deck.length, board: ['front', 'back', 'registry', 'trash', 'ban'].reduce((n, z) => n + engine.players.player[z].length + engine.players.ai[z].length, 0),
    turn: engine.turnNumber, pending: engine.pending !== null || engine.prompt !== null };

  // (1) the engine's own copy and one move on it (the real state: for the cost of the move itself, not allowed for a CPU)
  const full = { clone: [], apply: [] }; let firstFull = null;
  for (let i = 0; i < reps; i += 1) {
    const t = now(); const c = G.engine.cloneForHistory(engine); full.clone.push(msSince(t));
    const [r, ms] = apply(c); full.apply.push(ms);
    if (i === 0) { firstFull = { state: c, kind: r.ok ? r.value.kind : `error:${r.error?.code}` }; }
  }
  result.ms.cloneFull = full.clone.map(round); result.ms.applyFull = full.apply.map(round); result.kinds.full = firstFull.kind;

  // (2) the lean copy; the same move must give the same state (except the log and the events)
  const lean = { clone: [], apply: [] }; let firstLean = null;
  for (let i = 0; i < reps; i += 1) {
    const t = now(); const c = leanClone(engine); lean.clone.push(msSince(t));
    const [r, ms] = apply(c); lean.apply.push(ms);
    if (i === 0) firstLean = { state: c, kind: r.ok ? r.value.kind : `error:${r.error?.code}` };
  }
  result.ms.cloneLean = lean.clone.map(round); result.ms.applyLean = lean.apply.map(round); result.kinds.lean = firstLean.kind;
  result.checks.leanSameAsFull = firstFull.kind === firstLean.kind && strip(firstFull.state) === strip(firstLean.state);
  if (!result.checks.leanSameAsFull) {
    const skip = new Set(['rng', 'history', 'log', 'events']);
    result.checks.leanDiffKeys = Object.keys(firstFull.state).filter((key) => !skip.has(key) && JSON.stringify(firstFull.state[key]) !== JSON.stringify(firstLean.state[key]));
    const paths = [];
    const walk = (x, y, at) => {
      if (paths.length >= 4) return;
      if (x !== null && y !== null && typeof x === 'object' && typeof y === 'object') { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${at}.${k}`); }
      else if (x !== y) paths.push([at, x, y]);
    };
    for (const key of result.checks.leanDiffKeys) walk(firstFull.state[key], firstLean.state[key], key);
    result.checks.leanDiffPaths = paths;
  }

  // (3) the determinized state, built from the seat's own view; then the same move tried on a copy of it
  const coordinator = G.port.createLocalRuntimeCoordinator({ authority, sessionGeneration: 1 });
  const port = coordinator.value.bind({ seatId: seat }).value;
  const tq = now(); const query = port.query(); result.ms.query = round(msSince(tq));
  result.legal = query.value.legalActions.length;
  const metaStart = authority.metadata.startOptions;
  const deckIds = { player: metaStart.playerDeckId, ai: metaStart.aiDeckId };
  const det = determinize(engine, viewerPlayer, query.value.observation, authority.metadata.seatIds, deckIds, rand);
  result.ms.determinize = { clone: round(det.ms.clone), derive: round(det.ms.derive), fill: round(det.ms.fill), total: round(det.ms.total) };
  result.checks.pool = det.check;
  const detTry = { clone: [], apply: [] }; let kind = null;
  for (let i = 0; i < reps; i += 1) {
    const t = now(); const c = leanClone(det.state); detTry.clone.push(msSince(t));
    const [r, ms] = apply(c); detTry.apply.push(ms);
    if (i === 0) kind = r.ok ? r.value.kind : `error:${r.error?.code}`;
  }
  result.ms.cloneDet = detTry.clone.map(round); result.ms.applyDet = detTry.apply.map(round); result.kinds.det = kind;
  coordinator.value.dispose();

  // (4) where the copy's time goes: each top-level key of the state copied alone (the biggest few)
  const parts = [];
  for (const key of Object.keys(engine)) {
    if (key === 'rng') continue;
    const t = now(); structuredClone(engine[key]); parts.push([key, msSince(t)]);
  }
  parts.sort((a, b) => b[1] - a[1]);
  result.cloneParts = parts.slice(0, 6).map(([key, ms]) => [key, round(ms)]);
  return result;
}

// ---- driver -------------------------------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'positions.jsonl');
const ids = await startDeckIds(gameDir);
const pairs = ids.flatMap((a) => ids.map((b) => [a, b]));
let prng = 12345;
const rand = () => { prng = (Math.imul(prng, 1664525) + 1013904223) >>> 0; return prng / 4294967296; };

writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({
  game: describeGame(gameDir), node: process.version, games: gameCount, positionsPerGame: perGame, reps,
  machine: { cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length, memoryGB: Math.round(os.totalmem() / 2 ** 30 * 10) / 10, platform: `${os.platform()} ${os.release()}` },
  startedAt: new Date().toISOString()
}, null, 2));

const cpu = await (await loadCpu('simple')).create(gameDir);
const done = new Set(existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).game) : []);
for (let g = 0; g < gameCount; g += 1) {
  const [deckA, deckB] = pairs[g % pairs.length];
  const seed = 1 + (g * 7) % 40;
  const id = `probe/${deckA}/${deckB}/${seed}`;
  if (done.has(id)) continue;
  const job = { id, seed, deckA, deckB, cpus: { 'seat-a': 'simple', 'seat-b': 'simple' } };
  const played = await playGame({ gameDir, job, cpus: { 'seat-a': cpu, 'seat-b': cpu }, limits: { maxCommands: 3000, maxWallMs: 900000, idle: 8, keepRecord: true } });
  if (played.status !== 'finished') { console.log(`${id}: ${played.status}, skipped`); continue; }
  const record = played.record;
  // positions: spread over the match; the opening decisions are not positions
  const total = record.commands.length;
  const picks = new Set();
  for (let k = 0; k < perGame; k += 1) {
    const base = Math.floor(total * (k + 0.5) / perGame);
    const jitter = Math.floor((rand() - 0.5) * (total / perGame));
    picks.add(Math.max(0, Math.min(total - 1, base + jitter)));
  }
  let authority = G.authority.createMatchAuthority(structuredClone(record.game)).value;
  let count = 0;
  for (const [index, recorded] of record.commands.entries()) {
    const action = G.record.decodeRecordedAction(authority, recorded.seat, recorded.action);
    if (!action.ok) throw new Error(`decode ${id} ${index}`);
    const { matchId, seatIds } = authority.metadata;
    const bound = G.contract.makeBoundCommand({ contractVersion: 1, matchId, seatId: recorded.seat, seatIds: [...seatIds], sessionGeneration: 1 },
      { commandId: `replay:${index}`, expectedRevision: authority.revision, action: action.value }).value;
    if (picks.has(index) && !['keepOpeningHand', 'openingMulligan'].includes(action.value.type)) {
      const meta = { game: id, index, total, fraction: round(index / total) };
      const positionResult = probe(authority, bound, recorded.seat, meta, rand);
      appendFileSync(outFile, `${JSON.stringify(positionResult)}\n`);
      count += 1;
    }
    const next = G.tx.submitRuntimeCommand(authority, { matchId, actorSeat: recorded.seat }, bound, {});
    if (!next.ok || next.value.kind !== 'accepted') throw new Error(`replay ${id} ${index}`);
    authority = next.value.authority;
  }
  console.log(`${id}: ${total} commands, ${count} positions`);
}
console.log('done');
