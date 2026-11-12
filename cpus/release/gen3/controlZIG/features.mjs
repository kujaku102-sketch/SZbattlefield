// FROZEN COPY for controlZIG gen3 (cpus/release/gen3/controlZIG.mjs): cpus/learned/features.mjs at commit 0292aef. Do not edit and do not follow changes elsewhere: controlZIG gen3 must play the same for ever.
// Features of a decision, for the CPUs that learn from a teacher (forgehammer) and for the recorder that gathers the teacher's decisions.
// ONE place: the recorder (harness side) and the learned CPU both call these functions, so what is learned and what is run cannot drift apart.
// FEATURE_VERSION and the name lists go into every record header and every generated CPU.
//
// The only input is the seat's own query (its observation and its legal actions): what that seat's screen would show, read as data, no screen
// involved. There is no way in here for an engine state, a re-drawn (determinized) state, or anything of the other side's hand or deck: the opponent's hand
// and deck are counts in the observation, its face-down cards are counts too. A card is described by its properties (cost, ATK, STR, category, keywords,
// whether it has text, layers, sleep ...), never by its name or number. What the seat's own face-down cards are is known to it and may be used.
//
//   queryView(query)                       -> the view every function below reads (a copy of just the fields used)
//   stateFeatures(view)                    -> Float64Array(STATE_NAMES.length)
//   candidateFeatures(ctx, candidate)      -> Float64Array(CAND_NAMES.length)         (φ(s,a): the move, and the state where it matters)
//   decisionFeatures(query, candidates, history) -> { state, cands, entries }           (candidates: cpus/learned/candidates.mjs)
//
// `history` is what the seat itself has done earlier in this turn: { moves, used: Map(`${type}:${cardRef}` -> times) }. It is the seat's own record of its own
// accepted moves, not something read from the game. `entries` are the same features for the legal actions before their options are known (one per entry of
// query.legalActions, in order): a CPU that picks the entry first and only then asks for its options scores those.
export const FEATURE_VERSION = 5;   // 4: what a card's text does (fx_*), after the first 3's features: a CPU made for 3 still reads its (shorter) list
                                    // 5: the user cards of both seats (the numbers and the ability that the observation shows of each), after the 30 state features: a network made for 4 reads the first 30

const KW = ['QA', 'SECURITY', 'CONTACT', 'HACKING', 'ENCRYPTION', 'PROTECT', 'BACKUP', 'LOGIN', 'LOGOUT', 'RESIDENT', 'UPDATE', 'RESPONSE', 'PROXY', 'DECOY'];
const TYPES = ['install', 'recoverRegistry', 'activateScript', 'activateAbility', 'endTurn', 'attack', 'executeCard', 'setScript', 'redeploy', 'executeSpell', 'activateCardEffect', 'other'];
// What a card's effect does, read from its text (what the seat's screen shows of the card), never from its name or number. A kind is 1 when the text has it.
// (the order is part of the feature list: add at the end)
const FX = Object.freeze([
  ['draw', /引く/], ['damage', /ダメージ/], ['self_damage', /\d+ダメージ受ける|自分は\d+ダメージ/], ['heal', /回復/], ['destroy', /破壊/], ['buff', /[+\-＋－]\d+\/[+\-＋－]?\d+/],
  ['mem_up', /メモリ上限を[+＋]/], ['mem_cost', /消費メモリ|実行メモリ|メモリを\d+消費/], ['access', /アクセス/], ['decode', /デコード/], ['drag', /ドラッグ/], ['discard', /捨て/],
  ['ban', /BAN/], ['generate', /生成/], ['sleep', /スリープ/], ['guard', /プロテクト|バックアップ|ファイアウォール|暗号化|デコイ|セキュリティ/], ['registry', /レジストリ/],
  ['trash', /ゴミ箱/], ['to_hand', /手札に加え/], ['mount', /マウント|レイヤー/], ['all', /すべて|全て/],
  ['t_login', /\[ログイン\]/], ['t_logout', /\[ログアウト\]/], ['t_update', /アップデート/], ['t_response', /レスポンス/], ['t_if', /\[(if|条件)/], ['t_turn', /ターン(開始|終了)時/]
]);
const FX_PLACE = ['draw', 'damage', 'destroy', 'buff', 'guard', 'sleep', 'generate', 'access'];   // where the card is put matters for these: the same kinds again for the front and the back
const amountOf = (text, pattern) => { let best = 0; for (const m of text.matchAll(pattern)) best = Math.max(best, Number(m[1]) || 0); return best; };
const FX_CACHE = new Map();
function fxOf(text) {
  let v = FX_CACHE.get(text); if (v) return v;
  v = { flags: FX.map(([, re]) => (re.test(text) ? 1 : 0)), dmgAmt: Math.min(1, amountOf(text, /(\d+)ダメージ/g) / 5), drawAmt: Math.min(1, amountOf(text, /(\d+)枚[^。]*引く/g) / 3) };
  if (FX_CACHE.size < 1000) FX_CACHE.set(text, v);
  return v;
}
const PLACING = new Set(['executeCard', 'setScript', 'redeploy', 'install']);

// v5: the user card of each seat (public: the observation shows both). The numbers (max STR, memory, opening hand, front and back limits, how many incidents and the first threshold) and the ability
// (one of the nine the game has), for me and for the opponent.
const USER_ABILITIES = Object.freeze(['turbo', 'mono_color', 'registry_liberty', 'recovery_boot', 'dimension_innovation', 'do_or_isnt', 'trash_never_empty', 'kickass', 'watching_you']);
const USER_NUMBERS = Object.freeze(['maxstr', 'mem', 'hand0', 'front', 'back', 'inc_n', 'inc_top']);
const userNames = (side) => [...USER_NUMBERS.map((n) => `${side}_u_${n}`), ...USER_ABILITIES.map((a) => `${side}_ab_${a}`)];

export const STATE_NAMES = Object.freeze([
  'turn', 'first', 'my_str', 'opp_str', 'str_diff', 'my_mem', 'my_mem_frac', 'my_cap', 'opp_mem', 'opp_cap',
  'my_hand', 'my_deck', 'my_registry', 'my_back', 'my_trash', 'opp_hand', 'opp_deck', 'opp_registry_up', 'opp_trash',
  'my_obs', 'my_asleep', 'my_ready', 'my_atk', 'my_hp', 'opp_obs', 'opp_asleep', 'opp_atk', 'opp_hp',
  'my_crossed', 'opp_crossed',
  ...userNames('my'), ...userNames('opp')
]);

export const CAND_NAMES = Object.freeze([
  ...TYPES.map((t) => `type_${t}`),
  'cost', 'afford', 'cost_frac', 'mem_left', 'atk', 'hp', 'atk_hp', 'is_ob', 'is_sp', 'is_code', 'is_script', 'has_text',
  ...KW.map((k) => `kw_${k}`), 'layers', 'dest_front', 'dest_back', 'dest_host', 'front_free',
  'atk_user', 'atk_ob', 'a_atk', 'a_hp', 't_atk', 't_hp', 'kills', 'dies', 'dmg_frac', 'lethal', 'crosses', 'tgt_own', 'tgt_foe',
  'end_x_memleft', 'end_x_ready', 'end_x_playable', 'atk_x_strdiff', 'atk_x_oppasleep', 'place_x_boarddiff', 'place_x_hand',
  'cost_rank', 'n_cands', 'max_afford_cost',
  // what the seat has done this turn: this card's move done before, the turn's moves so far, and what is left to try (for ending the turn)
  'used_n', 'moves_done', 'end_x_moves', 'end_x_untried', 'entry_open',
  // the candidate that is no move of this list: what the game's own CPU does with the kinds of action the list has no candidate for
  'type_baseline', 'unsupported_n', 'base_x_memory', 'base_x_hand',
  // what the card's text does (v4)
  ...FX.map(([name]) => `fx_${name}`), 'fx_dmg_amt', 'fx_draw_amt', ...FX_PLACE.flatMap((k) => [`fx_${k}_front`, `fx_${k}_back`])
]);
const IDX = Object.freeze(Object.fromEntries(CAND_NAMES.map((name, i) => [name, i])));

const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

// What is copied out of a card of the observation: its properties, not its name or number.
function cardView(card) {
  const computed = card.computed ?? {};
  const definition = card.definition ?? {};
  const status = card.status ?? {};
  const text = definition.text ?? '';
  return {
    ref: card.cardRef, category: definition.category ?? null,
    cost: num(computed.currentCost ?? definition.cost), atk: num(computed.currentAtk ?? definition.atk), hp: Math.max(0, num(computed.currentStr ?? definition.str)),
    fx: fxOf(String(text)), hasText: text.length > 0 && text !== '(効果なし)', asleep: Boolean(status.sleep), sick: Boolean(status.summoningSick), faceDown: Boolean(card.faceDown),
    keywords: new Set((computed.badges ?? []).map((badge) => badge.name)), layers: (card.mounted ?? []).length
  };
}

// What the observation shows of a user card (public information: both seats see both user cards).
const userView = (user) => ({ maxStr: num(user?.maxFortressStr), memory: num(user?.memory), initialHand: num(user?.initialHand), frontLimit: num(user?.frontLimit), backLimit: num(user?.backLimit),
  incidents: [...(user?.incidents ?? [])], ability: String(user?.abilityKey ?? '') });

// The seat's view of its query: the only reader of the observation.
export function queryView(query) {
  const o = query.observation;
  const me = o.seats.find((seat) => seat.seatId === o.viewerSeat);
  const opp = o.seats.find((seat) => seat.seatId !== o.viewerSeat);
  const cards = (zone) => (zone?.cards ?? []).map(cardView);
  const mine = { hand: cards(me.hand), front: cards(me.front), back: cards(me.back), registry: cards(me.registry) };
  const theirs = { front: cards(opp.front).filter((card) => !card.faceDown), back: cards(opp.back).filter((card) => !card.faceDown) };
  const byRef = new Map();
  for (const card of [...mine.hand, ...mine.front, ...mine.back, ...mine.registry, ...theirs.front, ...theirs.back]) byRef.set(card.ref, card);
  const ownRefs = new Set([...mine.hand, ...mine.front, ...mine.back, ...mine.registry].map((card) => card.ref));
  // The seat's own turn: turn 1 is the first player's, turns alternate (the rule on the first-turn draw does not change that).
  const myTurn = o.activeSeat === o.viewerSeat;
  // Before the first turn (the opening: keeping the hand or drawing again) who goes first is not decided yet: 0.5.
  const opening = (query.legalActions ?? []).some((entry) => entry.kind === 'fixed' && ['keepOpeningHand', 'openingMulligan'].includes(entry.action?.type)) || (query.legalActions ?? []).some((entry) => entry.actionType === 'openingMulligan');
  const first = opening ? 0.5 : (num(o.turnNumber) % 2 === 1) === myTurn ? 1 : 0;
  return {
    turn: num(o.turnNumber), first, viewer: o.viewerSeat, byRef, ownRefs,
    me: {
      str: num(me.fortressStr), memory: num(me.memory?.current), cap: num(me.memory?.max), ...mine,
      handN: me.hand?.count ?? mine.hand.length, deckN: num(me.deck?.count), registryN: num(me.registry?.count), trashN: num(me.trash?.count),
      crossed: (me.incidents ?? []).length, thresholds: [...(me.user?.incidents ?? [])], triggered: [...(me.incidents ?? [])], frontLimit: num(me.user?.frontLimit), backLimit: num(me.user?.backLimit),
      user: userView(me.user)
    },
    opp: {
      str: num(opp.fortressStr), memory: num(opp.memory?.current), cap: num(opp.memory?.max), ...theirs,
      handN: num(opp.hand?.count), deckN: num(opp.deck?.count), trashN: num(opp.trash?.count),
      registryUpN: (opp.registry?.cards ?? []).filter((card) => !card.faceDown).length,
      crossed: (opp.incidents ?? []).length, thresholds: [...(opp.user?.incidents ?? [])], triggered: [...(opp.incidents ?? [])],
      user: userView(opp.user)
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

function userFeatures(u) {
  const incidents = u.incidents ?? [];
  return [u.maxStr / 30, u.memory / 10, u.initialHand / 8, u.frontLimit / 5, u.backLimit / 5, incidents.length / 4, (incidents[0] ?? 0) / 30, ...USER_ABILITIES.map((key) => (u.ability === key ? 1 : 0))];
}

export function stateFeatures(view) {
  const a = board(view.me.front); const b = board(view.opp.front);
  return Float64Array.from([
    view.turn / 20, view.first, view.me.str / 20, view.opp.str / 20, (view.me.str - view.opp.str) / 20,
    view.me.memory / 10, view.me.memory / Math.max(1, view.me.cap), view.me.cap / 10, view.opp.memory / 10, view.opp.cap / 10,
    view.me.handN / 10, view.me.deckN / 30, view.me.registryN / 10, view.me.back.length / 5, view.me.trashN / 20,
    view.opp.handN / 10, view.opp.deckN / 30, view.opp.registryUpN / 10, view.opp.trashN / 20,
    a.obs / 5, a.asleep / 5, a.ready / 5, a.atk / 20, a.hp / 20, b.obs / 5, b.asleep / 5, b.atk / 20, b.hp / 20,
    view.me.crossed / 4, view.opp.crossed / 4,
    ...userFeatures(view.me.user), ...userFeatures(view.opp.user)
  ]);
}

// candidates: [{ kind: 'move' | 'baseline', type, cardRef?, targetRef?, targetUser?, zone?, host? , sig }]  (cpus/learned/candidates.mjs)
export function decisionContext(view, candidates, unsupported, history = { moves: 0, used: new Map() }) {
  const moves = candidates.filter((c) => c.kind === 'move');
  const mine = board(view.me.front); const theirs = board(view.opp.front);
  const acting = (c) => (c.cardRef ? view.byRef.get(c.cardRef) ?? null : null);
  const costs = moves.filter((c) => PLACING.has(c.type)).map((c) => acting(c)?.cost ?? 0);
  const sorted = [...costs].sort((x, y) => x - y);
  const nonEnd = moves.filter((c) => c.type !== 'endTurn').length;
  const maxAfford = Math.max(0, ...moves.filter((c) => c.type !== 'attack' && c.type !== 'endTurn').map((c) => acting(c)?.cost ?? 0).filter((cost) => cost <= view.me.memory));
  const untried = moves.filter((c) => c.type !== 'endTurn' && (history.used.get(`${c.type}:${c.cardRef ?? ''}`) ?? 0) === 0).length;
  return { view, moves, unsupported, mine, theirs, nonEnd, sorted, maxAfford, acting, count: moves.length, history, untried };
}

function crossings(player, strAfter) {
  let n = 0;
  for (const threshold of player.thresholds) if (strAfter <= threshold && !player.triggered.includes(threshold)) n += 1;
  return n;
}

export function candidateFeatures(ctx, c) {
  const { view } = ctx; const f = new Float64Array(CAND_NAMES.length);
  const set = (name, value) => { f[IDX[name]] = value; };
  const typeName = TYPES.includes(c.type) ? c.type : 'other';
  f[IDX[`type_${typeName}`]] = 1;
  const memory = view.me.memory;
  const card = ctx.acting(c);
  if (card) {
    set('cost', card.cost / 10);
    set('afford', card.cost <= memory ? 1 : 0);
    set('cost_frac', Math.min(1, card.cost / Math.max(1, memory)));
    set('mem_left', Math.max(-1, (memory - card.cost) / 10));
    set('atk', card.atk / 10); set('hp', card.hp / 10); set('atk_hp', (card.atk + card.hp) / 20);
    set('is_ob', card.category === 'Ob' ? 1 : 0); set('is_sp', card.category === 'Sp' ? 1 : 0);
    set('is_code', card.category === 'Code' ? 1 : 0); set('is_script', card.category === 'Script' ? 1 : 0);
    set('has_text', card.hasText ? 1 : 0);
    FX.forEach(([name], i) => { if (card.fx.flags[i]) set(`fx_${name}`, 1); });
    set('fx_dmg_amt', card.fx.dmgAmt); set('fx_draw_amt', card.fx.drawAmt);
    if (c.zone === 'front' || c.zone === 'back') FX_PLACE.forEach((k) => { const i = FX.findIndex(([name]) => name === k); if (card.fx.flags[i]) set(`fx_${k}_${c.zone}`, 1); });
    KW.forEach((name) => { if (card.keywords.has(name)) set(`kw_${name}`, 1); });
    set('layers', card.layers / 3);
  }
  if (c.zone === 'front') set('dest_front', 1);
  if (c.zone === 'back') set('dest_back', 1);
  if (c.host) set('dest_host', 1);
  set('front_free', Math.max(0, view.me.frontLimit - view.me.front.length) / 5);
  const target = c.targetRef ? view.byRef.get(c.targetRef) ?? null : null;
  if (c.open) set('entry_open', 1);
  const usedBefore = ctx.history.used.get(`${c.type}:${c.cardRef ?? ''}`) ?? 0;
  if (usedBefore > 0) set('used_n', Math.min(1, usedBefore / 3));
  if (c.type === 'attack' && card) {
    if (!c.open) { set('atk_user', c.targetUser ? 1 : 0); set('atk_ob', c.targetUser ? 0 : 1); }
    set('a_atk', card.atk / 10); set('a_hp', card.hp / 10);
    if (c.open) { /* the target is not known yet */ } else if (target) {
      set('t_atk', target.atk / 10); set('t_hp', target.hp / 10);
      set('kills', card.atk >= target.hp ? 1 : 0); set('dies', target.atk >= card.hp ? 1 : 0);
    } else if (c.targetUser) {
      const after = view.opp.str - card.atk;
      set('dmg_frac', Math.min(1, card.atk / Math.max(1, view.opp.str)));
      set('lethal', after <= 0 ? 1 : 0);
      set('crosses', crossings(view.opp, after) / 4);
    }
    set('atk_x_strdiff', (view.me.str - view.opp.str) / 20);
    set('atk_x_oppasleep', ctx.theirs.asleep / 5);
  } else if (target && !c.open) {
    // a move with a target that is not an attack (a spell, a card effect)
    set('t_atk', target.atk / 10); set('t_hp', target.hp / 10);
    set(view.ownRefs.has(target.ref) ? 'tgt_own' : 'tgt_foe', 1);
  }
  if (c.type === 'endTurn') {
    set('end_x_memleft', memory / 10); set('end_x_ready', ctx.mine.ready / 5); set('end_x_playable', ctx.nonEnd / 20);
    set('end_x_moves', ctx.history.moves / 20); set('end_x_untried', Math.min(1, ctx.untried / 10));
  }
  if (PLACING.has(c.type)) {
    set('place_x_boarddiff', (ctx.mine.obs - ctx.theirs.obs) / 5); set('place_x_hand', view.me.handN / 10);
    const rank = ctx.sorted.length > 1 ? ctx.sorted.filter((cost) => cost < (card?.cost ?? 0)).length / (ctx.sorted.length - 1) : 0;
    set('cost_rank', rank);
    set('max_afford_cost', card && card.cost === ctx.maxAfford && card.cost <= memory ? 1 : 0);
  }
  set('n_cands', ctx.count / 40);
  set('moves_done', Math.min(1, ctx.history.moves / 20));
  return f;
}

export function baselineCandidate(ctx) {
  const f = new Float64Array(CAND_NAMES.length);
  f[IDX.type_baseline] = 1;
  f[IDX.unsupported_n] = Math.min(1, ctx.unsupported.length / 5);
  f[IDX.base_x_memory] = ctx.view.me.memory / 10;
  f[IDX.base_x_hand] = ctx.view.me.handN / 10;
  f[IDX.n_cands] = ctx.count / 40;
  return f;
}

// candidates: the result of buildCandidates(query, queryAction): { cands: [...move candidates], unsupported: [types] }.
// The vectors come in the order of `cands`; one more, at the end, stands for "let the game's own CPU decide" when there are kinds of action with no candidate.
export function decisionFeatures(query, { cands, unsupported }, history = { moves: 0, used: new Map() }, { withEntries = true } = {}) {
  const view = queryView(query);
  const ctx = decisionContext(view, cands, unsupported, history);
  const vectors = cands.map((c) => candidateFeatures(ctx, c));
  if (unsupported.length > 0) vectors.push(baselineCandidate(ctx));
  let entries = null;
  if (withEntries) {
    const ec = entryCandidates(query);
    const ectx = decisionContext(view, ec, unsupported, history);
    entries = ec.map((c) => candidateFeatures(ectx, c));
  }
  return { state: stateFeatures(view), cands: vectors, entries, view };
}

// the legal actions as candidates before their options are known: { type, cardRef, open } (open: there is a pick to make before the action is whole)
export function entryCandidates(query) {
  return query.legalActions.map((entry) => entry.kind === 'fixed'
    ? { kind: 'move', type: entry.action.type, cardRef: entry.action.cardRef ?? null, open: false }
    : { kind: 'move', type: entry.actionType ?? 'other', cardRef: entry.base?.cardRef ?? entry.base?.attackerRef ?? null, open: true });
}
