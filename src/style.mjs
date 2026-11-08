// How a CPU plays, counted from the real match (not from what the CPU thinks): the harness shows each accepted command of a seat and the engine state before and after it.
//
//   const style = createStyle();  style.before(engineState, seatIndex, action);  style.after(engineState);  style.summary() -> { 'seat-a': {...}, 'seat-b': {...} }
// Per seat:
//   attacks   { user, card }          attacks on the other user / on a card
//   trades    both the attacker and the card it attacked were destroyed by that attack (a trade)
//   kills     cards of the other side destroyed by the seat's attacks;   lost  its own cards destroyed by its attacks (the attacker dying counts)
//   ends      turns ended, and at each end (before it): hand, registry, front, back cards and the memory left, summed (divide by `ends`)
//   moves     accepted commands by type
// The engine state is read here, in the harness; a CPU never sees it.
const HOLDERS = ['player', 'ai'];
const uidsOf = (player, zones) => new Set(zones.flatMap((zone) => (player[zone] ?? []).map((card) => card.uid)));

export function createStyle() {
  const seats = [0, 1].map(() => ({ attacks: { user: 0, card: 0 }, trades: 0, kills: 0, lost: 0, ends: 0, hand: 0, registry: 0, front: 0, back: 0, memoryLeft: 0, moves: {} }));
  let pending = null;
  return {
    before(state, seat, action) {
      const me = state.players[HOLDERS[seat]]; const other = state.players[HOLDERS[1 - seat]];
      pending = { seat, type: action?.type ?? null, target: action?.target?.kind ?? null,
        mine: uidsOf(me, ['front', 'back']), theirs: uidsOf(other, ['front', 'back']),
        end: action?.type === 'endTurn' ? { hand: me.hand.length, registry: me.registry.length, front: me.front.length, back: me.back.length, memoryLeft: Number(me.memory) || 0 } : null };
    },
    after(state) {
      if (!pending) return;
      const s = seats[pending.seat]; const me = state.players[HOLDERS[pending.seat]]; const other = state.players[HOLDERS[1 - pending.seat]];
      s.moves[pending.type] = (s.moves[pending.type] ?? 0) + 1;
      if (pending.type === 'attack') {
        if (pending.target === 'user') s.attacks.user += 1; else s.attacks.card += 1;
        const nowMine = uidsOf(me, ['front', 'back']); const nowTheirs = uidsOf(other, ['front', 'back']);
        const lost = [...pending.mine].filter((uid) => !nowMine.has(uid)).length; const killed = [...pending.theirs].filter((uid) => !nowTheirs.has(uid)).length;
        s.lost += lost; s.kills += killed;
        if (pending.target !== 'user' && lost > 0 && killed > 0) s.trades += 1;
      } else if (pending.type === 'endTurn' && pending.end) {
        s.ends += 1; for (const key of ['hand', 'registry', 'front', 'back', 'memoryLeft']) s[key] += pending.end[key];
      }
      pending = null;
    },
    summary: () => ({ 'seat-a': seats[0], 'seat-b': seats[1] })
  };
}
