// Features of a decision, for the CPUs that learn from a teacher (forgehammer) and for the recorder that gathers the teacher's decisions.
// ONE place: the recorder (harness side) and the learned CPU (cpus/forged-*.mjs) both call these functions, so what is learned and what is
// run cannot drift apart. FEATURE_VERSION and the name lists go into every record header and every generated CPU.
//
// What a seat may see (the rule of this file): everything of its own side except the order of its deck; of the other side only what is face
// up, and the plain numbers (strength, memory, counts of hand / deck / registry / trash). `seatView()` is the ONLY place that reads an engine
// state, and it copies out just that; everything below reads the copy. The opponent's hand and deck contents, and face-down cards of the
// opponent, are never read. A card is described by its properties (cost, ATK, STR, category, keywords, whether it has text), never by its
// name or number.
//
// state features   stateFeatures(view)                  -> Float64Array(STATE_NAMES.length)   (what a value model reads)
// candidate        candidateFeatures(ctx, move)         -> Float64Array(CAND_NAMES.length)    (φ(s,a): the move, and the state where it matters)
// decision         decisionFeatures(state, me, moves, unsupported) -> { state, cands: Float64Array[] }
//                  when the decision has kinds of action with no move in the list (`unsupported`), one more candidate stands for "let the game's
//                  own CPU decide" (index moves.length); a CPU that picks it returns view.baseline()
export const FEATURE_VERSION = 1;

const KW = ['QA', 'SECURITY', 'CONTACT', 'HACKING', 'ENCRYPTION', 'PROTECT', 'BACKUP', 'LOGIN', 'LOGOUT', 'RESIDENT', 'UPDATE', 'RESPONSE', 'PROXY', 'DECOY'];
const TYPES = ['install', 'recoverRegistry', 'activateScript', 'activateAbility', 'endTurn', 'attack', 'executeCard', 'setScript', 'redeploy'];

export const STATE_NAMES = Object.freeze([
  'turn', 'first', 'my_str', 'opp_str', 'str_diff', 'my_mem', 'my_mem_frac', 'my_cap', 'opp_mem', 'opp_cap',
  'my_hand', 'my_deck', 'my_registry', 'my_back', 'my_trash', 'opp_hand', 'opp_deck', 'opp_registry_up', 'opp_trash',
  'my_obs', 'my_asleep', 'my_ready', 'my_atk', 'my_hp', 'opp_obs', 'opp_asleep', 'opp_atk', 'opp_hp',
  'my_crossed', 'opp_crossed'
]);

export const CAND_NAMES = Object.freeze([
  ...TYPES.map((t) => `type_${t}`),
  'cost', 'afford', 'cost_frac', 'mem_left', 'atk', 'hp', 'atk_hp', 'is_ob', 'is_sp', 'is_code', 'is_script', 'has_text',
  ...KW.map((k) => `kw_${k}`), 'layers', 'dest_front', 'dest_back', 'front_free',
  'atk_user', 'atk_ob', 'a_atk', 'a_hp', 't_atk', 't_hp', 'kills', 'dies', 'dmg_frac', 'lethal', 'crosses',
  'end_x_memleft', 'end_x_ready', 'end_x_playable', 'atk_x_strdiff', 'atk_x_oppasleep', 'place_x_boarddiff', 'place_x_hand',
  'cost_rank', 'n_cands', 'max_afford_cost',
  // the move that is not a move of this list: what the game's own CPU does with the kinds of action the list has no move for (spells, card effects, ...)
  'type_baseline', 'unsupported_n', 'base_x_memory', 'base_x_hand'
]);
const IDX = Object.freeze(Object.fromEntries(CAND_NAMES.map((name, i) => [name, i])));

const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const atkOf = (card) => num(card.atk) + num(card.tempAtk) + num(card.permanentAtk);
const hpOf = (card) => Math.max(0, num(card.str) + num(card.tempStr) + num(card.permanentStr) - num(card.damage));

// What is copied out of a card: its properties, not its name or number.
function cardView(card) {
  const keywords = new Set();
  for (const keyword of card.compiled?.keywords ?? []) if (keyword.intrinsic !== false) keywords.add(keyword.name);
  for (const name of card.grantedKeywords ?? []) keywords.add(name);
  return {
    uid: card.uid, category: card.category, cost: num(card.cost), atk: atkOf(card), hp: hpOf(card), hasText: Boolean(card.text && String(card.text).length > 0),
    asleep: Boolean(card.sleep), sick: Boolean(card.summoningSick), faceDown: Boolean(card.faceDown), keywords, layers: (card.mounted ?? []).length
  };
}

// The seat's view of an engine state. The only reader of the state.
export function seatView(state, me) {
  const opp = me === 'player' ? 'ai' : 'player';
  const P = state.players[me]; const O = state.players[opp];
  const crossed = (player) => (player.incidentsTriggered ?? []).length;
  const upCards = (cards) => cards.filter((card) => !card.faceDown).map(cardView);
  return {
    turn: num(state.turnNumber), first: state.firstPlayer === me,
    me: {
      str: num(P.fortressStr), memory: num(P.memory), cap: num(P.baseMemory) + num(P.permanentMemory),
      hand: P.hand.map(cardView), front: P.front.map(cardView), back: P.back.map(cardView), registry: P.registry.map(cardView),
      deckN: P.deck.length, trashN: P.trash.length, crossed: crossed(P), thresholds: [...(P.user?.incidents ?? [])], triggered: [...(P.incidentsTriggered ?? [])],
      frontLimit: num(P.user?.frontLimit), backLimit: num(P.user?.backLimit)
    },
    opp: {
      str: num(O.fortressStr), memory: num(O.memory), cap: num(O.baseMemory) + num(O.permanentMemory),
      handN: O.hand.length, deckN: O.deck.length, trashN: O.trash.length, registryUpN: O.registry.filter((card) => !card.faceDown).length,
      front: upCards(O.front), back: upCards(O.back), crossed: crossed(O), thresholds: [...(O.user?.incidents ?? [])], triggered: [...(O.incidentsTriggered ?? [])]
    }
  };
}

function board(cards) {
  let obs = 0; let asleep = 0; let ready = 0; let atk = 0; let hp = 0;
  for (const card of cards) {
    if (card.category !== 'Ob') continue;
    obs += 1; atk += card.atk; hp += card.hp;
    if (card.asleep) asleep += 1; else if (!card.sick && card.atk > 0) ready += 1;
  }
  return { obs, asleep, ready, atk, hp };
}

export function stateFeatures(view) {
  const a = board(view.me.front); const b = board(view.opp.front);
  return Float64Array.from([
    view.turn / 20, view.first ? 1 : 0, view.me.str / 20, view.opp.str / 20, (view.me.str - view.opp.str) / 20,
    view.me.memory / 10, view.me.memory / Math.max(1, view.me.cap), view.me.cap / 10, view.opp.memory / 10, view.opp.cap / 10,
    view.me.hand.length / 10, view.me.deckN / 30, view.me.registry.length / 10, view.me.back.length / 5, view.me.trashN / 20,
    view.opp.handN / 10, view.opp.deckN / 30, view.opp.registryUpN / 10, view.opp.trashN / 20,
    a.obs / 5, a.asleep / 5, a.ready / 5, a.atk / 20, a.hp / 20, b.obs / 5, b.asleep / 5, b.atk / 20, b.hp / 20,
    view.me.crossed / 4, view.opp.crossed / 4
  ]);
}

// A context for the moves of one decision: the seat's view and what is looked up for every move.
export function decisionContext(view, moves) {
  const byUid = new Map();
  for (const card of [...view.me.hand, ...view.me.front, ...view.me.back, ...view.me.registry, ...view.opp.front, ...view.opp.back]) byUid.set(card.uid, card);
  const acting = (move) => (move.uids.length > 0 ? byUid.get(move.uids[0]) ?? null : null);
  const mine = board(view.me.front); const theirs = board(view.opp.front);
  const nonEnd = moves.filter((move) => move.type !== 'endTurn').length;
  // the cost rank of each move that plays a card, among the moves that play a card
  const costs = moves.filter((move) => ['executeCard', 'setScript', 'redeploy', 'install'].includes(move.type)).map((move) => acting(move)?.cost ?? 0);
  const sorted = [...costs].sort((x, y) => x - y);
  const maxAfford = Math.max(0, ...moves.filter((move) => move.type !== 'attack' && move.type !== 'endTurn').map((move) => acting(move)?.cost ?? 0).filter((cost) => cost <= view.me.memory));
  return { view, moves, byUid, acting, mine, theirs, nonEnd, sorted, maxAfford };
}

function crossings(player, strAfter) {
  let n = 0;
  for (const threshold of player.thresholds) if (strAfter <= threshold && !player.triggered.includes(threshold)) n += 1;
  return n;
}

export function candidateFeatures(ctx, move) {
  const { view } = ctx; const f = new Float64Array(CAND_NAMES.length);
  const set = (name, value) => { f[IDX[name]] = value; };
  const typeIndex = TYPES.indexOf(move.type);
  if (typeIndex >= 0) f[typeIndex] = 1;
  const memory = view.me.memory;
  const card = ctx.acting(move);
  if (card) {
    set('cost', card.cost / 10);
    set('afford', card.cost <= memory ? 1 : 0);
    set('cost_frac', Math.min(1, card.cost / Math.max(1, memory)));
    set('mem_left', Math.max(-1, (memory - card.cost) / 10));
    set('atk', card.atk / 10); set('hp', card.hp / 10); set('atk_hp', (card.atk + card.hp) / 20);
    set('is_ob', card.category === 'Ob' ? 1 : 0); set('is_sp', card.category === 'Sp' ? 1 : 0);
    set('is_code', card.category === 'Code' ? 1 : 0); set('is_script', card.category === 'Script' ? 1 : 0);
    set('has_text', card.hasText ? 1 : 0);
    KW.forEach((name) => { if (card.keywords.has(name)) set(`kw_${name}`, 1); });
    set('layers', card.layers / 3);
  }
  if (move.zone === 'front') set('dest_front', 1);
  if (move.zone === 'back') set('dest_back', 1);
  set('front_free', Math.max(0, view.me.frontLimit - view.me.front.length) / 5);
  const place = ['executeCard', 'setScript', 'redeploy', 'install'].includes(move.type);
  if (move.type === 'attack' && card) {
    const toUser = move.targetKind ? move.targetKind === 'user' : move.uids.length < 2;
    const target = toUser ? null : ctx.byUid.get(move.uids[1]) ?? null;
    set('atk_user', toUser ? 1 : 0); set('atk_ob', toUser ? 0 : 1);
    set('a_atk', card.atk / 10); set('a_hp', card.hp / 10);
    if (target) {
      set('t_atk', target.atk / 10); set('t_hp', target.hp / 10);
      set('kills', card.atk >= target.hp ? 1 : 0); set('dies', target.atk >= card.hp ? 1 : 0);
    } else if (toUser) {
      const after = view.opp.str - card.atk;
      set('dmg_frac', Math.min(1, card.atk / Math.max(1, view.opp.str)));
      set('lethal', after <= 0 ? 1 : 0);
      set('crosses', crossings(view.opp, after) / 4);
    }
    set('atk_x_strdiff', (view.me.str - view.opp.str) / 20);
    set('atk_x_oppasleep', ctx.theirs.asleep / 5);
  }
  if (move.type === 'endTurn') {
    set('end_x_memleft', memory / 10); set('end_x_ready', ctx.mine.ready / 5); set('end_x_playable', ctx.nonEnd / 20);
  }
  if (place) {
    set('place_x_boarddiff', (ctx.mine.obs - ctx.theirs.obs) / 5); set('place_x_hand', view.me.hand.length / 10);
    const rank = ctx.sorted.length > 1 ? ctx.sorted.filter((cost) => cost < (card?.cost ?? 0)).length / (ctx.sorted.length - 1) : 0;
    set('cost_rank', rank);
    set('max_afford_cost', card && card.cost === ctx.maxAfford && card.cost <= memory ? 1 : 0);
  }
  set('n_cands', ctx.moves.length / 40);
  return f;
}

// state: an engine state (a determinized one, from the sim); me: 'player' | 'ai'; moves: [{ id, type, uids, zone?, targetKind? }]
export function decisionFeatures(state, me, moves, unsupported = []) {
  const view = seatView(state, me);
  const ctx = decisionContext(view, moves);
  const cands = moves.map((move) => candidateFeatures(ctx, move));
  if (unsupported.length > 0) cands.push(baselineCandidate(ctx, unsupported));
  return { state: stateFeatures(view), cands };
}

export function baselineCandidate(ctx, unsupported) {
  const f = new Float64Array(CAND_NAMES.length);
  f[IDX.type_baseline] = 1;
  f[IDX.unsupported_n] = Math.min(1, unsupported.length / 5);
  f[IDX.base_x_memory] = ctx.view.me.memory / 10;
  f[IDX.base_x_hand] = ctx.view.me.hand.length / 10;
  f[IDX.n_cands] = ctx.moves.length / 40;
  return f;
}
