// What a match does to the two users' STR and memory, for questions about the first and second player. Used by play.mjs when `limits.trace` is on.
//   trace.before(engineState)           call with the state before a command
//   trace.after(engineState, seatIndex) call with the state after the command (seatIndex: 0 = seat-a, 1 = seat-b, the player who acted)
//   trace.result(firstSeatIndex)        -> { damage: [{turn, victim, dealer, amount}], caps: [{turn, p0, p1}], incidents: [n0, n1], draws... }
// "victim" and "dealer" are seat indexes (0 = seat-a, 1 = seat-b); the caller says who moved first.
const SIDE = ['player', 'ai'];

export function createTrace() {
  const damage = [];
  const caps = [];
  let seenTurn = -1;
  let before = null;
  const snapshot = (state) => SIDE.map((id) => ({ str: state.players[id].fortressStr, cap: state.players[id].baseMemory + state.players[id].permanentMemory,
    memory: state.players[id].memory, incidents: state.players[id].incidentsTriggered.length, hand: state.players[id].hand.length }));
  return {
    before(state) { before = snapshot(state); },
    after(state, actor) {
      const now = snapshot(state);
      if (before) for (let victim = 0; victim < 2; victim += 1) {
        const lost = before[victim].str - now[victim].str;
        if (lost > 0) damage.push({ turn: state.turnNumber, victim, dealer: 1 - victim, amount: lost, by: actor });
      }
      if (state.turnNumber !== seenTurn && !state.opening) { seenTurn = state.turnNumber; caps.push({ turn: state.turnNumber, p0: now[0].cap, p1: now[1].cap, m0: now[0].memory, m1: now[1].memory }); }
      before = now;
    },
    result(firstSeatIndex) {
      const last = before ?? [{ incidents: 0 }, { incidents: 0 }];
      return { first: firstSeatIndex, damage, caps, incidents: [last[0].incidents, last[1].incidents] };
    }
  };
}
