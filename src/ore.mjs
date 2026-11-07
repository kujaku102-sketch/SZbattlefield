// Ore: what a teacher CPU decided, written down for a distiller to learn from (forgehammer). Harness side only (a CPU never sees this).
//
//   node src/run.mjs ... --record <dir>     one file per worker process: <dir>/ore-<tag>.jsonl.gz
//
// The file is a sequence of gzip members (so a block appended after a stop or a kill never spoils what is there), read as JSON lines:
//   line 1 (first member)   { kind: "forge-ore", schema: 1, featureVersion, featureNames, stateNames, game, teacher, ... }
//   then, for every match, a block:
//     { "job", "seed", "seat", "rev", "turn", "s": [state features], "c": [candidate 0, candidate 1, ...], "t": [teacher value or null, ...],
//       "k": chosen candidate index or null, "why": "own" | "no-gain" | "no-supported-move" }       one line per decision of a seat that has a sim
//     { "match": true, "job", "seed", "decks", "firstSeat", "status", "outcome", "turns", "decisions": n, "sha256": hash of the decision lines }
// A candidate is sparse: [[feature index, value], ...] (a zero is not written; values to 4 significant digits). Candidate i is move i of
// the decision (the sim's move ids are 0..n-1). A block without its closing "match" line is not read. The format is described again, from the
// reader's side, in forgehammer: docs/ORE-FORMAT.md.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { decisionFeatures, FEATURE_VERSION, STATE_NAMES, CAND_NAMES } from '../cpus/learned/features.mjs';

export const ORE_SCHEMA = 1;
const sig = (value) => (value === 0 ? 0 : Number(Number(value).toPrecision(4)));
const sparse = (vector) => { const pairs = []; for (let i = 0; i < vector.length; i += 1) if (vector[i] !== 0) pairs.push([i, sig(vector[i])]); return pairs; };

export function oreHeader(extra = {}) {
  return { kind: 'forge-ore', schema: ORE_SCHEMA, featureVersion: FEATURE_VERSION, featureNames: [...CAND_NAMES], stateNames: [...STATE_NAMES], ...extra };
}

// Appends one block (an array of JSON lines) to this process's file; the header goes first when the file is new.
export function appendOreBlock(dir, tag, header, lines) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ore-${tag}.jsonl.gz`);
  if (!existsSync(file)) appendFileSync(file, gzipSync(`${JSON.stringify(header)}\n`));
  appendFileSync(file, gzipSync(`${lines.join('\n')}\n`));
}

// One decision of a seat that had a sim, after its CPU has chosen. Returns a JSON line, or null when there is nothing to learn from
// (no candidate, or the same decision asked again).
//   sim      the decision the CPU was given (src/sim-host.mjs)      cpu   the CPU object (its lastDecision, when it keeps one)
//   intent   what the CPU returned                                    meta  { job, seed, seat, rev, turn }
//   timing   (candidates, ms) => void: how long the features took (the state is already there: determinizing is not counted)
//   check    true: compute the features on a second determinized state too and stop if they differ (a feature that reads what the seat cannot see)
export function recordDecision({ sim, cpu, intent, meta, check = false, note = () => {}, timing = null }) {
  if (!sim || (sim.moves.length === 0 && (sim.unsupported ?? []).length === 0)) return null;
  const last = cpu.lastDecision ?? null;
  if (last?.kind === 'baseline' && !['no-gain', 'no-supported-move'].includes(last.why)) return null;
  const unsupported = sim.unsupported ?? [];
  const state0 = sim.now(0);
  const t0 = process.hrtime.bigint();
  const features = decisionFeatures(state0, sim.me, sim.moves, unsupported);
  if (timing) timing(features.cands.length, Number(process.hrtime.bigint() - t0) / 1e6);
  if (check && sim.samples > 1) {
    const other = decisionFeatures(sim.now(1), sim.me, sim.moves, unsupported);
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    if (!same(features.state, other.state) || features.cands.some((c, i) => !same(c, other.cands[i]))) {
      note('feature_depends_on_hidden', { rev: meta.rev });
    }
  }
  let k = null;
  let why = last?.why ?? 'unknown';
  if (last?.kind === 'own') k = last.moveId;
  else if (intent?.ok) {
    // the teacher's move came from the current CPU: find the candidate that is the same action
    const wanted = JSON.stringify(intent.value.action);
    const found = sim.moves.find((move) => JSON.stringify(sim.intent(move.id, { commandId: intent.value.commandId, expectedRevision: intent.value.expectedRevision })?.action) === wanted);
    // an action the list has no move for was the game's own CPU's choice: it is the "let the game's CPU decide" candidate, when there is one
    k = found ? found.id : unsupported.length > 0 ? sim.moves.length : null;
    if (!found) why = `${why}:${k === null ? 'unmapped' : 'baseline'}`;
  }
  const t = features.cands.map((_, i) => { const g = i < sim.moves.length ? last?.gains?.find((item) => item.id === i) : null; return g ? sig(g.value) : null; });
  return JSON.stringify({ ...meta, s: Array.from(features.state, sig), c: features.cands.map(sparse), t, k, why });
}

export function matchLine(result, decisionLines) {
  return JSON.stringify({
    match: true, job: result.job, seed: result.seed, decks: result.decks, firstSeat: result.firstSeat, status: result.status, outcome: result.outcome, turns: result.turns,
    decisions: decisionLines.length, sha256: createHash('sha256').update(decisionLines.join('\n')).digest('hex')
  });
}
