// The learned CPU narrows the moves by its own score, and a reader looks at the best few: "the top k by the network, read ahead".
//
//   makeTopk({ k, reader, samples, own, opp }) -> { pick({ sim, built, scores, eligible }) -> the index of the candidate to play, or null (keep the best by score), stats }
//
// The moves of the decision (`eligible`: not blocked by the no-effect memory) are ranked by the learned score; the best `k` that the sim has a call for are read:
//   reader "one"   the state right after the move, evaluated (cpus/lookahead/eval.mjs), averaged over `samples` determinized states      (cheap: about a millisecond a move)
//   reader "deep"  the move played out through the rest of the turn and the other side's turn (cpus/lookahead/playout.mjs; own / opp = the most moves for each side)
// and the one with the best average is played (a tie goes to the better score). If the best by score is a move the sim cannot play (a spell, an effect), it is played as it is:
// there is nothing to compare it with. The reader works on determinized states only, as lookahead does. This file may import only files of this folder.
import { actionSignature } from './learned/candidates.mjs';
import { evaluate, DEFAULT_WEIGHTS } from './lookahead/eval.mjs';
import { playout } from './lookahead/playout.mjs';

const clamp = (v) => Math.max(-200, Math.min(200, v));

export function makeTopk(options = {}) {
  const { k = 3, reader = 'deep', samples = 2, own = 3, opp = 3 } = options;
  const stats = { decisions: 0, read: 0, notReadable: 0, changed: 0, readMs: 0 };
  return {
    stats, k, reader,
    // a reader of its own for each match (its stats count that match only)
    fresh: () => makeTopk(options),
    pick({ sim, built, scores, eligible }) {
      stats.decisions += 1;
      const started = performance.now();
      const order = [...eligible].sort((a, b) => scores[b] - scores[a]).slice(0, k);
      if (order.length < 2) return null;
      const bySig = new Map();
      for (const move of sim.moves) {
        const intent = sim.intent(move.id, { commandId: 'topk', expectedRevision: 0 });
        if (intent?.action) bySig.set(actionSignature(intent.action), move.id);
      }
      if (!built.cands[order[0]] || !bySig.has(built.cands[order[0]].sig)) { stats.notReadable += 1; return null; }
      const readable = order.filter((i) => built.cands[i] && bySig.has(built.cands[i].sig));
      if (readable.length < 2) return null;
      let best = null;
      for (const i of readable) {
        const id = bySig.get(built.cands[i].sig);
        let total = 0; let done = 0;
        for (let sample = 0; sample < samples; sample += 1) {
          const after = sim.after(id, sample);
          if (after === null) continue;
          total += reader === 'deep' ? playout(sim, after, { weights: DEFAULT_WEIGHTS, own, opp }) : clamp(evaluate(after, sim.me, DEFAULT_WEIGHTS));
          done += 1;
        }
        if (done < samples) continue;
        const value = total / done;
        if (best === null || value > best.value) best = { index: i, value };
      }
      stats.read += 1; stats.readMs += performance.now() - started;
      if (best === null) return null;
      if (best.index !== order[0]) stats.changed += 1;
      return best.index;
    }
  };
}
