// Concrete moves from an engine state: each top-level candidate (src/candidates.mjs) is completed with its choices (where a card goes,
// which target an attack takes) by the game's own planners, and each completed move gets the engine call that applies it.
//
// A move is { id, type, action, adapter, uids, key }:
//   action   the runtime action, with cards named by uid (the trusted side turns it into the runtime's own form to submit it)
//   adapter  { engineFunction, playerId, ... } for applyPreparedRuntimeAction on an engine state (the shapes the runtime's own prepare functions make)
//   uids     the uids the move names, for a CPU that wants to know which cards it touches
//   key      what makes two moves the same move for a CPU that looks one move ahead (src/sim-host.mjs keeps one of each key)
// Two sets of reads (`reads` of expand):
//   basic (the default; what every table made before 2026-11-17 was played with): install, recoverRegistry, activateScript, activateAbility (turbo), endTurn, attack,
//     executeCard (on a free slot), setScript, redeploy (to a free slot). A candidate of any other type (spells, registry executions, card effects, layered, mounting, redeploy to the
//     registry or onto a Code) has no engine call here and is listed in `unsupported` so that nothing is silently dropped.
//   full: also executeSpell (a Sp from the hand), executeRegistry (a card executed from the registry), activateCardEffect (an effect of a card in the hand or on the board),
//     mountCard (executed onto a Code, under an Ob) and redeploy to the registry / onto a Code. Layered execution (executeLayered) and the opening choices are still not read.
//     The choices a move leaves open when the engine applies it (a target, a card to take, a place) are not part of the move: src/sim-windows.mjs answers them.
// The targets and scopes a spell or an effect asks for before it is applied (the runtime's own `executionTargetPlan`) are listed up to MOVE_CAP combinations for each scope (and each
// placement of a registry card), in the order of the plan's candidates. A card cut at the cap is named in `truncated`, so that the cut is not silent. A candidate the planners cannot
// complete (a host or source that is gone, no plan for an effect) is listed in `unsupported` under its type.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const MOVE_CAP = 12;

// what a card that asks for no targets stands for (the plan of a Sp can come back null)
const NO_TARGETS = { candidates: [], minimum: 0, maximum: 0, scopes: [], groups: [] };

// the formula of every key of a move made before the full reads existed: type, the cards it names, where it goes, what an attack goes for
const basicKey = (move) => [move.type, [...move.uids].sort().join(','), move.action.destination?.zone ?? '', move.action.target?.kind ?? ''].join('|');

export async function loadMoves(gameDir) {
  const imp = (p) => import(pathToFileURL(path.join(gameDir, p)).href);
  const attackPlanning = await imp('src/game/runtime/attack-planning.js');
  const executionPlanning = await imp('src/game/runtime/execution-planning.js');

  // The sets of cards a plan accepts as its targets, as the runtime's target options ({ kind: 'card', cardRef } | { kind: 'user', seatId }), at most `cap` of them (onCut is called when more existed):
  // one card of each group when the plan has groups, else every set of the sizes minimum..maximum (the empty set when nothing is asked).
  function targetSets(context, plan, cap, onCut) {
    const options = executionPlanning.targetOptions(context, plan).map(({ label, ...value }) => value);
    if (plan.maximum === 0 && plan.minimum === 0) return [[]];
    if (options.length < plan.minimum) return [];
    const sets = [];
    const clip = () => { if (sets.length <= cap) return sets; onCut?.(); return sets.slice(0, cap); };
    if (plan.groups?.length) {
      const perGroup = plan.groups.map((group) => group.map((card) => context.refFor(card)).filter(Boolean).map((ref) => options.find((option) => option.cardRef === ref)).filter(Boolean));
      const walk = (index, chosen) => {
        if (sets.length > cap) return;
        if (index === perGroup.length) { if (new Set(chosen.map((o) => o.cardRef)).size === chosen.length) sets.push(chosen); return; }
        for (const option of perGroup[index]) walk(index + 1, [...chosen, option]);
      };
      walk(0, []);
      return clip();
    }
    const walk = (start, size, chosen) => {
      if (sets.length > cap) return;
      if (chosen.length === size) { sets.push(chosen); return; }
      for (let i = start; i < options.length; i += 1) walk(i + 1, size, [...chosen, options[i]]);
    };
    for (let size = plan.minimum; size <= Math.min(plan.maximum ?? options.length, options.length); size += 1) walk(0, size, []);
    return clip();
  }

  const sideOf = (context, seatId) => (context.metadata.seatIds[0] === seatId ? 'player' : 'ai');
  const uidOfTarget = (context, target) => (target.kind === 'user' ? `${sideOf(context, target.seatId)}-fortress` : target.cardRef);
  // the options of playCard / executeRegistryCard for the targets and the scope (command/normal-action.js)
  const targetOptionsOf = (context, targets, selectionScope) => {
    const uids = targets.map((target) => uidOfTarget(context, target));
    return { targetUid: uids.length === 1 ? uids[0] : null, targetUids: uids.length > 1 ? uids : [], selectionScope };
  };

  // context: src/candidates.mjs engineContext; entries: the candidate catalog (planningCatalog) for that context
  function expand(context, entries, { reads = 'basic' } = {}) {
    const full = reads === 'full';
    const playerId = context.playerId;
    const opponentId = playerId === 'player' ? 'ai' : 'player';
    const moves = []; const unsupported = [];
    const cut = new Set();
    const add = (type, action, adapter, uids = []) => { const move = { id: moves.length, type, action, adapter, uids }; move.key = basicKey(move); moves.push(move); return move; };
    // a move of the full reads is told from the others by what it does, not only by the cards it names
    const addFull = (type, action, adapter, uids, distinct) => { const move = add(type, action, adapter, uids); move.key = `${move.key}|${distinct}`; };
    const locationOf = (uid) => context.resolve(uid)?.entry.location ?? null;
    for (const entry of entries) {
      if (entry.kind === 'fixed') {
        const { action } = entry;
        if (action.type === 'install') add('install', action, { engineFunction: 'installCard', playerId, uid: action.cardRef }, [action.cardRef]);
        else if (action.type === 'recoverRegistry') add('recoverRegistry', action, { engineFunction: 'recoverRegistryCard', playerId, uid: action.cardRef }, [action.cardRef]);
        else if (action.type === 'activateScript') add('activateScript', action, { engineFunction: 'activateScript', playerId, uid: action.cardRef }, [action.cardRef]);
        else if (action.type === 'activateAbility' && action.ability?.key === 'turbo') add('activateAbility', action, { engineFunction: 'activateTurbo', playerId });
        else if (action.type === 'endTurn') add('endTurn', action, { engineFunction: 'endTurn', playerId });
        else unsupported.push(action.type);
      } else if (entry.actionType === 'attack') {
        for (const target of attackPlanning.attackOptions(context, entry.base.attackerRef)) {
          const action = attackPlanning.completeAttack(entry, target);
          const targetUid = target.kind === 'user' ? `${opponentId}-fortress` : target.cardRef;
          add('attack', action, { engineFunction: 'attack', playerId, attackerUid: entry.base.attackerRef, targetUid },
            target.kind === 'user' ? [entry.base.attackerRef] : [entry.base.attackerRef, target.cardRef]);
        }
      } else if (entry.actionType === 'executeCard' || entry.actionType === 'setScript') {
        for (const destination of executionPlanning.executionDestinations(context, entry)) {
          if (destination.hostRef) {
            if (!full) { unsupported.push('mountCard'); continue; }
            // executed onto a Code (aboveCode) or under an Ob (belowOb): command/normal-action.js
            const action = executionPlanning.completeExecution(entry, destination);
            const host = context.resolve(destination.hostRef);
            if (!host) { unsupported.push('mountCard'); continue; }
            const options = { zone: host.entry.location.zone, [destination.kind === 'aboveCode' ? 'baseUid' : 'underUid']: destination.hostRef };
            addFull('mountCard', action, { engineFunction: 'playCard', playerId, uid: entry.base.cardRef, options }, [entry.base.cardRef, destination.hostRef], `${destination.kind}`);
            continue;
          }
          const action = executionPlanning.completeExecution(entry, destination);
          const options = { zone: destination.zone, requestedSlot: destination.slot, ...(entry.actionType === 'setScript' ? { asScript: true } : {}) };
          add(entry.actionType, action, { engineFunction: 'playCard', playerId, uid: entry.base.cardRef, options }, [entry.base.cardRef]);
        }
      } else if (entry.actionType === 'redeploy') {
        for (const destination of executionPlanning.executionDestinations(context, entry)) {
          if (destination.zone === 'registry' || destination.hostRef) {
            if (!full) { unsupported.push('redeploy'); continue; }
            // to the registry (a card that is taken back), or onto a Code of the other area: command/redeploy-action.js
            const source = locationOf(entry.base.cardRef);
            if (!source || source.kind !== 'board') { unsupported.push('redeploy'); continue; }
            const action = executionPlanning.completeExecution(entry, destination);
            if (destination.zone === 'registry') {
              addFull('redeploy', action, { engineFunction: 'relogCard', playerId, uid: entry.base.cardRef, targetZone: source.zone === 'front' ? 'back' : 'front', options: { requestedSlot: null } },
                [entry.base.cardRef], 'registry');
            } else {
              addFull('redeploy', action, { engineFunction: 'relogCard', playerId, uid: entry.base.cardRef, targetZone: destination.zone, options: { requestedSlot: null, baseUid: destination.hostRef } },
                [entry.base.cardRef, destination.hostRef], 'onto');
            }
            continue;
          }
          const action = executionPlanning.completeExecution(entry, destination);
          add('redeploy', action, { engineFunction: 'relogCard', playerId, uid: entry.base.cardRef, targetZone: destination.zone, options: { requestedSlot: destination.slot } }, [entry.base.cardRef]);
        }
      } else if (full && entry.actionType === 'executeSpell') {
        // a Sp from the hand: the targets and the scope the card asks for before it is applied (most Sp ask for nothing here and open a choice when they are applied)
        const plan = executionPlanning.executionTargetPlan(context, entry) ?? NO_TARGETS;
        const scopes = plan.scopes?.length ? plan.scopes : [null];
        for (const selectionScope of scopes) for (const targets of targetSets(context, plan, MOVE_CAP, () => cut.add(entry.base.cardRef))) {
          const options = targetOptionsOf(context, targets, selectionScope);
          addFull('executeSpell', { type: 'executeSpell', cardRef: entry.base.cardRef, targets, selectionScope },
            { engineFunction: 'playCard', playerId, uid: entry.base.cardRef, options },
            [entry.base.cardRef, ...targets.map((target) => uidOfTarget(context, target))], `${selectionScope ?? ''}`);
        }
      } else if (full && entry.actionType === 'executeRegistry') {
        // a card executed from the registry: where it goes (none for a Sp), and the targets and the scope of a Sp
        const card = context.resolve(entry.base.cardRef)?.card;
        if (!card) { unsupported.push('executeRegistry'); continue; }
        for (const placement of executionPlanning.executionPlacements(context, entry)) {
          const { hostRef } = placement;
          let options = {};
          if (placement.kind === 'slot' || placement.kind === 'asScript') options = { zone: placement.kind === 'asScript' ? 'back' : placement.zone, requestedSlot: placement.slot, ...(placement.kind === 'asScript' ? { asScript: true } : {}) };
          else if (placement.kind === 'aboveCode' || placement.kind === 'belowOb') {
            const host = context.resolve(hostRef);
            if (!host) { unsupported.push('executeRegistry'); continue; }
            options = { zone: host.entry.location.zone, [placement.kind === 'aboveCode' ? 'baseUid' : 'underUid']: hostRef };
          }
          let plan = card.category === 'Sp' ? executionPlanning.executionTargetPlan(context, entry) : null;
          plan ??= NO_TARGETS;
          const scopes = plan.scopes?.length ? plan.scopes : [null];
          for (const selectionScope of scopes) for (const targets of targetSets(context, plan, MOVE_CAP, () => cut.add(entry.base.cardRef))) {
            const withTargets = card.category === 'Sp' ? { ...options, ...targetOptionsOf(context, targets, selectionScope) } : options;
            addFull('executeRegistry', { type: 'executeRegistry', cardRef: entry.base.cardRef, placement, targets, selectionScope },
              { engineFunction: 'executeRegistryCard', playerId, uid: entry.base.cardRef, options: withTargets },
              [entry.base.cardRef, ...(hostRef ? [hostRef] : []), ...targets.map((target) => uidOfTarget(context, target))],
              // no slot here: free slots are one move to the host, which keeps one of each key (as executeCard does)
              `${placement.kind}:${placement.zone ?? ''}:${selectionScope ?? ''}`);
          }
        }
      } else if (full && entry.actionType === 'activateCardEffect') {
        // an effect of a card in the hand or on the board that the player starts (the runtime's own list of effects and, for each, its targets)
        for (const { effectKey } of executionPlanning.executionEffects(context, entry)) {
          const plan = executionPlanning.executionTargetPlan(context, entry, effectKey);
          if (!plan) { unsupported.push('activateCardEffect'); continue; }
          for (const targets of targetSets(context, plan, MOVE_CAP, () => cut.add(entry.base.cardRef))) {
            const zones = plan.needsZone ? (executionPlanning.executionTargetPlan(context, entry, effectKey, targets)?.zones ?? []) : [null];
            if (!zones.length) unsupported.push('activateCardEffect');
            for (const targetZone of zones) {
              const uids = targets.map((target) => uidOfTarget(context, target));
              addFull('activateCardEffect', { type: 'activateCardEffect', cardRef: entry.base.cardRef, effectKey, targets, targetZone },
                { engineFunction: 'activateCardEffect', playerId, uid: entry.base.cardRef, effectId: plan.effect.id,
                  options: { targetUid: uids.length === 1 ? uids[0] : null, targetUids: uids.length > 1 ? uids : [], targetZone } },
                [entry.base.cardRef, ...uids], `${effectKey}:${targetZone ?? ''}`);
            }
          }
        }
      } else unsupported.push(entry.actionType);
    }
    return { moves, unsupported, truncated: [...cut] };
  }

  return { expand, opponentSeatOf: (context) => context.metadata.seatIds[context.playerId === 'player' ? 1 : 0] };
}
