// Stage 1, first question: how long does it take to try ONE move outside the runtime (no validation, no projection, no references)?
//
//   try one move = copy the engine state -> apply one command to the copy -> read the resulting state
//
// and, so that the CPU never looks at what its seat cannot see, the state it tries moves on is a DETERMINIZED one (src/sim.mjs):
// the seat's own deck order and the opponent's hand, deck order and face-down cards are re-drawn at random from the cards the seat
// cannot place (decklist minus the cards it has seen), and the random generator is re-seeded.
// The pool is computed from the seat's query (what it sees) and the deck lists; the real hidden cards are read only by the CHECK
// (probe/checks.mjs), never by the filling.
//
//   node probe/probe.mjs --games 49 --out cpu-bench-out/probe [--positions 12] [--reps 3] [--commit <sha>] [--cache <dir>]
//
// Positions: see probe/positions.mjs.
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolveGameDir, describeGame } from '../src/game-dir.mjs';
import { loadSim } from '../src/sim.mjs';
import { positions } from './positions.mjs';
import { poolCheck } from './checks.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, index, all) => {
  if (token.startsWith('--')) pairs.push([token.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true]);
  return pairs;
}, []));
const outDir = path.resolve(args.out ?? 'cpu-bench-out/probe');
const gameCount = Number(args.games ?? 49);
const perGame = Number(args.positions ?? 12);
const reps = Number(args.reps ?? 3);
const gameDir = resolveGameDir(typeof args.commit === 'string' ? args.commit : null);
const sim = await loadSim(gameDir);
const { G } = sim;

const now = () => process.hrtime.bigint();
const msSince = (t) => Number(now() - t) / 1e6;
const round = (v) => Math.round(v * 1000) / 1000;
// the engine names a choice request with the clock (SEL-<number>): two applications of the same move differ in it, so it is masked
const strip = (state) => JSON.stringify({ ...state, rng: null, history: null, log: null, events: null }).replace(/SEL-\d+/g, 'SEL-#');

let prng = 12345;
const rand = () => { prng = (Math.imul(prng, 1664525) + 1013904223) >>> 0; return prng / 4294967296; };

function probe({ authority, command, seat, game, index, total, fraction }) {
  const engine = authority.engineState;
  const viewerPlayer = seat === authority.metadata.seatIds[0] ? 'player' : 'ai';
  const result = { game, index, total, fraction, seat, action: command.action.type, ms: {}, kinds: {}, checks: {} };
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
    const t = now(); const c = sim.leanClone(engine); lean.clone.push(msSince(t));
    const [r, ms] = apply(c); lean.apply.push(ms);
    if (i === 0) firstLean = { state: c, kind: r.ok ? r.value.kind : `error:${r.error?.code}` };
  }
  result.ms.cloneLean = lean.clone.map(round); result.ms.applyLean = lean.apply.map(round); result.kinds.lean = firstLean.kind;
  result.checks.leanSameAsFull = firstFull.kind === firstLean.kind && strip(firstFull.state) === strip(firstLean.state);

  // (2b) the copy that shares the cards' compiled effects (src/sim.mjs shareClone): same state after the same move, and cheaper
  const share = { clone: [], apply: [] }; let firstShare = null;
  for (let i = 0; i < reps; i += 1) {
    const t = now(); const c = sim.shareClone(engine); share.clone.push(msSince(t));
    const [r, ms] = apply(c); share.apply.push(ms);
    if (i === 0) firstShare = { state: c, kind: r.ok ? r.value.kind : `error:${r.error?.code}` };
  }
  result.ms.cloneShare = share.clone.map(round); result.ms.applyShare = share.apply.map(round);
  result.checks.shareSameAsFull = firstFull.kind === firstShare.kind && strip(firstFull.state) === strip(firstShare.state);

  // (3) the determinized state, built from the seat's own view; then the same move tried on a copy of it
  const coordinator = G.port.createLocalRuntimeCoordinator({ authority, sessionGeneration: 1 });
  const port = coordinator.value.bind({ seatId: seat }).value;
  const tq = now(); const query = port.query(); result.ms.query = round(msSince(tq));
  result.legal = query.value.legalActions.length;
  const metaStart = authority.metadata.startOptions;
  const deckIds = { player: metaStart.playerDeckId, ai: metaStart.aiDeckId };
  const det = sim.determinize(engine, viewerPlayer, authority.metadata.seatIds, deckIds, rand);
  result.ms.determinize = { clone: round(det.ms.clone), derive: round(det.ms.derive), fill: round(det.ms.fill), total: round(det.ms.total) };
  result.checks.pool = poolCheck(sim, engine, viewerPlayer, det);
  const detTry = { clone: [], apply: [] }; let kind = null;
  for (let i = 0; i < reps; i += 1) {
    const t = now(); const c = sim.shareClone(det.state); detTry.clone.push(msSince(t));
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

mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'positions.jsonl');
writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({
  game: describeGame(gameDir), node: process.version, games: gameCount, positionsPerGame: perGame, reps,
  machine: { cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length, memoryGB: Math.round(os.totalmem() / 2 ** 30 * 10) / 10, platform: `${os.platform()} ${os.release()}` },
  startedAt: new Date().toISOString()
}, null, 2));

let count = 0;
for await (const position of positions({ sim, gameDir, games: gameCount, perGame, cacheDir: typeof args.cache === 'string' ? args.cache : null })) {
  appendFileSync(outFile, `${JSON.stringify(probe(position))}\n`);
  count += 1;
  if (count % 50 === 0) console.log(`${count} positions`);
}
console.log(`done: ${count} positions`);
