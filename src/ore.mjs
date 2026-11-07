// Ore: what a teacher CPU decided, written down for a distiller to learn from (forgehammer). Harness side only (a CPU never sees this).
//
//   node src/run.mjs ... --record <dir>     one file per worker process: <dir>/ore-<tag>.jsonl.gz
//
// The file is a sequence of gzip members (so a block appended after a stop or a kill never spoils what is there), read as JSON lines:
//   line 1 (first member)   { kind: "forge-ore", schema: 1, featureVersion, featureNames, stateNames, game, rules, cpus, ... }
//   then, for every match, a block:
//     { "job", "seed", "seat", "rev", "turn", "s": [state features], "c": [candidate 0, candidate 1, ...], "t": [teacher value or null, ...],
//       "k": chosen candidate index or null, "why": "own" | "no-gain" | "no-supported-move" [":baseline" | ":unmapped"] }      one line per decision of a teacher seat
//     { "match": true, "job", "seed", "decks", "firstSeat", "status", "outcome", "turns", "decisions": n, "sha256": hash of the decision lines }
// A candidate is sparse: [[feature index, value], ...] (a zero is not written; values to 4 significant digits). The candidates and their features are made from the
// seat's query alone (cpus/learned/candidates.mjs, cpus/learned/features.mjs): the same functions the learned CPU runs. When the decision has kinds of action with no
// candidate of their own, one more candidate, at the end, stands for "let the game's own CPU decide". A block without its closing "match" line is not read.
// The format is described again, from the reader's side, in forgehammer: docs/ORE-FORMAT.md.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { decisionFeatures, FEATURE_VERSION, STATE_NAMES, CAND_NAMES } from '../cpus/learned/features.mjs';
import { actionSignature, buildCandidates } from '../cpus/learned/candidates.mjs';

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

// One decision of a teacher seat, after its CPU has chosen. Returns a JSON line, or null when there is nothing to learn from (a window to answer, the same
// decision asked again, no legal action).
//   query / queryAction   the seat's query and the planner of its own port
//   cpu                   the teacher (its lastDecision, when it keeps one: the move it chose and the value it gave each move it tried)
//   sim                   the decision the teacher was given, only to turn the moves it rated into actions (src/sim-host.mjs); may be null
//   intent                what the teacher returned
//   meta                  { job, seed, seat, rev, turn }       timing  ({ planMs, featureMs, candidates }) => void
export function recordDecision({ query, queryAction, cpu, sim = null, intent, meta, timing = null }) {
  if (query.requiredInput !== null) return null;
  const last = cpu.lastDecision ?? null;
  if (last?.kind === 'baseline' && !['no-gain', 'no-supported-move'].includes(last.why)) return null;
  if (!intent?.ok) return null;
  const t0 = process.hrtime.bigint();
  const built = buildCandidates(query, queryAction);
  const t1 = process.hrtime.bigint();
  const features = decisionFeatures(query, built);
  if (timing) timing({ planCalls: built.planCalls, planMs: Number(t1 - t0) / 1e6, featureMs: Number(process.hrtime.bigint() - t1) / 1e6, candidates: features.cands.length });
  if (features.cands.length === 0) return null;
  const index = new Map(built.cands.map((candidate, i) => [candidate.sig, i]));
  // the teacher's action, found among the candidates; an action the candidates have none for was the game's own CPU's choice ("let the game's CPU decide")
  let k = index.get(actionSignature(intent.value.action)) ?? null;
  let why = last?.why ?? 'unknown';
  if (k === null) { k = built.unsupported.length > 0 ? built.cands.length : null; why = `${why}:${k === null ? 'unmapped' : 'baseline'}`; }
  // the value the teacher gave each move it tried, placed on the candidate that makes the same action
  const t = features.cands.map(() => null);
  if (sim && last?.gains) {
    for (const gain of last.gains) {
      const action = sim.intent(gain.id, { commandId: 'x', expectedRevision: query.status.revision })?.action;
      const i = action ? index.get(actionSignature(action)) : undefined;
      if (i !== undefined) t[i] = sig(gain.value);
    }
  }
  return JSON.stringify({ ...meta, s: Array.from(features.state, sig), c: features.cands.map(sparse), t, k, why });
}

export function matchLine(result, decisionLines) {
  return JSON.stringify({
    match: true, job: result.job, seed: result.seed, decks: result.decks, firstSeat: result.firstSeat, status: result.status, outcome: result.outcome, turns: result.turns,
    decisions: decisionLines.length, sha256: createHash('sha256').update(decisionLines.join('\n')).digest('hex')
  });
}
