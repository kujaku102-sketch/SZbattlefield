// A machine judge for two moves of one decision: which one is worth more.
//
// For each move it plays the move out on `samples` determinized states of the decision, the rest of the seat's turn and the other side's turn after it (the same play-out as
// cpus/deep.mjs: cpus/lookahead/playout.mjs), and evaluates the state when that turn ends; the move with the higher average is the better one. It reads determinized states only, as a CPU
// that looks ahead does. A move the sim has no call for (a spell, an effect) cannot be played out: then the verdict is "unknown".
//
//   judgeMoves(sim, actions, { samples, own, opp, margin }) -> { verdict, values: [number|null, ...], samples, spread }
//     sim       the decision (src/sim-host.mjs open()); it must have been opened with at least `samples` determinized states available
//     actions   runtime actions (as the CPUs return them) to compare; matched to the sim's moves by their signature
//     verdict   index of the better action, "tie" when the averages are within `margin`, "unknown" when a move cannot be played out
import { actionSignature } from '../cpus/learned/candidates.mjs';
import { playout } from '../cpus/lookahead/playout.mjs';
import { DEFAULT_WEIGHTS } from '../cpus/lookahead/eval.mjs';

export function judgeMoves(sim, actions, { samples = 6, own = 4, opp = 4, margin = 0.5, weights = DEFAULT_WEIGHTS } = {}) {
  const bySig = new Map();
  for (const move of sim.moves) {
    const intent = sim.intent(move.id, { commandId: 'j', expectedRevision: 0 });
    if (intent?.action) bySig.set(actionSignature(intent.action), move.id);
  }
  const ids = actions.map((action) => bySig.get(actionSignature(action)) ?? null);
  if (ids.some((id) => id === null)) return { verdict: 'unknown', values: ids.map(() => null), samples: 0, spread: null, reason: 'a move the sim has no call for' };
  const total = ids.map(() => 0); const squares = ids.map(() => 0); let used = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const values = ids.map((id) => { const after = sim.after(id, sample); return after === null ? null : playout(sim, after, { weights, own, opp, margin: 0.01 }); });
    if (values.some((v) => v === null)) continue;
    values.forEach((v, i) => { total[i] += v; squares[i] += v * v; });
    used += 1;
  }
  if (used === 0) return { verdict: 'unknown', values: ids.map(() => null), samples: 0, spread: null, reason: 'no state where both moves could be played' };
  const mean = total.map((t) => t / used);
  const best = mean.indexOf(Math.max(...mean));
  const second = Math.max(...mean.filter((_, i) => i !== best));
  const verdict = mean[best] - second <= margin ? 'tie' : best;
  return { verdict, values: mean, samples: used, spread: Math.sqrt(Math.max(0, squares[best] / used - mean[best] ** 2)) };
}
