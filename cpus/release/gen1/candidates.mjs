// FROZEN COPY for generation 1 (cpus/release/gen1.mjs): the file cpus/learned/candidates.mjs as it was at commit e662c15 (features v3). Do not edit and do not follow changes of cpus/learned/: gen1 must play the same for ever. For a new generation, copy again.
// The candidates of a decision, made from the seat's query alone (its legal actions) and the planner of its own port (queryAction): no engine state,
// no sim. The same function builds them for the recorder and for the learned CPU.
//
//   fixed entries (install, recoverRegistry, activateScript, activateAbility, endTurn ...)   one candidate each
//   intent entries (attack, redeploy, executeCard, setScript, executeSpell ...)             one planning call each; when the plan asks for one pick among options
//                                                                                          (an attack target, a place to put a card, a spell target) there is one
//                                                                                          candidate per option (places that differ only in the slot are one)
//   anything else (several picks: layered materials, a second stage, a kind of choice not known here)   not a candidate: it is counted in `unsupported`, and the
//                                                                                          features have one extra candidate for "let the game's own CPU decide"
// A candidate: { kind: 'move', type, cardRef, targetRef, targetUser, zone, host, sig, entry, request?, option? }. `sig` names the action the candidate makes,
// without anything that differs from one try to the next (the slot, the ids of the planner), so that a chosen action can be found among the candidates.

export function actionSignature(action) {
  if (!action) return '';
  const ref = action.cardRef ?? action.attackerRef ?? '';
  if (action.type === 'attack') return `attack|${ref}|${action.target?.kind === 'user' ? 'user' : action.target?.cardRef ?? ''}`;
  if (action.destination) return `${action.type}|${ref}|${action.destination.zone ?? ''}|${action.destination.hostRef ?? ''}`;
  if (Array.isArray(action.targets)) return `${action.type}|${ref}|${action.targets.map((t) => t.cardRef ?? t.kind ?? '').join(',')}`;
  if (action.ability) return `${action.type}|${action.ability.key ?? ''}`;
  return `${action.type}|${ref}`;
}

const isSinglePick = (request) => request?.constraints?.kind === 'pick' && request.constraints.minimum === 1 && request.constraints.maximum === 1
  && (request.constraints.groups ?? []).length === 0 && Array.isArray(request.options) && request.options.length > 0;

// a candidate from a fixed entry or from a completed plan
function fromAction(entry, action) {
  return { kind: 'move', type: action.type, cardRef: action.cardRef ?? action.attackerRef ?? null, targetRef: action.target?.cardRef ?? action.targets?.[0]?.cardRef ?? null,
    targetUser: action.target?.kind === 'user', zone: action.destination?.zone ?? null, host: action.destination?.hostRef ?? null, sig: actionSignature(action), entry };
}

// a candidate from one option of a plan, by what the option is for (its presentationKey)
function fromOption(entry, request, option) {
  const cardRef = entry.base?.cardRef ?? entry.base?.attackerRef ?? null;
  const key = request.presentationKey;
  if (key === 'attack-target') {
    const targetUser = option.kind === 'user';
    const action = { type: entry.actionType, attackerRef: cardRef, target: targetUser ? { kind: 'user' } : { kind: 'card', cardRef: option.cardRef } };
    return { ...fromAction(entry, action), request, option };
  }
  if (key === 'execution-destination') {
    const action = { type: entry.actionType, cardRef, destination: { zone: option.zone, hostRef: option.hostRef ?? undefined } };
    return { ...fromAction(entry, action), request, option };
  }
  if (key === 'execution-targets') {
    const action = { type: entry.actionType, cardRef, targets: [{ kind: option.kind ?? 'card', cardRef: option.cardRef }] };
    return { ...fromAction(entry, action), request, option };
  }
  return null;
}

// One legal-actions entry as candidates: { cands, unsupported: type | null, planCalls }. A fixed entry is one candidate; an intent entry costs one planning call.
export function planEntry(query, entry, entryIndex, queryAction) {
  if (entry.kind === 'fixed') { const c = fromAction(entry, entry.action); c.entryIndex = entryIndex; return { cands: [c], unsupported: null, planCalls: 0 }; }
  if (entry.kind !== 'intent' || typeof queryAction !== 'function') return { cands: [], unsupported: entry.actionType ?? entry.kind, planCalls: 0 };
  const planned = queryAction({ expectedRevision: query.status.revision, actionId: entry.actionId, selections: [] });
  if (!planned.ok) return { cands: [], unsupported: entry.actionType, planCalls: 1 };
  if (planned.value.completion) return { cands: [{ ...fromAction(entry, planned.value.completion.action), complete: planned.value.completion.action, entryIndex }], unsupported: null, planCalls: 1 };
  const requests = planned.value.selectionRequests ?? [];
  if (requests.length !== 1 || !isSinglePick(requests[0])) return { cands: [], unsupported: entry.actionType, planCalls: 1 };
  const cands = []; const seen = new Set();
  for (const option of requests[0].options) {
    const candidate = fromOption(entry, requests[0], option);
    if (!candidate) break;
    if (seen.has(candidate.sig)) continue;
    seen.add(candidate.sig); candidate.entryIndex = entryIndex; cands.push(candidate);
  }
  return { cands, unsupported: cands.length === 0 ? entry.actionType : null, planCalls: 1 };
}

// Returns { cands, unsupported: [type, ...], planCalls } for the whole decision.
export function buildCandidates(query, queryAction) {
  const cands = []; const unsupported = []; let planCalls = 0;
  for (const [entryIndex, entry] of query.legalActions.entries()) {
    const planned = planEntry(query, entry, entryIndex, queryAction);
    planCalls += planned.planCalls; cands.push(...planned.cands);
    if (planned.unsupported) unsupported.push(planned.unsupported);
  }
  return { cands, unsupported, planCalls };
}

// The index of the legal-actions entry the teacher's action comes from (a fixed entry by its action, an intent entry by its kind and card), or null.
export function entryIndexOf(query, action) {
  const wanted = actionSignature(action);
  const ref = action.cardRef ?? action.attackerRef ?? null;
  const index = query.legalActions.findIndex((entry) => entry.kind === 'fixed' ? actionSignature(entry.action) === wanted : entry.actionType === action.type && (entry.base?.cardRef ?? entry.base?.attackerRef ?? null) === ref);
  return index < 0 ? null : index;
}

// The final action of a chosen candidate (a fixed one is the entry's own action; a planned one needs one more planning call). null if the planner refuses.
export function completeCandidate(query, candidate, queryAction) {
  if (candidate.entry.kind === 'fixed') return structuredClone(candidate.entry.action);
  if (candidate.complete) return structuredClone(candidate.complete);
  const planned = queryAction({ expectedRevision: query.status.revision, actionId: candidate.entry.actionId,
    selections: [{ requestId: candidate.request.requestId, optionIds: [candidate.option.optionId], allocation: [] }] });
  return planned.ok && planned.value.completion ? structuredClone(planned.value.completion.action) : null;
}
