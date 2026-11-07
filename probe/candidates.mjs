// Are the candidate moves made straight from an engine state (src/candidates.mjs) the same set as the runtime's query.legalActions?
// Checked on the real engine state of each position, and on the determinized state the CPU would try moves on.
// Both sets are compared as (kind, action type, the cards it names, readiness); the engine-side names are uids and are mapped to the
// runtime's cardRefs with the runtime's own lookup (a comparison tool may do that; a CPU never sees either).
//
//   node probe/candidates.mjs --games 49 --out <dir> [--commit <sha>] [--cache <dir>]
import path from 'node:path';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveGameDir, describeGame } from '../src/game-dir.mjs';
import { loadSim } from '../src/sim.mjs';
import { loadCandidates } from '../src/candidates.mjs';
import { loadMoves } from '../src/moves.mjs';
import { positions } from './positions.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, index, all) => {
  if (token.startsWith('--')) pairs.push([token.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true]);
  return pairs;
}, []));
const outDir = path.resolve(args.out ?? 'cpu-bench-out/candidates');
const gameDir = resolveGameDir(typeof args.commit === 'string' ? args.commit : null);
const sim = await loadSim(gameDir);
const cand = await loadCandidates(gameDir);
const mv = await loadMoves(gameDir);
const { G } = sim;
const runtimeContext = await import(pathToFileURL(path.join(gameDir, 'src/game/runtime/planning-context.js')).href);

const now = () => process.hrtime.bigint();
const msSince = (t) => Number(now() - t) / 1e6;
const round = (v) => Math.round(v * 1000) / 1000;
let prng = 424242;
const rand = () => { prng = (Math.imul(prng, 1664525) + 1013904223) >>> 0; return prng / 4294967296; };

// the comparable form of an entry; `rename` turns an engine uid into the runtime's cardRef
const renamer = (map) => function rename(value) {
  if (typeof value === 'string') return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map(rename);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rename(v)]));
  return value;
};
const keyOf = (entry, rename) => entry.kind === 'fixed' ? `fixed|${JSON.stringify(rename(entry.action))}`
  : `${entry.kind}|${entry.actionType}|${JSON.stringify(rename(entry.base ?? {}))}|${entry.readiness ?? ''}`;
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const COMPLETED = ['attack', 'executeCard', 'setScript', 'redeploy'];
const typeOf = (key) => key.startsWith('fixed|') ? JSON.parse(key.slice(6)).type : key.split('|')[1];

mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'positions.jsonl');
writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({ game: describeGame(gameDir), node: process.version }, null, 2));
const rows = [];
let count = 0;
for await (const position of positions({ sim, gameDir, games: Number(args.games ?? 49), perGame: Number(args.positions ?? 12), cacheDir: typeof args.cache === 'string' ? args.cache : null })) {
  const { authority, seat } = position;
  const engine = authority.engineState;
  const viewerPlayer = seat === authority.metadata.seatIds[0] ? 'player' : 'ai';
  const port = G.port.createLocalRuntimeCoordinator({ authority, sessionGeneration: 1 }).value.bind({ seatId: seat }).value;
  const query = port.query().value;
  // uid -> the runtime's cardRef, for every card the seat can name
  const rc = runtimeContext.createPlanningContext(authority, seat);
  const map = new Map();
  if (rc.allowed) for (const { card } of cand.entriesOf(engine, authority.metadata.seatIds).values()) { const ref = rc.refFor(card); if (ref) map.set(card.uid, ref); }
  const rename = renamer(map);
  const real = new Set(query.legalActions.map((entry) => keyOf(entry, (x) => x)));

  const metadata = authority.metadata;
  // the engine's own checks may write to the state they are given: moves are found on copies, never on the match being replayed
  const t1 = now(); const onReal = cand.catalog(sim.shareClone(engine), metadata, seat); const msReal = msSince(t1);
  const mineReal = new Set(onReal.map((entry) => keyOf(entry, rename)));
  const deckIds = { player: metadata.startOptions.playerDeckId, ai: metadata.startOptions.aiDeckId };
  const det = sim.determinize(engine, viewerPlayer, metadata.seatIds, deckIds, rand);
  const t2 = now(); const onDet = cand.catalog(sim.shareClone(det.state), metadata, seat); const msDet = msSince(t2);
  const mineDet = new Set(onDet.map((entry) => keyOf(entry, rename)));

  // the choices of the moves that need one (where an attack lands, which slot a card takes): the planners on the engine context against the runtime's own planning
  const planned = sim.shareClone(engine);
  const ctx = cand.engineContext(planned, metadata, seat);
  const realByKey = new Map(query.legalActions.map((e) => [keyOf(e, (x) => x), e]));
  const completions = { entries: 0, same: 0, differ: [], runtimeOptionsSkipped: 0 };
  for (const entry of ctx.allowed ? cand.catalog(planned, metadata, seat) : []) {
    if (entry.kind !== 'intent' || !COMPLETED.includes(entry.actionType)) continue;
    const runtimeEntry = realByKey.get(keyOf(entry, rename));
    if (!runtimeEntry) continue;
    const asked = port.queryAction({ expectedRevision: query.status.revision, actionId: runtimeEntry.actionId, selections: [] });
    completions.entries += 1;
    if (!asked.ok) { completions.differ.push({ type: entry.actionType, runtimeError: asked.error?.code }); continue; }
    const options = (asked.value.selectionRequests[0]?.options ?? []).map(({ optionId, label, ...rest }) => rest);
    const kept = options.filter((o) => !o.hostRef && o.zone !== 'registry');
    completions.runtimeOptionsSkipped += options.length - kept.length;
    const runtimeSet = new Set(kept.map((o) => JSON.stringify(sortKeys(o))));
    const mineSet = new Set(mv.expand(ctx, [entry]).moves.map((m) => JSON.stringify(sortKeys(rename(entry.actionType === 'attack' ? m.action.target : m.action.destination)))));
    const onlyRuntime = [...runtimeSet].filter((k) => !mineSet.has(k)); const onlyMine = [...mineSet].filter((k) => !runtimeSet.has(k));
    if (onlyRuntime.length === 0 && onlyMine.length === 0) completions.same += 1; else completions.differ.push({ type: entry.actionType, onlyRuntime: onlyRuntime.slice(0, 3), onlyMine: onlyMine.slice(0, 3) });
  }

  const diff = (a, b) => [...a].filter((k) => !b.has(k));
  const row = {
    game: position.game, index: position.index, seat, requiredInput: query.requiredInput !== null, runtime: real.size,
    real: { n: mineReal.size, onlyRuntime: diff(real, mineReal), onlyMine: diff(mineReal, real), ms: round(msReal) },
    det: { n: mineDet.size, onlyRuntime: diff(real, mineDet), onlyMine: diff(mineDet, real), ms: round(msDet) },
    completions
  };
  rows.push(row);
  appendFileSync(outFile, `${JSON.stringify(row)}\n`);
  count += 1;
  if (count % 50 === 0) console.log(`${count} positions`);
}

// ---- summary
const sameReal = rows.filter((r) => r.real.onlyRuntime.length === 0 && r.real.onlyMine.length === 0);
const sameDet = rows.filter((r) => r.det.onlyRuntime.length === 0 && r.det.onlyMine.length === 0);
const quantile = (list, q) => { const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const group = (which, side) => rows.flatMap((r) => r[which][side].map((k) => typeOf(k))).reduce((m, t) => ({ ...m, [t]: (m[t] ?? 0) + 1 }), {});
const examples = (which, side) => rows.filter((r) => r[which][side].length).slice(0, 5).map((r) => ({ at: `${r.game}#${r.index}`, requiredInput: r.requiredInput, keys: r[which][side].slice(0, 3) }));
const summary = {
  positions: rows.length, runtimeMovesTotal: rows.reduce((n, r) => n + r.runtime, 0),
  onRealState: { identicalSets: sameReal.length, differing: rows.length - sameReal.length, missingFromMine: group('real', 'onlyRuntime'), extraInMine: group('real', 'onlyMine'),
    exampleMissing: examples('real', 'onlyRuntime'), exampleExtra: examples('real', 'onlyMine') },
  onDeterminizedState: { identicalSets: sameDet.length, differing: rows.length - sameDet.length, missingFromMine: group('det', 'onlyRuntime'), extraInMine: group('det', 'onlyMine'),
    exampleMissing: examples('det', 'onlyRuntime'), exampleExtra: examples('det', 'onlyMine') },
  msCatalog: { real: { median: quantile(rows.map((r) => r.real.ms), 0.5), p95: quantile(rows.map((r) => r.real.ms), 0.95), max: Math.max(...rows.map((r) => r.real.ms)) },
    determinized: { median: quantile(rows.map((r) => r.det.ms), 0.5), p95: quantile(rows.map((r) => r.det.ms), 0.95), max: Math.max(...rows.map((r) => r.det.ms)) } },
  withChoiceOpen: rows.filter((r) => r.requiredInput).length,
  completions: { entries: rows.reduce((n, r) => n + r.completions.entries, 0), same: rows.reduce((n, r) => n + r.completions.same, 0),
    differing: rows.reduce((n, r) => n + r.completions.differ.length, 0), runtimeOptionsSkipped: rows.reduce((n, r) => n + r.completions.runtimeOptionsSkipped, 0),
    examples: rows.flatMap((r) => r.completions.differ.map((d) => ({ at: `${r.game}#${r.index}`, ...d }))).slice(0, 8) }
};
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
