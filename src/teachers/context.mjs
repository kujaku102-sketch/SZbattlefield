// What a language model is given besides the decision: the rules and the public card pool.
//
//   await buildContext({ gameDir, ownDeck })  ->  { blocks: [{ id, text, cache }], chars, sha256 }
//
// The decision itself (src/teachers/prompt.mjs) says what the seat sees. This is what a reader needs to judge a move in the first place, and it is the same for every decision of a game version:
//   rules     the public rulebook (docs/rules/siege-zeke-rulebook-current.md of the game) and the notes on how the game applies them (src/game/RULES.md). These say what is intended; they are
//             not proof that the game does the same, and the text says so.
//   pool      the text of every public card of the game (the cards a deck can be built from), the ones in the seat's own deck and the ones that are not alike. A deck that is not the seat's
//             is not here and not named: the pool is every card anyone could have put in a deck, not what the other side did.
//   deck      only when `ownDeck` is given: the seat's own decklist (card id -> copies), which the seat knows. Its order is not given.
// The first two blocks are one text for all decisions (so the API can keep it between calls: `cache`), the third is one text for a deck.
// Nothing hidden is read: not the other side's hand, deck or list.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONTEXT_VERSION = 2;      // 2: a block of the notation (what a card text writes and what the rules call it) between the rules and the pool

const lf = (text) => text.replace(/\r\n/g, '\n');
const cardLine = (card) => {
  const stats = card.atk !== undefined && card.atk !== null ? ` ATK${card.atk}/STR${card.str}` : '';
  const classes = (card.classes ?? []).length ? ` クラス:${card.classes.join('/')}` : '';
  return `${card.id} 「${card.name}」〈${card.category}${card.color ? `・${card.color}` : ''}〉コスト${card.cost}${stats}${classes} ${card.text ?? '(効果なし)'}`;
};

// the keywords of the card data (the game's text compiler): name, how a card text writes it, the term to look for in the rulebook
const NOTATION = [['LOGIN', '［ログイン］', 'ログイン'], ['LOGOUT', '［ログアウト］', 'ログアウト'], ['SECURITY', '［セキュリティ］', 'セキュリティ'], ['RESIDENT', '［レジデント］', 'レジデント'], ['QA', '［QA］', 'QA'],
  ['LAYERED', '［レイヤード:…］', 'レイヤード'], ['OVERRIDE', '［オーバーライド］', 'オーバーライド'], ['UPDATE', '［アップデート:N］', 'アップデート'], ['IF', '［if:…］ または ［条件:…］', '[if:'], ['RESPONSE', '［レスポンス］', 'レスポンス'],
  ['HACKING', '［ハッキング］', 'ハッキング'], ['CONTACT', '［コンタクト］', 'コンタクト'], ['MAGAZINE', '［弾倉:X］', '弾倉'], ['ENCRYPTION', '［暗号化］', '暗号化'], ['PROXY', '［プロキシ:N］', 'プロキシ'],
  ['BACKUP', '［バックアップ］', 'バックアップ'], ['DISCONNECT', '［切断］', '切断'], ['PROTECT', '［プロテクト］', 'プロテクト'], ['DECOY', '［デコイ］', 'デコイ'], ['FIREWALL', '［ファイアウォール］', 'ファイアウォール'],
  ['OC', '［OC+N］', 'OC']];

const cache = new Map();

export async function buildContext({ gameDir, ownDeck = null }) {
  const rootKey = path.resolve(gameDir);
  let shared = cache.get(rootKey);
  if (!shared) {
    const readGame = (file) => { const full = path.join(rootKey, file); return existsSync(full) ? lf(readFileSync(full, 'utf8')) : null; };
    const rulebook = readGame('docs/rules/siege-zeke-rulebook-current.md');
    const notes = readGame('src/game/RULES.md');
    if (!rulebook || !notes) throw new Error(`${rootKey}: docs/rules/siege-zeke-rulebook-current.md and src/game/RULES.md are both needed for the context of a language model`);
    const { BUILDABLE_CARDS } = await import(pathToFileURL(path.join(rootKey, 'src/game/deck-builder.js')).href);
    const rules = ['# ルール（公開のルールブック）', rulebook, '', '# ゲームがルールをどう扱うかのメモ（src/game/RULES.md。意図したルールで、実装が同じと保証するものではない）', notes].join('\n');
    const pool = ['# 公開カードプール（デッキを組めるカード全部の本文。あなたのデッキに入っているカードも入っていないカードも、同じ形で並んでいる。相手が何を入れているかはここからは分からない）',
      ...BUILDABLE_CARDS.map(cardLine)].join('\n');
    // What the card texts write and what the rules call it: the facts that the card data and the text compiler give (the card's `keywords` as the game's own compiler finds them), set beside what the rulebook says.
    const { compiledForKeywords } = await import(pathToFileURL(path.join(rootKey, 'src/game/core/prepare.js')).href);
    const inData = new Set(BUILDABLE_CARDS.flatMap((c) => compiledForKeywords(c).keywords.map((k) => k.name)));
    const known = NOTATION.filter(([name]) => inData.has(name));
    // 「切断」: RULES.md uses the word for a player's connection being cut, not for the card keyword: only the rulebook counts for it
    const mentioned = (term) => rulebook.includes(term) || (term !== '切断' && notes.includes(term));
    const notation = ['# 表記の対応（カードの本文の書き方と、ルールの用語。カードのデータから言える事実）',
      'カードの本文の ［…］ の多くは、ゲームのデータではキーワード（keyword）です。データのキーワード名と、本文の書き方と、ルールブック・メモにその語があるか:',
      ...known.map(([name, forms, term]) => `- ${name}：本文では ${forms}。ルールブック・メモに「${term}」${mentioned(term) ? 'の記述がある' : 'の記述はない'}。`),
      '次の対応はデータから言えます。',
      '- 本文の ［条件:X］（例: STD-001・STD-002）は、ルールの ［if:X］ と同じキーワード（データの keyword IF）を表す。ルールブック・メモは ［if:］ とだけ書いていて、［条件:］ は出てこない。',
      '- 本文の ［OC+N］（例: STD-125・STD-128）は、ルールの OC（オーバークロック：実行時にカード指定の追加メモリを払うか選ぶ）のキーワード（データの keyword OC、値は N）を表す。N が追加メモリかどうかを、ルールブックは数字では書いていない。',
      '- 本文の ［相手がObを実行する時］（STD-231）のように、キーワード名のない ［…］ は、データではキーワードではない（keyword なし）。そのカードの誘発の条件を示す括弧として読めるが、ルールブックにはこの書き方の説明がない。',
      mentioned('切断') ? '' : '- ［切断］ は、データでは keyword DISCONNECT で、STD-049・STD-124・STD-176・STD-238 の本文にある。ルールブックにはこのキーワードの定義がない（RULES.md の「切断」は、対局者の接続が切れることで、別のもの）。',
      'ここにない対応は、本文とルールの文面から読めるときだけ根拠にして、読めなければそう書くこと。'].filter(Boolean).join('\n');
    shared = { rules, notation, pool };
    cache.set(rootKey, shared);
  }
  const blocks = [{ id: 'rules', text: shared.rules, cache: false }, { id: 'notation', text: shared.notation, cache: false }, { id: 'pool', text: shared.pool, cache: true }];
  if (ownDeck) {
    const lines = Object.entries(ownDeck).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([id, n]) => `${id} ×${n}`);
    blocks.push({ id: 'deck', text: `# あなたのデッキ（あなたは自分のデッキの中身を知っている。並びは分からない）\n${lines.join('、')}`, cache: true });
  }
  const chars = blocks.reduce((sum, b) => sum + b.text.length, 0);
  const sha256 = createHash('sha256').update(JSON.stringify([CONTEXT_VERSION, blocks.map((b) => b.text)])).digest('hex');
  return { version: CONTEXT_VERSION, blocks, chars, sha256 };
}
