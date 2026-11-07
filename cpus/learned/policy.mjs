// The CPU that a forged weight vector makes (forgehammer's smith writes a small cpus/forged-<name>.mjs that calls `learnedCpu` with the weights).
//
// For every move of the decision it builds the features φ(s,a) (cpus/learned/features.mjs, the same function the recorder used), scores it with
// one weight vector, z = w·φ, and plays the move with the highest score. It does not look ahead: it never calls sim.after. When the best score is
// the extra candidate "let the game's own CPU decide" (the decision has kinds of action with no move in the list: spells, card effects, ...), or
// when there is a choice to answer, or nothing to choose from, the game's current CPU (view.baseline()) plays.
//
// A move that was accepted and changed nothing the seat can see is not chosen again in the same turn (the same guard as cpus/lookahead.mjs).
import { decisionFeatures, FEATURE_VERSION, CAND_NAMES } from './features.mjs';

// What the seat sees, without the revision: if it is the same after a move, the move changed nothing.
const looks = (query) => { const { revision, ...rest } = query.observation ?? {}; return JSON.stringify(rest); };

export function learnedCpu({ id, featureVersion, featureNames, weights, meta = {} }) {
  if (featureVersion !== FEATURE_VERSION || featureNames.length !== CAND_NAMES.length || featureNames.some((name, i) => name !== CAND_NAMES[i])) {
    throw new Error(`${id}: made for features v${featureVersion} (${featureNames.length}), this build has v${FEATURE_VERSION} (${CAND_NAMES.length}); forge it again`);
  }
  const W = Float64Array.from(weights);
  return {
    id, needsSim: true, meta,
    create() {
      let last = { revision: -1 };
      let turn = null;
      let pending = null;
      const noEffect = new Set();
      const counters = { own: 0, baseline: 0, baselineWhy: {}, noEffectMoves: 0, endedTurnInstead: 0 };
      const hand = (key, query, result) => { pending = { key, looks: looks(query) }; return result; };
      const fallback = (view, why) => {
        counters.baseline += 1; counters.baselineWhy[why] = (counters.baselineWhy[why] ?? 0) + 1;
        const result = view.baseline();
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
      return {
        needsSim: true, counters,
        choose(view) {
          const { sim, query } = view;
          const revision = query.status?.revision;
          const now = query.observation?.turnNumber ?? null;
          if (now !== turn) { turn = now; noEffect.clear(); pending = null; }
          if (pending !== null && pending.looks === looks(query)) { noEffect.add(pending.key); counters.noEffectMoves += 1; }
          pending = null;
          if (!sim || query.requiredInput !== null || revision === last.revision) return fallback(view, !sim ? 'no-sim' : query.requiredInput !== null ? 'choice' : 'repeat');
          const moves = sim.moves;
          const unsupported = sim.unsupported ?? [];
          if (moves.length === 0) return fallback(view, 'no-supported-move');
          const { cands } = decisionFeatures(sim.now(0), sim.me, moves, unsupported);
          let best = -1; let bestScore = -Infinity;
          for (let i = 0; i < cands.length; i += 1) {
            const move = moves[i];
            if (move && move.type !== 'endTurn' && noEffect.has(`own:${move.type}:${[...move.uids].sort().join(',')}`)) continue;
            const f = cands[i]; let z = 0;
            for (let j = 0; j < f.length; j += 1) z += W[j] * f[j];
            if (z > bestScore) { bestScore = z; best = i; }
          }
          if (best < 0 || best >= moves.length) return fallback(view, 'learned-baseline');
          counters.own += 1;
          last = { revision };
          const move = moves[best];
          return hand(`own:${move.type}:${[...move.uids].sort().join(',')}`, query, { ok: true, value: sim.intent(move.id, { commandId: view.commandId, expectedRevision: revision }) });
        }
      };
    }
  };
}
