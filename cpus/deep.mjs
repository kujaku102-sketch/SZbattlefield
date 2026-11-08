// CPU: reads further than one move (a teacher for the learned CPU; it takes time, 100 ms to a few seconds a move).
//
// Like cpus/lookahead.mjs it works on determinized states only (the seat's view with everything it cannot see re-drawn at random, K ways), and plays through the harness's sim.
// Where lookahead evaluates the state right after a move, this plays each of the best few moves out:
//   the move, then the rest of the seat's own turn (the best move by the evaluation after it, up to `own` more moves, while one gains), the end of the turn,
//   then the other side's turn (its move that is worst for the seat by the same evaluation, up to `opp` moves), and evaluates the state when its turn ends.
// The value of a move is that evaluation, averaged over the K determinized states, less the same for ending the turn at once. The best move is played when it is worth more than
// `margin`; else the current CPU's move (view.baseline()), as in lookahead (it also covers the kinds of move the sim has no call for).
//
// Parameters (CPU spec `deep?k=3&top=4&own=4&opp=4&margin=0.01`): k = determinized states, top = how many moves (best by one move of look-ahead) are played out,
// own / opp = the most moves played for each side after the move, margin = the least gain worth a move.
// This file may import only files of this folder (checked when it is loaded).
import { evaluate, DEFAULT_WEIGHTS } from './lookahead/eval.mjs';
import { playout } from './lookahead/playout.mjs';
import { createLoopGuard } from './learned/loopguard.mjs';

const looks = (query) => { const { revision, ...rest } = query.observation ?? {}; return JSON.stringify(rest); };
const clamp = (v) => Math.max(-200, Math.min(200, v));

export default {
  id: 'deep',
  needsSim: true,
  create(gameDir, params = {}) {
    const k = Math.max(1, Number(params.k ?? 3));
    const top = Math.max(1, Number(params.top ?? 4));
    const ownDepth = Math.max(0, Number(params.own ?? 4));
    const oppDepth = Math.max(0, Number(params.opp ?? 4));
    const margin = Number(params.margin ?? 0.01);
    const weights = { ...DEFAULT_WEIGHTS };
    for (const [key, value] of Object.entries(params)) if (key.startsWith('w_') && Number.isFinite(Number(value))) weights[key.slice(2)] = Number(value);
    let last = { revision: -1, id: -1 };
    let turn = null;
    let pending = null;
    const noEffect = new Set();
    const counters = { own: 0, baseline: 0, baselineWhy: {}, noEffectMoves: 0, endedTurnInstead: 0, windowsChanged: 0, loopUnavoidable: 0, playouts: 0, steps: 0 };
    let lastDecision = null;
    const loopGuard = createLoopGuard();
    let board = '';
    let gainsOut = null;
    const hand = (key, query, result) => { pending = { key, looks: looks(query) }; return result; };
    const fallback = (view, why) => {
      counters.baseline += 1; counters.baselineWhy[why] = (counters.baselineWhy[why] ?? 0) + 1;
      lastDecision = { kind: 'baseline', why, moveId: null, gains: gainsOut };
      let result = view.baseline();
      if (result?.ok && view.query.requiredInput !== null) {
        result = loopGuard.answer(view.query, board, result);
        counters.windowsChanged = loopGuard.stats.changed; counters.loopUnavoidable = loopGuard.stats.unavoidable;
      }
      if (!result?.ok) return result;
      const key = `base:${JSON.stringify(result.value.action)}`;
      if (noEffect.has(key)) {
        const end = view.query.legalActions.find((entry) => entry.kind === 'fixed' && entry.action?.type === 'endTurn');
        if (end) {
          counters.endedTurnInstead += 1;
          return hand('base:endTurn', view.query, { ok: true, value: { commandId: view.commandId, expectedRevision: view.query.status.revision, action: structuredClone(end.action) } });
        }
      }
      return hand(key, view.query, result);
    };

    const playOut = (sim, state) => playout(sim, state, { weights, own: ownDepth, opp: oppDepth, margin, counters });

    return {
      needsSim: true,
      counters,
      get lastDecision() { return lastDecision; },
      choose(view) {
        const { sim, query } = view;
        lastDecision = null; gainsOut = null;
        const revision = query.status?.revision;
        const now = query.observation?.turnNumber ?? null;
        if (now !== turn) { turn = now; noEffect.clear(); pending = null; }
        if (pending !== null && pending.looks === looks(query)) { noEffect.add(pending.key); counters.noEffectMoves += 1; }
        pending = null;
        board = loopGuard.begin(query);
        if (!sim || query.requiredInput !== null || revision === last.revision) return fallback(view, !sim ? 'no-sim' : query.requiredInput !== null ? 'choice' : 'repeat');
        const keyOf = (move) => `own:${move.type}:${[...move.uids].sort().join(',')}`;
        const ending = sim.moves.find((move) => move.type === 'endTurn');
        const candidates = sim.moves.filter((move) => move.type !== 'endTurn' && !noEffect.has(keyOf(move)));
        if (candidates.length === 0 || !ending) return fallback(view, 'no-supported-move');
        // one move of look-ahead, to choose which moves to play out
        const quick = new Map(candidates.map((move) => [move.id, { sum: 0, n: 0 }]));
        for (let sample = 0; sample < k; sample += 1) {
          const before = evaluate(sim.now(sample), sim.me, weights);
          for (const move of candidates) {
            const after = sim.after(move.id, sample);
            if (after !== null) { const g = quick.get(move.id); g.sum += clamp(evaluate(after, sim.me, weights)) - before; g.n += 1; }
          }
        }
        const ranked = candidates.filter((move) => quick.get(move.id).n === k).sort((a, b) => quick.get(b.id).sum - quick.get(a.id).sum).slice(0, top);
        if (ranked.length === 0) return fallback(view, 'no-gain');
        // play them out, and ending the turn at once, on each determinized state
        const total = new Map([[ending.id, 0], ...ranked.map((move) => [move.id, 0])]);
        const done = new Map([[ending.id, 0], ...ranked.map((move) => [move.id, 0])]);
        for (let sample = 0; sample < k; sample += 1) {
          for (const move of [ending, ...ranked]) {
            const after = sim.after(move.id, sample);
            if (after === null) continue;
            total.set(move.id, total.get(move.id) + playOut(sim, after)); done.set(move.id, done.get(move.id) + 1);
          }
        }
        if (done.get(ending.id) !== k) return fallback(view, 'no-gain');
        const base = total.get(ending.id) / k;
        gainsOut = ranked.filter((move) => done.get(move.id) === k).map((move) => ({ id: move.id, value: total.get(move.id) / k - base }));
        let best = null;
        for (const move of ranked) if (done.get(move.id) === k) { const value = total.get(move.id) / k - base; if (best === null || value > best.value) best = { id: move.id, value, move }; }
        if (best === null || best.value <= margin) return fallback(view, 'no-gain');
        counters.own += 1;
        last = { revision, id: best.id };
        lastDecision = { kind: 'own', why: 'own', moveId: best.id, gains: gainsOut };
        return hand(keyOf(best.move), query, { ok: true, value: sim.intent(best.id, { commandId: view.commandId, expectedRevision: revision }) });
      }
    };
  }
};
