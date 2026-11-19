// Does every move the sim offers (reads=full, src/moves.mjs) do what the runtime does when it is submitted?
// For each position of the fixed set (probe/positions.mjs: the real authority just before a command) and each move found on the REAL engine state (not a determinized one):
//   - the engine route: the move's adapter applied to a copy of the engine state (what sim.after does, before its windows are answered);
//   - the runtime route: the move's action turned into the runtime's own intent (cards named by their references; by the host's intent() when the move is the one the CPU path keeps for its key, the call a CPU's choice goes through) and submitted to the runtime (submitRuntimeCommand).
// Both must be accepted or refused together, and the states they leave must show the same cards in the same places with the same numbers
// (the log, the clock-made ids and the identity ledger are not compared).
// A move that both routes refuse is offered to a CPU and can never be played: it is counted per type and flagged, not passed over.
// The engine state of the position must come out of every move untouched, or the later moves of the position would run on a contaminated state.
// It reads the real state, so it is a probe, never part of a CPU. The checks of the windows (src/sim-windows.mjs) are in probe/windows-settle.mjs.
//
//   node probe/moves-submit.mjs --games 49 --out <dir> [--commit <sha>] [--cache <dir>] [--reads full|basic]
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveGameDir, describeGame } from '../src/game-dir.mjs';
import { loadSim } from '../src/sim.mjs';
import { loadSimHost } from '../src/sim-host.mjs';
import { loadCandidates } from '../src/candidates.mjs';
import { loadMoves } from '../src/moves.mjs';
import { positions } from './positions.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, index, all) => {
  if (token.startsWith('--')) pairs.push([token.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true]);
  return pairs;
}, []));
const outDir = path.resolve(args.out ?? 'cpu-bench-out/moves-submit');
const reads = args.reads === 'basic' ? 'basic' : 'full';
const gameDir = resolveGameDir(typeof args.commit === 'string' ? args.commit : null);
const sim = await loadSim(gameDir);
const cand = await loadCandidates(gameDir);
const mv = await loadMoves(gameDir);
const host = await loadSimHost(gameDir);
const { G } = sim;
const planning = await import(pathToFileURL(path.join(gameDir, 'src/game/runtime/planning-context.js')).href);

// what the two routes must agree on: the cards of every zone with their numbers, the memory and the fortress, who has won, the delayed effects and the trigger thread, what is waiting
const card = (c) => [c.uid, c.id, c.faceDown === true, c.sleep === true, c.summoningSick === true, c.atk, c.str, c.damage ?? 0, c.tempAtk ?? 0, c.tempStr ?? 0, c.permanentAtk ?? 0, c.permanentStr ?? 0, (c.mounted ?? []).map(card)];
const signature = (state) => JSON.stringify({
  players: ['player', 'ai'].map((who) => { const p = state.players[who]; return { memory: p.memory, fortress: p.fortressStr, zones: ['deck', 'hand', 'front', 'back', 'registry', 'trash', 'ban'].map((z) => p[z].map(card)) }; }),
  active: state.active, turn: state.turnNumber, winner: state.winner ?? null,
  delayed: state.delayedEffects ?? null, thread: state.triggerThread ?? null,
  pending: state.pending ? [state.pending.type, state.pending.request?.label ?? null, state.pending.request?.candidates ?? null] : null, prompt: state.prompt ? state.prompt.type : null
});

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({ game: describeGame(gameDir), node: process.version, reads }, null, 2));
const tally = {}; const bad = []; const refused = [];
const bump = (type, key) => { tally[type] ??= { moves: 0, same: 0, bothRefused: 0, different: 0, runtimeOnly: 0, engineOnly: 0, viaHost: 0, hostUnmatched: 0, contaminated: 0 }; tally[type][key] += 1; };
let count = 0;
for await (const position of positions({ sim, gameDir, games: Number(args.games ?? 49), perGame: Number(args.positions ?? 12), cacheDir: typeof args.cache === 'string' ? args.cache : null })) {
  const { authority, seat } = position;
  const engine = authority.engineState;
  const metadata = authority.metadata;
  const planned = sim.shareClone(engine);
  const context = cand.engineContext(planned, metadata, seat);
  if (!context.allowed) continue;
  const expanded = mv.expand(context, cand.catalog(planned, metadata, seat), { reads });
  const runtime = planning.createPlanningContext(authority, seat);
  if (typeof runtime.refFor !== 'function') continue;     // the runtime offers nothing here (a window is open)
  const refs = new Map();
  for (const { card: c } of cand.entriesOf(engine, metadata.seatIds).values()) { const ref = runtime.refFor(c); if (ref) refs.set(c.uid, ref); }
  const rename = (value) => typeof value === 'string' ? (refs.get(value) ?? value) : Array.isArray(value) ? value.map(rename)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rename(v)])) : value;
  const decision = host.open({ authority, seat, reads });
  const hostIds = new Map();     // key -> the id the CPU path gives the move it keeps for that key (endTurn counts: it is in the list)
  for (const move of expanded.moves) if (!hostIds.has(move.key)) hostIds.set(move.key, hostIds.size);
  const before = signature(engine); const revision = authority.revision;
  const seenKeys = new Set();
  for (const move of expanded.moves) {
    const firstOfKey = !seenKeys.has(move.key); seenKeys.add(move.key);
    if (move.type === 'endTurn') continue;
    bump(move.type, 'moves');
    const hostId = firstOfKey ? hostIds.get(move.key) : undefined;   // a slot variant is not what a CPU would submit: it keeps the probe's own renaming
    const hostMove = hostId === undefined ? null : decision.moves[hostId];
    const aligned = hostMove !== null && hostMove.type === move.type && JSON.stringify(hostMove.uids) === JSON.stringify(move.uids);
    if (firstOfKey && !aligned) bump(move.type, 'hostUnmatched');
    const hostIntent = aligned ? decision.intent(hostId, { commandId: 'probe', expectedRevision: authority.revision }) : null;
    if (hostIntent) bump(move.type, 'viaHost');
    const copy = sim.shareClone(engine);
    const applied = G.actions.applyPreparedRuntimeAction(copy, move.adapter, { metadata, referenceState: authority.referenceState });
    const engineOk = applied.ok && ['applied-complete', 'applied-awaiting-input'].includes(applied.value.kind);
    const bound = G.contract.makeBoundCommand({ contractVersion: 1, matchId: metadata.matchId, seatId: seat, seatIds: [...metadata.seatIds], sessionGeneration: 1 },
      { commandId: 'probe', expectedRevision: authority.revision, action: hostIntent ? hostIntent.action : rename(move.action) });
    const submitted = bound.ok ? G.tx.submitRuntimeCommand(authority, { matchId: metadata.matchId, actorSeat: seat }, bound.value, {}) : bound;
    const runtimeOk = submitted.ok && submitted.value.kind === 'accepted';
    if (signature(engine) !== before || authority.revision !== revision) { bump(move.type, 'contaminated'); if (bad.length < 40) bad.push({ position: position.game, index: position.index, type: move.type, uids: move.uids, contaminated: true }); break; }
    if (!engineOk && !runtimeOk) { bump(move.type, 'bothRefused'); if (refused.length < 40) refused.push({ position: position.game, index: position.index, type: move.type, uids: move.uids, engine: applied.ok ? applied.value.kind : 'refused', runtime: submitted.ok ? submitted.value.kind : submitted.error?.code }); continue; }
    if (engineOk !== runtimeOk) { bump(move.type, engineOk ? 'engineOnly' : 'runtimeOnly'); if (bad.length < 40) bad.push({ position: position.game, index: position.index, type: move.type, uids: move.uids, engineOk, runtimeOk, error: submitted.ok ? submitted.value.kind : submitted.error?.code }); continue; }
    const same = signature(copy) === signature(submitted.value.authority.engineState);
    bump(move.type, same ? 'same' : 'different');
    if (!same && bad.length < 40) bad.push({ position: position.game, index: position.index, type: move.type, uids: move.uids, engine: signature(copy).slice(0, 400), runtime: signature(submitted.value.authority.engineState).slice(0, 400) });
  }
  count += 1;
  if (count % 50 === 0) console.log(`${count} positions`);
}
const refusedTypes = Object.fromEntries(Object.entries(tally).filter(([, t]) => t.bothRefused).map(([type, t]) => [type, t.bothRefused]));
const summary = { positions: count, reads, tally, bothRefused: refusedTypes, refused, mismatches: bad };
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ positions: count, reads, tally }, null, 1));
// offered but refused by both routes: the routes agree, so the run does not fail, but it is never silent
if (Object.keys(refusedTypes).length) { console.log(`FLAG: moves offered by the sim but refused by the engine and the runtime, per type: ${JSON.stringify(refusedTypes)} (first 5):`); console.log(JSON.stringify(refused.slice(0, 5), null, 1)); }
if (bad.length) { console.log(`${bad.length} mismatches (first 5):`); console.log(JSON.stringify(bad.slice(0, 5), null, 1)); process.exitCode = 1; }
