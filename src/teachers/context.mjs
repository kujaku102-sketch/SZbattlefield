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

export const CONTEXT_VERSION = 1;

const lf = (text) => text.replace(/\r\n/g, '\n');
const cardLine = (card) => {
  const stats = card.atk !== undefined && card.atk !== null ? ` ATK${card.atk}/STR${card.str}` : '';
  const classes = (card.classes ?? []).length ? ` クラス:${card.classes.join('/')}` : '';
  return `${card.id} 「${card.name}」〈${card.category}${card.color ? `・${card.color}` : ''}〉コスト${card.cost}${stats}${classes} ${card.text ?? '(効果なし)'}`;
};

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
    shared = { rules, pool };
    cache.set(rootKey, shared);
  }
  const blocks = [{ id: 'rules', text: shared.rules, cache: false }, { id: 'pool', text: shared.pool, cache: true }];
  if (ownDeck) {
    const lines = Object.entries(ownDeck).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([id, n]) => `${id} ×${n}`);
    blocks.push({ id: 'deck', text: `# あなたのデッキ（あなたは自分のデッキの中身を知っている。並びは分からない）\n${lines.join('、')}`, cache: true });
  }
  const chars = blocks.reduce((sum, b) => sum + b.text.length, 0);
  const sha256 = createHash('sha256').update(JSON.stringify([CONTEXT_VERSION, blocks.map((b) => b.text)])).digest('hex');
  return { version: CONTEXT_VERSION, blocks, chars, sha256 };
}
