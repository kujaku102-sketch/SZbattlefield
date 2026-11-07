// The words for a decision: what a seat sees, and its legal moves, written out so that someone who reads (a person auditing, a language model) can choose one.
// Made from the seat's query alone (its observation and the candidates made from its legal actions): the opponent's hand and deck are counts there, so they are counts here.
// Card names and rule texts are written in: the seat sees them, and a reader needs them to judge a move (the learned features do not use them; this is not a feature).
//
//   buildPrompt(query, candidates)  ->  { version, system, user, candidates: [{ n, label, sig }] }       n is 1-based, in the order of `candidates`
// The same query and candidates always give the same text. PROMPT_VERSION changes with the wording.
export const PROMPT_VERSION = 1;

const SYSTEM = [
  'あなたはカードゲーム「Siege÷Zeke」を遊ぶユーザーの1人です。相手ユーザーのフォートレスのSTRを0にすると勝ちます。',
  'ターンの中では、メモリを使ってカード(Ob・Code・Sp・Script)を実行・設置し、フロントのObで攻撃し、終えるときはターンを終了します。',
  'Obはスリープしていると攻撃できず、置いたターンは原則として攻撃できません。攻撃は相手ユーザーかスリープ中の相手Obに向けます。',
  '見えているのは、自分の手札・場・レジストリと、相手の場・枚数だけです。相手の手札や山札の中身は分かりません。',
  '与えられた番号つきの選択肢から、いまの局面で最もよい手を1つ選んでください。'
].join('\n');

const FORMAT = '答えは次のJSONだけで返してください: {"choice": 選択肢の番号, "reason": "理由を一文で"}';

const cardLine = (card) => {
  const c = card.computed ?? {}; const d = card.definition ?? {}; const s = card.status ?? {};
  const kind = d.category ?? '?';
  const stats = kind === 'Ob' ? ` ATK${c.currentAtk ?? d.atk}/STR${c.currentStr ?? d.str}${(c.maxStr ?? d.str) !== (c.currentStr ?? d.str) ? `(最大${c.maxStr})` : ''}` : '';
  const flags = [s.sleep ? 'スリープ' : null, s.summoningSick ? '配置ターン' : null, card.faceDown ? '伏せ' : null, (card.mounted ?? []).length > 0 ? `レイヤー${(card.mounted ?? []).length}` : null,
    ...(c.badges ?? []).map((b) => `[${b.name}${b.value !== null && b.value !== undefined ? `:${b.value}` : ''}]`)].filter(Boolean);
  return `${d.name ?? '(伏せ)'}〈${kind}〉コスト${c.currentCost ?? d.cost ?? '-'}${stats}${flags.length ? ` ${flags.join(' ')}` : ''}`;
};

function nameIndex(observation) {
  const byRef = new Map(); const own = observation.viewerSeat;
  const ZONE = { hand: '手札', front: 'フロント', back: 'バック', registry: 'レジストリ', trash: 'ゴミ箱' };
  for (const seat of observation.seats) for (const zone of ['hand', 'front', 'back', 'registry', 'trash']) (seat[zone]?.cards ?? []).forEach((card, i) => byRef.set(card.cardRef, { card, seat: seat.seatId, zone, where: `${seat.seatId === own ? '' : '相手の'}${ZONE[zone]}${i + 1}` }));
  return { byRef, own };
}

function labelOf(candidate, index) {
  const find = (ref) => (ref ? index.byRef.get(ref)?.card ?? null : null);
  const name = (ref) => { const e = ref ? index.byRef.get(ref) : null; return e ? `「${e.card.definition?.name ?? '?'}」(${e.where})` : '(不明)'; };
  const zoneText = (zone) => (zone === 'front' ? 'フロント' : zone === 'back' ? 'バック' : zone ?? '');
  switch (candidate.type) {
    case 'endTurn': return 'ターンを終了する';
    case 'install': return `インストール: ${name(candidate.cardRef)}を手札からレジストリへ`;
    case 'recoverRegistry': return `回収: ${name(candidate.cardRef)}をレジストリから手札へ`;
    case 'activateScript': return `Scriptを起動: ${name(candidate.cardRef)}`;
    case 'activateAbility': return 'ユーザー能力を起動する(ターボ・ブースト)';
    case 'attack': {
      const target = candidate.targetUser ? '相手ユーザー' : `相手の${name(candidate.targetRef)}`;
      return `攻撃: ${name(candidate.cardRef)}で${target}を攻撃`;
    }
    case 'executeCard': return `実行: ${name(candidate.cardRef)}を${zoneText(candidate.zone)}へ${candidate.host ? '(Obの下へ重ねる)' : ''}`;
    case 'setScript': return `設置: ${name(candidate.cardRef)}をScriptとしてバックへ`;
    case 'redeploy': return `再配置: ${name(candidate.cardRef)}を${zoneText(candidate.zone)}へ${candidate.host ? '(Obの下へ重ねる)' : ''}`;
    case 'executeSpell': return `Spを実行: ${name(candidate.cardRef)}${candidate.targetRef ? `、対象 ${name(candidate.targetRef)}` : ''}`;
    case 'activateCardEffect': return `カード効果を起動: ${name(candidate.cardRef)}${candidate.targetRef ? `、対象 ${name(candidate.targetRef)}` : ''}`;
    default: return `${candidate.type}: ${name(candidate.cardRef)}`;
  }
}

export function buildPrompt(query, candidates) {
  const o = query.observation;
  const me = o.seats.find((s) => s.seatId === o.viewerSeat); const opp = o.seats.find((s) => s.seatId !== o.viewerSeat);
  const index = nameIndex(o);
  const lines = [];
  lines.push(`ターン${o.turnNumber}(あなたの番)`);
  lines.push(`あなた: フォートレスSTR ${me.fortressStr}/${me.user?.maxFortressStr ?? '?'}、メモリ ${me.memory?.current}/${me.memory?.max}、手札${me.hand?.count}枚、山札${me.deck?.count}枚、レジストリ${me.registry?.count}枚、ゴミ箱${me.trash?.count}枚、使える色 ${(me.enabledSymbols ?? []).join('・') || 'なし'}`);
  lines.push(`相手: フォートレスSTR ${opp.fortressStr}/${opp.user?.maxFortressStr ?? '?'}、メモリ ${opp.memory?.current}/${opp.memory?.max}、手札${opp.hand?.count}枚、山札${opp.deck?.count}枚、レジストリ${opp.registry?.count}枚、ゴミ箱${opp.trash?.count}枚`);
  const zone = (label, seat, key) => { const cards = seat[key]?.cards ?? []; lines.push(`${label}: ${cards.length ? cards.map((c, i) => `(${i + 1})${cardLine(c)}`).join(' / ') : 'なし'}`); };
  zone('あなたの手札', me, 'hand'); zone('あなたのフロント', me, 'front'); zone('あなたのバック', me, 'back'); zone('あなたのレジストリ', me, 'registry');
  zone('相手のフロント', opp, 'front'); zone('相手のバック', opp, 'back');
  const oppRegistry = (opp.registry?.cards ?? []).filter((c) => !c.faceDown); if (oppRegistry.length) lines.push(`相手のレジストリ(表向き): ${oppRegistry.map(cardLine).join(' / ')}`);
  // the texts of the cards on the table that have one, once each
  const texts = new Map();
  for (const seat of [me, opp]) for (const key of ['hand', 'front', 'back', 'registry']) for (const c of seat[key]?.cards ?? []) {
    const d = c.definition; const visible = !c.faceDown || seat === me;
    if (visible && d?.name && d.text && d.text !== '(効果なし)' && !texts.has(d.name)) texts.set(d.name, d.text);
  }
  if (texts.size) { lines.push('', 'カードの効果:'); for (const [n, t] of texts) lines.push(`「${n}」${t}`); }
  const labelled = candidates.map((c, i) => ({ n: i + 1, label: labelOf(c, index), sig: c.sig }));
  lines.push('', '選択肢:'); for (const c of labelled) lines.push(`${c.n}. ${c.label}`);
  lines.push('', FORMAT);
  return { version: PROMPT_VERSION, system: SYSTEM, user: lines.join('\n'), candidates: labelled };
}
