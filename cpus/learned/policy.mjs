// The CPU that a forged weight vector makes (forgehammer's smith writes a small cpus/forged-<name>.mjs that calls `learnedCpu` with the weights).
//
// It needs only what the game's own CPU needs: the seat's query and the planner of its own port (queryAction). It does not look ahead and has no sim.
//   flat     every legal move (with its options) is a candidate; each gets z = w·φ(s,a) and the highest is played. One planning call for each entry with options.
//   staged   the legal actions are scored first, before their options are known (weights `entryWeights`); only the best one is planned (one call), and its options are
//            scored (weights `optionWeights`). Two planning calls at most, one more to make the final action.
// When the best is "let the game's own CPU decide" (kinds of action with no candidate of their own), or there is a choice to answer, or nothing to choose from,
// the game's current CPU (view.baseline()) plays.
//
// A move that was accepted and changed nothing the seat can see is not chosen again in the same turn (the same guard as cpus/lookahead.mjs). Two more guards against a
// turn that never ends, the same ones the game's own CPU has: a card is moved (redeploy) or its effect started (activateCardEffect) once a turn, and a turn of more than
// MOVES_PER_TURN moves of this CPU is ended.
import { candidateFeatures, decisionContext, decisionFeatures, entryCandidates, FEATURE_VERSION, CAND_NAMES, STATE_NAMES, queryView } from './features.mjs';
import { buildCandidates, completeCandidate, planEntry } from './candidates.mjs';
import { createLoopGuard } from './loopguard.mjs';

const REPEAT_LIMITED = new Set(['redeploy', 'activateCardEffect']);
const MOVES_PER_TURN = 40;
// What the seat sees, without the revision: if it is the same after a move, the move changed nothing.
const looks = (query) => { const { revision, ...rest } = query.observation ?? {}; return JSON.stringify(rest); };
const dot = (W, f, n = f.length) => { let z = 0; for (let j = 0; j < n; j += 1) z += W[j] * f[j]; return z; };
const histKeyOf = (action) => `${action.type}:${action.cardRef ?? action.attackerRef ?? ''}`;
const CHOICES = new Set(['answerChoice', 'declineChoice', 'keepOpeningHand', 'openingMulligan']);

// crossing (forgehammer src/cross.mjs): the features after the first CAND_NAMES.length are the products candidate[row] * state[col], row a and column b at F + a * C + b
export function crossOf(cross, base = CAND_NAMES.length) {
  if (!cross) return null;
  const rows = cross.rows.map((name) => CAND_NAMES.indexOf(name)); const cols = cross.cols.map((name) => STATE_NAMES.indexOf(name));
  if (rows.some((j) => j < 0) || cols.some((j) => j < 0)) throw new Error('the cross of this CPU has a name this build does not');
  return { rows, cols, base };
}
const crossDot = (W, f, state, cross) => {
  let z = 0; const C = cross.cols.length;
  for (let a = 0; a < cross.rows.length; a += 1) {
    const v = f[cross.rows[a]]; if (v === 0) continue;
    const at = cross.base + a * C;
    for (let b = 0; b < C; b += 1) z += W[at + b] * v * state[cross.cols[b]];
  }
  return z;
};

// flat: scores of a decision
export function scoreDecision(query, queryAction, W, history, cross = null, nBase = CAND_NAMES.length) {
  const built = buildCandidates(query, queryAction);
  const features = decisionFeatures(query, built, history, { withEntries: false });
  return { built, features, scores: features.cands.map((f) => dot(W, f, nBase) + (cross ? crossDot(W, f, features.state, cross) : 0)) };
}

export function learnedCpu({ id, featureVersion, featureNames, weights, entryWeights = null, optionWeights = null, cross: crossSpec = null, meta = {} }) {
  // a CPU made for an older, shorter list of features reads that list (the new features come after it and weigh nothing for it)
  if (featureVersion > FEATURE_VERSION || featureNames.length > CAND_NAMES.length || featureNames.some((name, i) => name !== CAND_NAMES[i])) {
    throw new Error(`${id}: made for features v${featureVersion} (${featureNames.length}), this build has v${FEATURE_VERSION} (${CAND_NAMES.length}); forge it again`);
  }
  const nBase = featureNames.length;
  const W = Float64Array.from(weights ?? []);
  const cross = crossOf(crossSpec, nBase);
  const staged = entryWeights !== null;
  const WE = staged ? Float64Array.from(entryWeights) : null;
  const WO = staged ? Float64Array.from(optionWeights) : null;
  return {
    id, needsBaseline: true, meta,
    create() {
      let last = { revision: -1 };
      let turn = null;
      let pending = null;
      const noEffect = new Set();
      const history = { moves: 0, used: new Map() };            // the seat's own accepted moves this turn
      const loopGuard = createLoopGuard();                       // what this CPU does not do: repeat a process that changes nothing, on the same board in one turn (cpus/learned/loopguard.mjs)
      let board = '';
      const counters = { own: 0, baseline: 0, baselineWhy: {}, noEffectMoves: 0, endedTurnInstead: 0, planCalls: 0, turnEndedByLimit: 0, windowsChanged: 0, loopUnavoidable: 0 };
      const hand = (key, query, result) => {
        pending = { key, looks: looks(query), revision: query.status.revision, histKey: result?.ok ? histKeyOf(result.value.action) : null, choice: Boolean(result?.ok && CHOICES.has(result.value.action.type)) };
        return result;
      };
      const fallback = (view, why) => {
        counters.baseline += 1; counters.baselineWhy[why] = (counters.baselineWhy[why] ?? 0) + 1;
        let result = view.baseline();
        if (result?.ok && why === 'choice') {
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
      const blocked = (type, cardRef, key) => type !== 'endTurn' && (noEffect.has(key) || (REPEAT_LIMITED.has(type) && (history.used.get(`${type}:${cardRef ?? ''}`) ?? 0) >= 1));
      return {
        needsBaseline: true, counters,
        choose(view) {
          const { query, queryAction } = view;
          const revision = query.status?.revision;
          const now = query.observation?.turnNumber ?? null;
          if (now !== turn) { turn = now; noEffect.clear(); history.moves = 0; history.used.clear(); pending = null; }
          // the move handed out last time was accepted (the revision moved on): it is part of what this turn has done
          if (pending !== null && revision !== pending.revision && pending.histKey && !pending.choice) { history.moves += 1; history.used.set(pending.histKey, (history.used.get(pending.histKey) ?? 0) + 1); }
          if (pending !== null && pending.looks === looks(query)) { noEffect.add(pending.key); counters.noEffectMoves += 1; }
          pending = null;
          board = loopGuard.begin(query);
          if (query.requiredInput !== null || revision === last.revision) return fallback(view, query.requiredInput !== null ? 'choice' : 'repeat');
          const tooMany = history.moves >= MOVES_PER_TURN;
          if (tooMany) counters.turnEndedByLimit += 1;
          const chose = (candidate, action, key = `own:${candidate.sig}`) => {
            counters.own += 1; last = { revision };
            return hand(key, query, { ok: true, value: { commandId: view.commandId, expectedRevision: revision, action } });
          };
          if (!staged) {
            const { built, scores } = scoreDecision(query, queryAction, W, history, cross, nBase);
            counters.planCalls += built.planCalls;
            let best = -1; let bestScore = -Infinity;
            for (let i = 0; i < scores.length; i += 1) {
              const candidate = built.cands[i];
              if (tooMany && candidate?.type !== 'endTurn') continue;
              if (candidate && blocked(candidate.type, candidate.cardRef, `own:${candidate.sig}`)) continue;
              if (scores[i] > bestScore) { bestScore = scores[i]; best = i; }
            }
            if (best < 0 || best >= built.cands.length) return fallback(view, scores.length === 0 ? 'no-candidate' : 'learned-baseline');
            const action = completeCandidate(query, built.cands[best], queryAction);
            if (!action) return fallback(view, 'plan-refused');
            return chose(built.cands[best], action);
          }
          // staged: the entries first
          const qv = queryView(query);
          const entries = entryCandidates(query);
          const ctx = decisionContext(qv, entries, [], history);
          let best = -1; let bestScore = -Infinity;
          for (let i = 0; i < entries.length; i += 1) {
            const e = entries[i];
            if (tooMany && e.type !== 'endTurn') continue;
            if (blocked(e.type, e.cardRef, `own:${e.type}|${e.cardRef ?? ''}`)) continue;
            const z = dot(WE, candidateFeatures(ctx, e), nBase);
            if (z > bestScore) { bestScore = z; best = i; }
          }
          if (best < 0) return fallback(view, 'no-candidate');
          const entry = query.legalActions[best];
          const planned = planEntry(query, entry, best, queryAction);
          counters.planCalls += planned.planCalls;
          if (planned.unsupported || planned.cands.length === 0) return fallback(view, 'learned-baseline');
          let pick = planned.cands[0];
          if (planned.cands.length > 1) {
            const octx = decisionContext(qv, planned.cands, [], history);
            let ob = -Infinity;
            for (const candidate of planned.cands) {
              if (noEffect.has(`own:${candidate.sig}`)) continue;
              const z = dot(WO, candidateFeatures(octx, candidate), nBase);
              if (z > ob) { ob = z; pick = candidate; }
            }
          }
          const action = completeCandidate(query, pick, queryAction);
          if (!action) return fallback(view, 'plan-refused');
          if (pick.entry.kind !== 'fixed' && !pick.complete) counters.planCalls += 1;
          return chose(pick, action, `own:${pick.type}|${pick.cardRef ?? ''}`);   // a move that changes nothing blocks its whole entry
        }
      };
    }
  };
}
