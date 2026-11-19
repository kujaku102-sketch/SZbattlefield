// Does the sim answer the windows a move opens (reads=full, src/sim-windows.mjs), and does it do it without touching anything else?
// For each position of the fixed set (probe/positions.mjs), each budget (--budgets, default 0 and 8), each move of the seat and each determinized sample (--samples, default 2; as a CPU sees them):
//   - the state `after(move)` hands out has no window left open, or one that the sim has no engine call for (an allocation, the security rest window): counted by kind;
//   - asking again, in the reverse order of moves and samples, gives the same state (a decision depends only on the state and the parameters: a match replays exactly);
//   - the determinized states are the same after the tries (the sim works on copies). "Same" is the whole state, field by field (rng, log, triggers, flags, counters too), not a hand-picked part;
//   - the same move on the basic reads, settled here with the same budget, is the state the full reads hand out (what the engine leaves open is the same, and the host settles nothing else);
//   - settling never makes more trial copies than the budget, and no window offers more than MAX_ANSWERS answers;
//   - budget 0 is the first answer of each window (the header of src/sim-windows.mjs), walked here without settle's own loop.
// The run fails when a check breaks, and when no window was answered at all for a budget (a run that answers nothing proves nothing).
// Not checked here: that the state is the one the game's CPU (src/adapters/simple-ai-policy.js) reaches. That CPU answers a runtime query, and nothing in the bench builds one
// for a determinized state yet. When it does, compare against chooseSimpleAiIntent only (it is the exported entry point; beta 0.9.1 was read, the bench's game dir may be newer).
// Moves that only the full reads have (a Sp, a card effect, mounting) have no basic twin, so their windows are counted (fullOnly) but not compared.
// It is a probe of the trusted side: the states are determinized ones, nothing is read from the real hidden cards.
//
//   node probe/windows-settle.mjs --games 49 --out <dir> [--budgets 0,8] [--samples 2] [--commit <sha>] [--cache <dir>]
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolveGameDir, describeGame } from '../src/game-dir.mjs';
import { loadSimHost } from '../src/sim-host.mjs';
import { loadWindows, MAX_ANSWERS } from '../src/sim-windows.mjs';
import { positions } from './positions.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, index, all) => {
  if (token.startsWith('--')) pairs.push([token.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true]);
  return pairs;
}, []));
const outDir = path.resolve(args.out ?? 'cpu-bench-out/windows-settle');
const budgets = [...new Set(String(args.budgets ?? '0,8').split(',').map(Number))].filter((b) => Number.isInteger(b) && b >= 0);
if (budgets.length === 0) { console.error('--budgets wants a list of whole numbers, like 0,8'); process.exit(2); }
const sampleCount = Math.max(1, Math.floor(Number(args.samples ?? 2)) || 1);
const gameDir = resolveGameDir(typeof args.commit === 'string' ? args.commit : null);
const host = await loadSimHost(gameDir);
const windows = await loadWindows(gameDir);
const clone = host.sim.shareClone;

// The whole state as text: every field, keys sorted, so two states of the same content are the same text. Functions and cycles are marked, not followed.
const flat = (value, up = new Set()) => {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string') return JSON.stringify(value);
  if (kind === 'number' || kind === 'boolean') return String(value);
  if (kind !== 'object') return JSON.stringify(`[${kind}${kind === 'bigint' ? ` ${value}` : ''}]`);
  if (up.has(value)) return '"[cycle]"';
  up.add(value);
  let out;
  if (value instanceof Map) out = `Map{${[...value].map(([key, item]) => `${flat(key, up)}=>${flat(item, up)}`).join(',')}}`;
  else if (value instanceof Set) out = `Set{${[...value].map((item) => flat(item, up)).join(',')}}`;
  else if (Array.isArray(value)) out = `[${value.map((item) => flat(item, up)).join(',')}]`;
  else out = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${flat(value[key], up)}`).join(',')}}`;
  up.delete(value);
  return out;
};
const digestOf = (text) => createHash('sha1').update(text).digest('hex');
// one digest per top-level field, and per zone of each side, so a failure says what moved
const signature = (state) => {
  const out = {};
  for (const key of Object.keys(state).sort()) {
    if (key === 'players' && state.players && typeof state.players === 'object') {
      for (const who of Object.keys(state.players).sort()) for (const zone of Object.keys(state.players[who]).sort()) out[`players.${who}.${zone}`] = digestOf(flat(state.players[who][zone]));
    } else out[key] = digestOf(flat(state[key]));
  }
  return out;
};
// the fields that differ between two signatures (a refused move is null)
const differ = (a, b) => {
  if (a === null || b === null) return a === b ? [] : ['(refused on one side)'];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => a[key] !== b[key]);
};
const waiting = (state) => state.pending ? `pending:${state.pending.type}${state.pending.request?.spec?.kind === 'allocation' ? ':allocation' : ''}` : state.prompt ? `prompt:${state.prompt.type}` : state.securityRestWindow ? 'security-rest' : null;
// the move as a CPU sees it: the same move on the basic and the full reads has the same tuple (the ids differ)
const tupleOf = (move) => JSON.stringify([move.type, move.uids, move.zone, move.targetKind]);

// Budget 0 as the header of src/sim-windows.mjs says it: the first answer of each window, and a refused first answer stops the walk (it is counted, not compared).
// 12 is MAX_DEPTH of sim-windows (not exported): the walk stops where settle stops.
const firstAnswers = (state) => {
  for (let depth = 0; depth <= 12; depth += 1) {
    if (!windows.open(state)) return { state, refused: false };
    const here = windows.windowOf(state);
    if (!here || here.answers.length === 0) return { state, refused: false };
    let taken = false;
    try { taken = here.answers[0].run(state) === true; } catch { taken = false; }
    if (!taken) return { state, refused: true };
  }
  return { state, refused: false };
};

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({ game: describeGame(gameDir), node: process.version, budgets, samples: sampleCount }, null, 2));
const blank = () => ({ positions: 0, tries: 0, refused: 0, settled: 0, stillOpen: {}, matched: 0, fullOnly: 0, ambiguous: 0, openedBasic: 0, answerable: 0, answered: 0, firstRefused: 0,
  notRepeatable: 0, touched: 0, differentStart: 0, settleMismatch: 0, overBudget: 0, tooManyAnswers: 0, walkMismatch: 0 });
const tallies = Object.fromEntries(budgets.map((b) => [b, blank()]));
const totals = { positions: 0, basicTouched: 0 };
const bad = [];
const note = (budget, position, why, extra = {}) => { if (bad.length < 20) bad.push({ budget, game: position.game, index: position.index, why, ...extra }); };

for await (const position of positions({ sim: host.sim, gameDir, games: Number(args.games ?? 49), perGame: Number(args.positions ?? 12), cacheDir: typeof args.cache === 'string' ? args.cache : null })) {
  const { authority, seat } = position;
  totals.positions += 1;
  const ks = [...Array(sampleCount).keys()];
  const basic = host.open({ authority, seat, samples: sampleCount, reads: 'basic' });
  // samples are drawn in order, so both reads see the same states
  for (const k of ks) basic.now(k);
  const basicStart = ks.map((k) => signature(basic.now(k)));
  const twins = new Map();
  for (const move of basic.moves) twins.set(tupleOf(move), twins.has(tupleOf(move)) ? null : move);

  for (const budget of budgets) {
    const t = tallies[budget];
    t.positions += 1;
    const full = host.open({ authority, seat, samples: sampleCount, reads: { mode: 'full', budget } });
    for (const k of ks) full.now(k);
    const start = ks.map((k) => signature(full.now(k)));
    // what the engine leaves open (before any answer) starts from the same state on both reads
    for (const k of ks) { const apart = differ(start[k], basicStart[k]); if (apart.length) { t.differentStart += 1; note(budget, position, 'basic and full start states differ', { k, fields: apart }); } }

    const moves = full.moves.filter((move) => move.type !== 'endTurn');
    const fullTuples = new Map();
    for (const move of full.moves) fullTuples.set(tupleOf(move), (fullTuples.get(tupleOf(move)) ?? 0) + 1);
    const forward = new Map();
    for (const move of moves) {
      // undefined: no basic twin; null: the tuple is not one move on a side
      const twin = fullTuples.get(tupleOf(move)) === 1 ? twins.get(tupleOf(move)) : null;
      for (const k of ks) {
        t.tries += 1;
        const state = full.after(move.id, k);
        const key = `${move.id}|${k}`;
        forward.set(key, state === null ? null : signature(state));
        if (state === null) t.refused += 1;
        else { const left = waiting(state); if (left === null) t.settled += 1; else t.stillOpen[left] = (t.stillOpen[left] ?? 0) + 1; }
        const moved = differ(signature(full.now(k)), start[k]);
        if (moved.length) { t.touched += 1; note(budget, position, 'start state changed', { type: move.type, k, fields: moved }); }
        if (twin === undefined) { t.fullOnly += 1; continue; }
        if (twin === null) { t.ambiguous += 1; continue; }

        t.matched += 1;
        const raw = basic.after(twin.id, k);
        if (raw === null || state === null) {
          if ((raw === null) !== (state === null)) { t.settleMismatch += 1; note(budget, position, 'refused on one of the reads only', { type: move.type, k }); }
          continue;
        }
        if (windows.open(raw)) t.openedBasic += 1;
        const here = windows.windowOf(clone(raw));
        if (here && here.answers.length > MAX_ANSWERS) { t.tooManyAnswers += 1; note(budget, position, 'window offers more than MAX_ANSWERS', { type: move.type, k, answers: here.answers.length }); }
        const before = here && here.answers.length > 0 ? signature(raw) : null;
        let clones = 0;
        const settled = windows.settle(raw, { me: full.me, budget, clone: (s) => { clones += 1; return clone(s); } });
        if (clones > budget) { t.overBudget += 1; note(budget, position, 'more trial copies than the budget', { type: move.type, k, clones }); }
        const after = signature(settled);
        const apart = differ(after, forward.get(key));
        if (apart.length) { t.settleMismatch += 1; note(budget, position, 'settled basic state is not the full state', { type: move.type, k, fields: apart }); }
        if (before === null) continue;
        t.answerable += 1;
        if (differ(before, after).length) t.answered += 1;
        if (budget === 0) {
          const copy = basic.after(twin.id, k);
          if (copy !== null) {
            const walked = firstAnswers(copy);
            if (walked.refused) t.firstRefused += 1;
            else { const off = differ(signature(walked.state), after); if (off.length) { t.walkMismatch += 1; note(budget, position, 'budget 0 is not the first answer walk', { type: move.type, k, fields: off }); } }
          }
        }
      }
    }
    // the same calls again, the other way round: a decision does not depend on what was asked before
    for (const move of [...moves].reverse()) {
      for (const k of [...ks].reverse()) {
        const state = full.after(move.id, k);
        const apart = differ(state === null ? null : signature(state), forward.get(`${move.id}|${k}`));
        if (apart.length) { t.notRepeatable += 1; note(budget, position, 'not repeatable (reverse order)', { type: move.type, k, fields: apart }); }
      }
    }
    for (const k of ks) {
      const moved = differ(signature(full.now(k)), start[k]);
      if (moved.length) { t.touched += 1; note(budget, position, 'start state changed (after all tries)', { k, fields: moved }); }
    }
  }
  for (const k of ks) {
    const moved = differ(signature(basic.now(k)), basicStart[k]);
    if (moved.length) { totals.basicTouched += 1; note(null, position, 'basic start state changed', { k, fields: moved }); }
  }
}

const failures = [];
if (totals.positions === 0) failures.push('no position was probed');
for (const budget of budgets) if (tallies[budget].answered === 0) failures.push(`budget ${budget}: no window was answered in the whole run`);
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ totals, tallies, mismatches: bad, failures }, null, 2));
console.log(JSON.stringify({ totals, tallies }, null, 1));
if (failures.length) console.log(JSON.stringify(failures, null, 1));
if (bad.length) console.log(JSON.stringify(bad.slice(0, 5), null, 1));
if (bad.length || failures.length) process.exitCode = 1;
