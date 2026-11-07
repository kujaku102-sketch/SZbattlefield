// CPU: one move of look-ahead.
//
// For each move the seat has, it tries the move on K determinized states (the seat's view with everything it cannot see re-drawn at random),
// evaluates the state after the move against the state before it, and plays the move with the best average gain when that gain is worth
// playing. Anything else (a choice to answer, a move with no engine call yet, no gain, no time) is the current CPU's move (view.baseline()).
//
// A move that was accepted and changed nothing the seat can see is not chosen again in the same turn (the current CPU's move too: the turn
// ends instead). Without this, a command that is accepted but has no effect would be repeated for ever.
//
// A CPU with `needsSim` gets view.sim (see src/sim-host.mjs). It never gets the real state: only what that gives it, and the seat's own query.
// This file may import only files of this folder (checked when it is loaded).
//
// Parameters (CPU spec `lookahead?k=2&margin=0.01&w_str=3...`): k = determinized states, margin = the smallest average gain worth a move,
// w_* = weights of the evaluation (cpus/lookahead/eval.mjs), guard=1 with budget=<ms> = hand the move to the current CPU when the thinking
// runs over the time (off by default: a decision must not depend on how fast the machine is).
import { evaluate, DEFAULT_WEIGHTS } from './lookahead/eval.mjs';
import { createLoopGuard } from './learned/loopguard.mjs';

// What the seat sees, without the revision: if it is the same after a move, the move changed nothing.
const looks = (query) => { const { revision, ...rest } = query.observation ?? {}; return JSON.stringify(rest); };

export default {
  id: 'lookahead',
  needsSim: true,
  create(gameDir, params = {}) {
    const k = Math.max(1, Number(params.k ?? 2));
    // `guard`: 0 (default) = decisions depend only on the state and the parameters, so a match replays exactly; 1 = the time guard below is on:
    // the current CPU decides when the thinking has run over `budget` ms (a real-time safety net, which makes results depend on the machine's speed).
    const guard = Number(params.guard ?? 0) === 1;
    const budget = Number(params.budget ?? 30);
    const margin = Number(params.margin ?? 0.01);
    const weights = { ...DEFAULT_WEIGHTS };
    for (const [key, value] of Object.entries(params)) if (key.startsWith('w_') && Number.isFinite(Number(value))) weights[key.slice(2)] = Number(value);
    let last = { revision: -1, id: -1 };
    let turn = null;                 // the turn the no-effect memory belongs to
    let pending = null;              // the move handed out at the last decision: { key, looks }
    const noEffect = new Set();      // keys of moves that were accepted and changed nothing this turn
    // how often each kind of decision was made (the harness writes these into the match result)
    const counters = { own: 0, baseline: 0, baselineWhy: {}, noEffectMoves: 0, endedTurnInstead: 0, windowsChanged: 0 };
    // what the last decision was, for a recorder that learns from this CPU (the harness reads it; nothing here depends on it):
    // { kind: 'own' | 'baseline', why, moveId (own), gains: [{ id, value }] (the average gain of every move it tried, when it tried) }
    let lastDecision = null;
    const loopGuard = createLoopGuard({ threshold: 1e9 });   // a window that comes back and back in one turn is answered differently (cpus/learned/loopguard.mjs)
    let repeats = 0;
    let gainsOut = null;
    const hand = (key, query, result) => { pending = { key, looks: looks(query) }; return result; };
    const fallback = (view, why) => {
      counters.baseline += 1; counters.baselineWhy[why] = (counters.baselineWhy[why] ?? 0) + 1;
      lastDecision = { kind: 'baseline', why, moveId: null, gains: gainsOut };
      let result = view.baseline();
      if (result?.ok && view.query.requiredInput !== null) {
        const changed = loopGuard.change(view.query, repeats, result);
        if (changed !== result) counters.windowsChanged += 1;
        result = changed;
      }
      if (!result?.ok) return result;
      const key = `base:${JSON.stringify(result.value.action)}`;
      if (noEffect.has(key)) {
        // the current CPU wants a move that did nothing earlier this turn: end the turn instead
        const end = view.query.legalActions.find((entry) => entry.kind === 'fixed' && entry.action?.type === 'endTurn');
        if (end) {
          counters.endedTurnInstead += 1;
          return hand('base:endTurn', view.query, { ok: true, value: { commandId: view.commandId, expectedRevision: view.query.status.revision, action: structuredClone(end.action) } });
        }
      }
      return hand(key, view.query, result);
    };
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
        repeats = loopGuard.see(query);
        // a choice to answer, no sim, or the same decision again (the move chosen last time was not accepted): the current CPU
        if (!sim || query.requiredInput !== null || revision === last.revision) return fallback(view, !sim ? 'no-sim' : query.requiredInput !== null ? 'choice' : 'repeat');
        const candidates = sim.moves.filter((move) => move.type !== 'endTurn' && !noEffect.has(`own:${move.type}:${[...move.uids].sort().join(',')}`));
        if (candidates.length === 0) return fallback(view, 'no-supported-move');
        const gain = new Map(candidates.map((move) => [move.id, { sum: 0, n: 0 }]));
        let complete = 0;
        let sampleMs = 0;
        for (let sample = 0; sample < k; sample += 1) {
          // another sample only if it is expected to fit in the time (the first one always runs: with no time for it, the current CPU decides)
          if (guard && sample > 0 && sim.elapsedMs() + sampleMs > budget) break;
          const started = sim.elapsedMs();
          const before = evaluate(sim.now(sample), sim.me, weights);
          for (const move of candidates) {
            const after = sim.after(move.id, sample);
            if (after !== null) { const g = gain.get(move.id); g.sum += evaluate(after, sim.me, weights) - before; g.n += 1; }
            if (guard && sample === 0 && sim.elapsedMs() > budget) return fallback(view, 'over-budget');
          }
          complete += 1;
          sampleMs = sim.elapsedMs() - started;
        }
        gainsOut = candidates.filter((move) => gain.get(move.id).n === complete).map((move) => ({ id: move.id, value: gain.get(move.id).sum / gain.get(move.id).n }));
        let best = null;
        for (const move of candidates) {
          const g = gain.get(move.id);
          if (g.n === complete && (best === null || g.sum / g.n > best.value)) best = { id: move.id, value: g.sum / g.n, move };
        }
        if (best === null || best.value <= margin) return fallback(view, 'no-gain');
        counters.own += 1;
        last = { revision, id: best.id };
        lastDecision = { kind: 'own', why: 'own', moveId: best.id, gains: gainsOut };
        return hand(`own:${best.move.type}:${[...best.move.uids].sort().join(',')}`, query,
          { ok: true, value: sim.intent(best.id, { commandId: view.commandId, expectedRevision: revision }) });
      }
    };
  }
};
