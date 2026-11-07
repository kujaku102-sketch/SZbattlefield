// The CPU that a forged weight vector makes (forgehammer's smith writes a small cpus/forged-<name>.mjs that calls `learnedCpu` with the weights).
//
// It needs only what the game's own CPU needs: the seat's query and the planner of its own port (queryAction). For every legal move it builds the
// features φ(s,a) (cpus/learned/features.mjs, the function the recorder used), scores it with one weight vector, z = w·φ, and plays the move with the
// highest score. It does not look ahead, and it has no sim. When the best score is the extra candidate "let the game's own CPU decide" (the decision has kinds
// of action with no candidate of their own), or when there is a choice to answer, or nothing to choose from, the game's current CPU (view.baseline()) plays.
//
// A move that was accepted and changed nothing the seat can see is not chosen again in the same turn (the same guard as cpus/lookahead.mjs). Two more guards
// against a turn that never ends, the same ones the game's own CPU has: a card is moved (redeploy) or its effect started (activateCardEffect) once a turn, and a
// turn of more than MOVES_PER_TURN moves of this CPU is ended.
import { decisionFeatures, FEATURE_VERSION, CAND_NAMES } from './features.mjs';
import { buildCandidates, completeCandidate } from './candidates.mjs';

// What the seat sees, without the revision: if it is the same after a move, the move changed nothing.
const REPEAT_LIMITED = new Set(['redeploy', 'activateCardEffect']);
const MOVES_PER_TURN = 40;
const looks = (query) => { const { revision, ...rest } = query.observation ?? {}; return JSON.stringify(rest); };

// scores of a decision: { built, features, scores }
export function scoreDecision(query, queryAction, W) {
  const built = buildCandidates(query, queryAction);
  const features = decisionFeatures(query, built);
  const scores = features.cands.map((f) => { let z = 0; for (let j = 0; j < f.length; j += 1) z += W[j] * f[j]; return z; });
  return { built, features, scores };
}

export function learnedCpu({ id, featureVersion, featureNames, weights, meta = {} }) {
  if (featureVersion !== FEATURE_VERSION || featureNames.length !== CAND_NAMES.length || featureNames.some((name, i) => name !== CAND_NAMES[i])) {
    throw new Error(`${id}: made for features v${featureVersion} (${featureNames.length}), this build has v${FEATURE_VERSION} (${CAND_NAMES.length}); forge it again`);
  }
  const W = Float64Array.from(weights);
  return {
    id, needsBaseline: true, meta,
    create() {
      let last = { revision: -1 };
      let turn = null;
      let pending = null;
      const noEffect = new Set();
      const usedThisTurn = new Map();   // `${type}:${cardRef}` -> times, for the repeat-limited kinds
      let movesThisTurn = 0;
      const counters = { own: 0, baseline: 0, baselineWhy: {}, noEffectMoves: 0, endedTurnInstead: 0, planCalls: 0, turnEndedByLimit: 0 };
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
        needsBaseline: true, counters,
        choose(view) {
          const { query, queryAction } = view;
          const revision = query.status?.revision;
          const now = query.observation?.turnNumber ?? null;
          if (now !== turn) { turn = now; noEffect.clear(); usedThisTurn.clear(); movesThisTurn = 0; pending = null; }
          if (pending !== null && pending.looks === looks(query)) { noEffect.add(pending.key); counters.noEffectMoves += 1; }
          pending = null;
          if (query.requiredInput !== null || revision === last.revision) return fallback(view, query.requiredInput !== null ? 'choice' : 'repeat');
          const { built, scores } = scoreDecision(query, queryAction, W);
          counters.planCalls += built.planCalls;
          let best = -1; let bestScore = -Infinity;
          const tooMany = movesThisTurn >= MOVES_PER_TURN;
          if (tooMany) counters.turnEndedByLimit += 1;
          for (let i = 0; i < scores.length; i += 1) {
            const candidate = built.cands[i];
            if (tooMany && candidate?.type !== 'endTurn') continue;
            if (candidate && candidate.type !== 'endTurn' && (noEffect.has(`own:${candidate.sig}`) || (REPEAT_LIMITED.has(candidate.type) && (usedThisTurn.get(`${candidate.type}:${candidate.cardRef}`) ?? 0) >= 1))) continue;
            if (scores[i] > bestScore) { bestScore = scores[i]; best = i; }
          }
          if (best < 0 || best >= built.cands.length) return fallback(view, scores.length === 0 ? 'no-candidate' : 'learned-baseline');
          const candidate = built.cands[best];
          const action = completeCandidate(query, candidate, queryAction);
          if (!action) return fallback(view, 'plan-refused');
          counters.own += 1;
          movesThisTurn += 1;
          if (REPEAT_LIMITED.has(candidate.type)) usedThisTurn.set(`${candidate.type}:${candidate.cardRef}`, (usedThisTurn.get(`${candidate.type}:${candidate.cardRef}`) ?? 0) + 1);
          last = { revision };
          return hand(`own:${candidate.sig}`, query, { ok: true, value: { commandId: view.commandId, expectedRevision: revision, action } });
        }
      };
    }
  };
}
