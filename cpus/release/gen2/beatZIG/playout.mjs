// FROZEN COPY for generation 2 (cpus/release/gen2/beatZIG.mjs): cpus/lookahead/playout.mjs at commit 8aa4ce8. Do not edit and do not follow changes elsewhere: gen2 must play the same for ever. For a new generation, copy again.
// A state played out: the rest of the seat's own turn, the end of it, the other side's turn and the end of that. Returns the evaluation (for the seat) of the state when that turn ends.
//
//   playout(sim, state, { weights, own, opp, margin }) -> number     (clamped to +-200: a decided game counts as a large number, not as an infinity)
//     own / opp   the most moves played for each side (the seat's: the best by the evaluation after it, while one gains more than `margin`;
//                 the other side's: the worst for the seat, in the same way)
// It reads only what `sim` hands out (states of the decision and the moves on them, src/sim-host.mjs); nothing of the real match.
import { evaluate, DEFAULT_WEIGHTS } from './eval.mjs';

const clamp = (v) => Math.max(-200, Math.min(200, v));

export function playout(sim, state, { weights = DEFAULT_WEIGHTS, own = 4, opp = 4, margin = 0.01, counters = null } = {}) {
  let cur = state;
  if (counters) counters.playouts += 1;
  const end = (who) => {
    const branch = sim.branch(cur, who);
    const move = branch.moves.find((m) => m.type === 'endTurn');
    if (!move) return;
    const next = branch.after(move.id);
    if (next !== null) cur = next;
  };
  const play = (who, depth) => {
    for (let i = 0; i < depth; i += 1) {
      const branch = sim.branch(cur, who);
      if (branch.moves.length === 0) return;
      const here = evaluate(cur, sim.me, weights);
      let pick = null;
      for (const move of branch.moves) {
        if (move.type === 'endTurn') continue;
        const next = branch.after(move.id);
        if (counters) counters.steps += 1;
        if (next === null) continue;
        const value = evaluate(next, sim.me, weights);
        // the seat plays the move that is best for it, the other side the one that is worst for the seat
        const better = who === 'me' ? value > (pick?.value ?? here + margin) : value < (pick?.value ?? here - margin);
        if (better) pick = { value, next };
      }
      if (pick === null) return;
      cur = pick.next;
    }
  };
  play('me', own);
  end('me');
  play('opp', opp);
  end('opp');
  return clamp(evaluate(cur, sim.me, weights));
}
