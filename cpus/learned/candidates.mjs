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

// Returns { cands, unsupported: [type, ...], planCalls }.
export function buildCandidates(query, queryAction) {
  const revision = query.status.revision;
  const cands = []; const unsupported = []; let planCalls = 0;
  for (const entry of query.legalActions) {
    if (entry.kind === 'fixed') { cands.push(fromAction(entry, entry.action)); continue; }
    if (entry.kind !== 'intent' || typeof queryAction !== 'function') { unsupported.push(entry.actionType ?? entry.kind); continue; }
    planCalls += 1;
    const planned = queryAction({ expectedRevision: revision, actionId: entry.actionId, selections: [] });
    if (!planned.ok) { unsupported.push(entry.actionType); continue; }
    if (planned.value.completion) { cands.push({ ...fromAction(entry, planned.value.completion.action), complete: planned.value.completion.action }); continue; }
    const requests = planned.value.selectionRequests ?? [];
    if (requests.length !== 1 || !isSinglePick(requests[0])) { unsupported.push(entry.actionType); continue; }
    const seen = new Set(); let made = 0;
    for (const option of requests[0].options) {
      const candidate = fromOption(entry, requests[0], option);
      if (!candidate) break;
      if (seen.has(candidate.sig)) continue;
      seen.add(candidate.sig); cands.push(candidate); made += 1;
    }
    if (made === 0) unsupported.push(entry.actionType);
  }
  return { cands, unsupported, planCalls };
}

// The final action of a chosen candidate (a fixed one is the entry's own action; a planned one needs one more planning call). null if the planner refuses.
export function completeCandidate(query, candidate, queryAction) {
  if (candidate.entry.kind === 'fixed') return structuredClone(candidate.entry.action);
  if (candidate.complete) return structuredClone(candidate.complete);
  const planned = queryAction({ expectedRevision: query.status.revision, actionId: candidate.entry.actionId,
    selections: [{ requestId: candidate.request.requestId, optionIds: [candidate.option.optionId], allocation: [] }] });
  return planned.ok && planned.value.completion ? structuredClone(planned.value.completion.action) : null;
}
