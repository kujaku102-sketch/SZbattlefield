// Decks that are not the game's start decks: decks/<name>.json, made from a deck the game's deck builder saved ("書き出し": { id, name, userId, cards: { card id: copies } }) by src/deck-import.mjs.
// A deck is named like a start deck id ("start-red"): --decks start-red,ctl-1; the name is what the job id and the results carry.
//
// decks/<name>.json:
//   { id, name, userId, cards: [[card id, copies], ...], notes: { persona, usage, finish, protect, protectCards }, source: { file, sha256, notesFile } }
//   cards    the order of the saved deck (the game builds the deck in this order and then shuffles it with the match's seed)
//   userId   the user card the deck is played with: a seat starts with its deck's user (initial hand, front/back limits, STR, memory, incidents, ability)
//   notes    what the maker wrote beside the deck, in a markdown file of the same name (黒緑コントロール.md next to 黒緑コントロール.json): NO CPU reads it; it is for people, for the
//            language model's context, and for counting whether the cards that win were played. None of it is needed to play.
// The game's own start decks (src/data/start-decks.js) are not touched.
//
// How a seat starts: the way the game itself starts a match with a saved deck (src/main.js startMatch, src/network/runtime-engine.js): the deck id is the plain 'red' / 'yellow' of the seat,
// the saved deck's list goes in as the recipe and its user as the user (gameOptions playerDeckRecipe / playerUserId, aiDeckRecipe / aiUserId). The rules do not read the deck id.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

export const DECKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../decks');
export const DECK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const deckFile = (name) => path.join(DECKS_DIR, `${name}.json`);

export function readDeck(name) {
  if (!DECK_NAME.test(name)) throw new Error(`deck name ${JSON.stringify(name)}: letters, digits, - and _`);
  const file = deckFile(name);
  if (!existsSync(file)) throw new Error(`deck ${name}: no ${path.relative(process.cwd(), file) || file}`);
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return { deck: JSON.parse(text), hash: createHash('sha256').update(text).digest('hex') };
}

// The part of the game options for one side ("player" is seat-a, "ai" is seat-b): the start deck by id, or a saved deck by its list and its user.
// Only a saved deck adds anything beyond the id, so a table of start decks is exactly what it was.
export function deckOptions(name, side, startIds) {
  if (startIds.includes(name)) return { [`${side}DeckId`]: name };
  const { deck } = readDeck(name);
  return { [`${side}DeckId`]: side === 'player' ? 'red' : 'yellow', [`${side}DeckRecipe`]: deck.cards.map(([id, count]) => [id, count]), [`${side}UserId`]: deck.userId };
}

// saved deck names -> { name: sha256 of its file }, for the environment key (a table made with another list of cards is another table)
export function deckHashes(names, startIds) {
  return Object.fromEntries(names.filter((name) => !startIds.includes(name)).sort().map((name) => [name, readDeck(name).hash]));
}

// The game's own checks of a saved deck (src/game/deck-builder.js: normalizeSavedDeck, validateDeck): the rules are the game's, not written again here.
export async function gameDeckBuilder(gameDir) {
  return import(pathToFileURL(path.join(gameDir, 'src/game/deck-builder.js')).href);
}
export function gameCheck(builder, deck) {
  const saved = { userId: deck.userId, cards: Object.fromEntries(deck.cards) };
  const normalized = builder.normalizeSavedDeck(saved);
  const checked = builder.validateDeck(saved);
  // normalizeSavedDeck drops a card that is not in the library and a count that is not positive: if it changed the list, the saved deck was not what it said
  const dropped = Object.keys(saved.cards).filter((id) => !(id in normalized.cards));
  const errors = [...checked.errors, ...dropped.map((id) => `${id}: 収録にないカード`), ...(normalized.userId !== deck.userId ? [`ユーザー ${deck.userId} は収録にない`] : [])];
  return { valid: errors.length === 0, errors, count: checked.count, rule: checked.rule };
}
