// Candidate moves from an ENGINE state, without the runtime's query: no identity index, no reference frame, no reference tokens.
//
// The game's own planner (planningCatalog and the execution / attack planners it uses) already asks the engine: it works on a small
// "planning context" ({ state, playerId, viewerSeat, metadata, engine, revision, refFor, resolve, view }). The runtime builds that
// context from a validated authority, an identity index and the reference state (about 10 ms). Here the context is built straight
// from an engine state, and a card is named by its uid instead of a reference token:
//     refFor(card) = card.uid     resolve(uid) = { card, entry: { controllerSeat, ownerSeat, location } }     view(name) = the state itself
// So the candidate set is the game's own, computed on whatever engine state it is given (the real one, or a determinized copy).
//
// A card the seat cannot name (the opponent's face-down card) has no name here either (refFor gives null), as in the runtime.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export async function loadCandidates(gameDir) {
  const imp = (p) => import(pathToFileURL(path.join(gameDir, p)).href);
  const legal = await imp('src/game/runtime/legal-actions.js');

  // Where every card of the state is, in the terms the planners read: board (front/back) or zone, and who controls it.
  function entriesOf(state, seatIds) {
    const seatOf = { player: seatIds[0], ai: seatIds[1] };
    const entries = new Map();
    const visit = (card, holder, zone, mountedOn) => {
      const board = zone === 'front' || zone === 'back';
      entries.set(card.uid, { card, entry: { controllerSeat: seatOf[holder], ownerSeat: seatOf[card.owner] ?? seatOf[holder],
        location: board ? { kind: 'board', seatId: seatOf[holder], zone } : { kind: 'zone', seatId: seatOf[holder], zone }, mountedOn } });
      for (const child of card.mounted ?? []) visit(child, holder, zone, card.uid);
    };
    for (const holder of ['player', 'ai']) for (const zone of ['deck', 'hand', 'front', 'back', 'registry', 'trash', 'ban']) for (const card of state.players[holder][zone]) visit(card, holder, zone, null);
    return entries;
  }

  function engineContext(state, metadata, viewerSeat) {
    const seatIds = metadata.seatIds;
    const playerId = seatIds[0] === viewerSeat ? 'player' : 'ai';
    const hasResult = state.winner !== null || state.victory?.lockedOutcome != null || state.victory?.finished === true;
    const engine = { mode: state.mode, active: state.active, hasResult, busy: false, opening: state.opening !== undefined };
    const allowed = state.mode !== 'tutorial' && !hasResult && state.active === playerId;
    const base = { metadata, revision: 0, engine, playerId, viewerSeat, allowed };
    if (!allowed) return base;
    const entries = entriesOf(state, seatIds);
    return {
      ...base, state,
      refFor(card) {
        const known = entries.get(card.uid);
        if (!known) return null;
        // the seat cannot name what it cannot see (the opponent's face-down cards), and the query lists no face-down card of a registry, trash or ban
        // (only their number), so the runtime offers no move on one either
        if (card.faceDown === true && (known.entry.controllerSeat !== viewerSeat || known.entry.location.zone === 'registry' || known.entry.location.zone === 'trash' || known.entry.location.zone === 'ban')) return null;
        return card.uid;
      },
      resolve(uid) { return entries.get(uid) ?? null; },
      view() { return state; }
    };
  }

  // A choice is open (the engine waits for an answer): the same four signs the runtime reads before it offers or accepts a move.
  const choiceOpen = (state) => (state.pending ?? null) !== null || (state.prompt ?? null) !== null
    || state.effectResolution?.status === 'awaiting-choice' || (state.securityRestWindow ?? null) !== null;

  // The seat's top-level moves on this engine state: the game's planningCatalog on the engine context. Nothing is offered while a choice is open.
  function catalog(state, metadata, viewerSeat) {
    if (choiceOpen(state)) return [];
    return legal.planningCatalog(engineContext(state, metadata, viewerSeat));
  }

  return { engineContext, catalog, entriesOf };
}
