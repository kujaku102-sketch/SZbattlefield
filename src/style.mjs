// How a CPU plays, counted from the real match (not from what the CPU thinks): the harness shows each accepted command of a seat and the engine state before and after it.
//
//   const style = createStyle();  style.before(engineState, seatIndex, action);  style.after(engineState, recordedAction);  style.summary() -> { 'seat-a': {...}, 'seat-b': {...} }
// Per seat:
//   attacks   { user, card }          attacks on the other user / on a card
//   trades    both the attacker and the card it attacked were destroyed by that attack (a trade)
//   kills     cards of the other side destroyed by the seat's attacks;   lost  its own cards destroyed by its attacks (the attacker dying counts)
//   ends      turns ended, and at each end (before it): hand, registry, front, back cards and the memory left, summed (divide by `ends`)
//   moves     accepted commands by type
//   cards     { "<card id>": [came, executed, left, activated] } for the seat's OWN cards: came = copies that were in its hand or registry at some point of the match (its opening hand,
//             its draws, what it installed), executed = executions of the card (executeCard, executeSpell, setScript, executeLayered, executeRegistry, mountCard), left = copies that came and
//             were never executed, activated = activations of the card's effect or script once it is on the board (activateCardEffect, activateScript). summary().names maps card id -> name.
// The engine state is read here, in the harness; a CPU never sees it.
const HOLDERS = ['player', 'ai'];
const uidsOf = (player, zones) => new Set(zones.flatMap((zone) => (player[zone] ?? []).map((card) => card.uid)));
const EXECUTIONS = new Set(['executeCard', 'executeSpell', 'setScript', 'executeLayered', 'executeRegistry', 'mountCard']);
const ACTIVATIONS = new Set(['activateCardEffect', 'activateScript']);
const PLUGINS = new Set(['Plugin', 'P-in']);      // a Plugin works only in the registry (rulebook 4.6): installing it is how it is used, so its installation counts as its execution
const instanceOf = (card) => card.identity?.instanceId ?? card.uid;      // the match record names a card "card:<instance id>"

export function createStyle() {
  const seats = [0, 1].map(() => ({ attacks: { user: 0, card: 0 }, trades: 0, kills: 0, lost: 0, ends: 0, hand: 0, registry: 0, front: 0, back: 0, memoryLeft: 0, moves: {} }));
  let pending = null;
  const seen = [new Map(), new Map()];       // by seat: uid -> { id, name, executed }
  const names = {};
  const observe = (state) => {
    for (const seat of [0, 1]) for (const zone of ['hand', 'registry']) for (const card of state.players[HOLDERS[seat]][zone] ?? []) {
      if (!seen[seat].has(instanceOf(card))) seen[seat].set(instanceOf(card), { id: card.id, executed: 0 });
      names[card.id] ??= card.name;
    }
  };
  return {
    before(state, seat, action) {
      const me = state.players[HOLDERS[seat]]; const other = state.players[HOLDERS[1 - seat]];
      observe(state);
      pending = { seat, type: action?.type ?? null, target: action?.target?.kind ?? null,
        mine: uidsOf(me, ['front', 'back']), theirs: uidsOf(other, ['front', 'back']),
        end: action?.type === 'endTurn' ? { hand: me.hand.length, registry: me.registry.length, front: me.front.length, back: me.back.length, memoryLeft: Number(me.memory) || 0 } : null };
    },
    // recorded: the command as the match record writes it (cards named "card:<uid>"), to know which card an execution was
    after(state, recorded = null) {
      if (!pending) return;
      const s = seats[pending.seat]; const me = state.players[HOLDERS[pending.seat]]; const other = state.players[HOLDERS[1 - pending.seat]];
      s.moves[pending.type] = (s.moves[pending.type] ?? 0) + 1;
      const ref = typeof recorded?.cardRef === 'string' && recorded.cardRef.startsWith('card:') ? recorded.cardRef.slice(5) : null;
      const pluginInstall = pending.type === 'install' && ref !== null && (me.registry ?? []).some((c) => instanceOf(c) === ref && PLUGINS.has(c.category ?? c.printedCategory));
      const uid = ref !== null && (EXECUTIONS.has(pending.type) || pluginInstall) ? ref : null;
      if (uid) {
        const card = seen[pending.seat].has(uid) ? null : ['hand', 'registry', 'front', 'back', 'trash'].flatMap((zone) => me[zone] ?? []).find((c) => instanceOf(c) === uid);
        const entry = seen[pending.seat].get(uid) ?? { id: card?.id ?? uid, executed: 0 };    // a card that did not come through the hand or the registry came by the execution itself
        entry.executed += 1; seen[pending.seat].set(uid, entry); if (card) names[card.id] ??= card.name;
      }
      const source = ACTIVATIONS.has(pending.type) && typeof recorded?.cardRef === 'string' && recorded.cardRef.startsWith('card:') ? seen[pending.seat].get(recorded.cardRef.slice(5)) : null;
      if (source) source.activated = (source.activated ?? 0) + 1;      // a card that never came through the hand or the registry (placed by an effect) is not counted here
      observe(state);
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
    summary() {
      const cardsOf = (seat) => {
        const out = {};
        for (const entry of seen[seat].values()) { const c = (out[entry.id] ??= [0, 0, 0, 0]); c[0] += 1; c[1] += entry.executed; if (entry.executed === 0) c[2] += 1; c[3] += entry.activated ?? 0; }
        return out;
      };
      return { 'seat-a': { ...seats[0], cards: cardsOf(0) }, 'seat-b': { ...seats[1], cards: cardsOf(1) }, names };
    }
  };
}
