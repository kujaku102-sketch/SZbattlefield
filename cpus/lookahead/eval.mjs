// The evaluation of an engine state for one side. Generic: it reads numbers and zone sizes, never a card name or a card number.
// It reads the engine state as the sim hands it out (determinized): players[me|opp].{fortressStr, memory, hand, front, back, registry, trash}.
//
// value = w.str * (my fortress STR - theirs) + w.board * (my board - theirs) + w.ready * (my ready attackers - theirs)
//       + w.hand * (my hand - theirs) + w.registry * (my registry - theirs) + w.back * (my set cards - theirs) + w.memory * (my memory - theirs)
// and +/- a very large number when the game is decided.
// A card the state has already scheduled for destruction (a delayed effect that destroys it, e.g. a card brought back until the end of the turn) counts as `doomedKeep` of its worth on the
// board (default 1: counted whole, as before; a CPU that reads the effects of cards sets it to 0: the evaluation is of the board that will be there, not the one that is about to go).
// Two terms are not differences, and are 0 unless a persona (cpus/personas/) sets them: ownStr * (my fortress STR) keeps one's own STR dear, oppBoard * (their board) is an extra
// weight on taking down the other side's board.

export const DEFAULT_WEIGHTS = Object.freeze({ str: 3, board: 1, ready: 1.5, hand: 0.7, registry: 1, back: 0.5, memory: 0.1, hp: 0.6, doomedKeep: 1 });

const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const atkOf = (card) => num(card.atk) + num(card.tempAtk) + num(card.permanentAtk);
const strOf = (card) => num(card.str) + num(card.tempStr) + num(card.permanentStr) - num(card.damage);

function side(player, w, doomed) {
  let board = 0; let ready = 0;
  for (const card of player.front) {
    const attack = atkOf(card); const hp = Math.max(0, strOf(card));
    const keep = doomed.has(card.uid) ? num(w.doomedKeep ?? 1) : 1;
    board += (attack + hp * w.hp) * (card.sleep ? 0.5 : 1) * keep;
    if (!card.sleep && !card.summoningSick && attack > 0 && keep > 0) ready += 1;
  }
  return { str: num(player.fortressStr), board, ready, hand: player.hand.length, registry: player.registry.length, back: player.back.length, memory: num(player.memory) };
}

// state: an engine state; me: 'player' | 'ai'
export function evaluate(state, me, w = DEFAULT_WEIGHTS) {
  const opp = me === 'player' ? 'ai' : 'player';
  if (state.winner === me) return 1e6;
  if (state.winner === opp) return -1e6;
  // the cards a delayed effect of the state will destroy (nothing when the weight keeps them whole: the list is not even read)
  const doomed = new Set(num(w.doomedKeep ?? 1) === 1 ? [] : (state.delayedEffects ?? []).filter((effect) => effect.type === 'destroy_card' && typeof effect.cardUid === 'string').map((effect) => effect.cardUid));
  const a = side(state.players[me], w, doomed); const b = side(state.players[opp], w, doomed);
  return (w.ownStr ?? 0) * a.str - (w.oppBoard ?? 0) * b.board + w.str * (a.str - b.str) + w.board * (a.board - b.board) + w.ready * (a.ready - b.ready)
    + w.hand * (a.hand - b.hand) + w.registry * (a.registry - b.registry) + w.back * (a.back - b.back) + w.memory * (a.memory - b.memory);
}
