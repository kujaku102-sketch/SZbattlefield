// Concrete moves from an engine state: each top-level candidate (src/candidates.mjs) is completed with its choices (where a card goes,
// which target an attack takes) by the game's own planners, and each completed move gets the engine call that applies it.
//
// A move is { id, type, action, adapter, uids }:
//   action   the runtime action, with cards named by uid (the trusted side turns it into the runtime's own form to submit it)
//   adapter  { engineFunction, playerId, ... } for applyPreparedRuntimeAction on an engine state (the shapes the runtime's own prepare functions make)
//   uids     the uids the move names, for a CPU that wants to know which cards it touches
// Types made so far: install, recoverRegistry, activateScript, activateAbility (turbo), endTurn, attack, executeCard (on a free slot),
// setScript, redeploy (to a free slot). A candidate of any other type (spells, registry executions, card effects, layered, mounting) has no
// engine call here yet: it is listed in `unsupported` so that nothing is silently dropped.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export async function loadMoves(gameDir) {
  const imp = (p) => import(pathToFileURL(path.join(gameDir, p)).href);
  const attackPlanning = await imp('src/game/runtime/attack-planning.js');
  const executionPlanning = await imp('src/game/runtime/execution-planning.js');

  // context: src/candidates.mjs engineContext; entries: the candidate catalog (planningCatalog) for that context
  function expand(context, entries) {
    const playerId = context.playerId;
    const opponentId = playerId === 'player' ? 'ai' : 'player';
    const opponentSeat = context.metadata.seatIds[opponentId === 'player' ? 0 : 1];
    const moves = []; const unsupported = [];
    const add = (type, action, adapter, uids = []) => moves.push({ id: moves.length, type, action, adapter, uids });
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
          if (destination.hostRef) { unsupported.push('mountCard'); continue; }
          const action = executionPlanning.completeExecution(entry, destination);
          const options = { zone: destination.zone, requestedSlot: destination.slot, ...(entry.actionType === 'setScript' ? { asScript: true } : {}) };
          add(entry.actionType, action, { engineFunction: 'playCard', playerId, uid: entry.base.cardRef, options }, [entry.base.cardRef]);
        }
      } else if (entry.actionType === 'redeploy') {
        for (const destination of executionPlanning.executionDestinations(context, entry)) {
          if (destination.zone === 'registry' || destination.hostRef) { unsupported.push('redeploy'); continue; }
          const action = executionPlanning.completeExecution(entry, destination);
          add('redeploy', action, { engineFunction: 'relogCard', playerId, uid: entry.base.cardRef, targetZone: destination.zone, options: { requestedSlot: destination.slot } }, [entry.base.cardRef]);
        }
      } else unsupported.push(entry.actionType);
    }
    return { moves, unsupported };
  }

  return { expand, opponentSeatOf: (context) => context.metadata.seatIds[context.playerId === 'player' ? 1 : 0] };
}
