#!/usr/bin/env node
// A deck the game's deck builder saved ("書き出し": { id, name, userId, cards: { card id: copies } }, one deck or a list of them) -> decks/<name>.json (src/decks.mjs).
//
//   node src/deck-import.mjs <saved.json>... --id <name>[,<name>...] [--out decks] [--commit <game sha>] [--check]
//   (--id: the name the bench uses for each deck of the file, in order: letters, digits, - and _ ;  --check: only check, write nothing)
//
// The deck is checked with the game's own functions (src/game/deck-builder.js normalizeSavedDeck and validateDeck, from the game under test): the size the user card names, the same-name limit.
// Not checked by the game (so not here either): the DANGER! limit (one of each) and a card's own limit ("このカードは山札に4枚以上入れられる"). See the report on the game's checker.
//
// Beside the deck, a markdown file of the same name (黒緑コントロール.md next to 黒緑コントロール.json) may say how the deck is played; it is read when it is there and never needed:
//   - 狙いの性格: コントロール          (a line before the first ## heading)
//   ## 使い方                          early and middle game
//   ## フィニッシュプラン              how it wins: the finishing cards and the parts of the combo
//   ## 守るべきカード                  the cards not to lose (a line may start with a card name or id; those are found and listed)
// No CPU reads these. They are for people, for the language model's context, and for counting whether the cards that win were played.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveGameDir } from './game-dir.mjs';
import { DECK_NAME, DECKS_DIR, gameCheck, gameDeckBuilder } from './decks.mjs';

// what is compared when a card is named in the notes: full-width -> half-width, no spaces, no quotation marks, lower case
const norm = (text) => String(text).normalize('NFKC').replace(/[\s　「」『』“”"'‘’`・･]/g, '').toLowerCase();

export function parseNotes(source) {
  const out = { persona: null, sections: {} };
  let section = null;
  for (const raw of source.replace(/\r\n/g, '\n').split('\n')) {
    const h = /^##\s+(.+)$/.exec(raw.trim());
    if (h) { section = h[1].trim(); out.sections[section] = []; continue; }
    if (section === null) { const f = /^[-*]\s*狙いの性格\s*[:：]\s*(.+)$/.exec(raw.trim()); if (f) out.persona = f[1].trim(); continue; }
    out.sections[section].push(raw);
  }
  return out;
}

async function run() {
  const argv = process.argv.slice(2); const files = []; const opt = {};
  for (let i = 0; i < argv.length; i += 1) { if (argv[i] === '--check') opt.check = true; else if (argv[i].startsWith('--')) { opt[argv[i].slice(2)] = argv[i + 1]; i += 1; } else files.push(argv[i]); }
  if (files.length === 0) { console.error('usage: deck-import.mjs <saved.json>... --id <name>[,<name>...] [--out decks] [--commit <game sha>] [--check]'); process.exit(2); }
  const gameDir = resolveGameDir(typeof opt.commit === 'string' ? opt.commit : null, null);
  const builder = await gameDeckBuilder(gameDir);
  const cards = await import(pathToFileURL(path.join(gameDir, 'src/data/cards.js')).href);
  const byName = new Map(Object.values(cards.CARD_LIBRARY).map((card) => [norm(card.name), card.id]));
  const byId = new Map(Object.keys(cards.CARD_LIBRARY).map((id) => [norm(id), id]));
  const found = (text) => byId.get(norm(text)) ?? byName.get(norm(text)) ?? null;
  const ids = typeof opt.id === 'string' ? opt.id.split(',') : [];
  const outDir = path.resolve(opt.out ?? DECKS_DIR);
  let failed = false; let n = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    let saved;
    try { saved = JSON.parse(text); } catch (error) { failed = true; console.error(`NG ${file}\n  JSON が読めない: ${error.message}`); continue; }
    const list = Array.isArray(saved) ? saved : [saved];
    for (const [index, deck] of list.entries()) {
      const label = list.length > 1 ? `${file}#${deck?.name ?? index + 1}` : file;
      const id = ids[n]; n += 1;
      const problems = [];
      if (!id) problems.push('対戦台での名前が要る（--id ctl-1。ファイルに複数のデッキがあれば順にコンマで）');
      else if (!DECK_NAME.test(id)) problems.push(`名前 ${JSON.stringify(id)} は英数字と - _ だけ`);
      else if (/^start-/.test(id)) problems.push('名前は start- で始められない（ゲームのスタートデッキの名前）');
      if (deck === null || typeof deck !== 'object' || typeof deck.cards !== 'object' || deck.cards === null) problems.push('{ id, name, userId, cards: { カードID: 枚数 } } の形ではない');
      const pairs = problems.length === 0 ? Object.entries(deck.cards).map(([cid, count]) => [cid, Number(count)]) : [];
      const checked = problems.length === 0 ? gameCheck(builder, { userId: deck.userId, cards: pairs }) : null;
      if (checked) problems.push(...checked.errors);
      if (problems.length > 0) { failed = true; console.error(`NG ${label}`); for (const p of problems) console.error(`  ${p}`); continue; }
      // the notes beside the file (<same name>.md), if any
      const notesFile = file.replace(/\.json$/i, '.md');
      const notes = existsSync(notesFile) && list.length === 1 ? parseNotes(readFileSync(notesFile, 'utf8')) : { persona: null, sections: {} };
      const section = (name) => (notes.sections[name] ?? []).join('\n').trim();
      const protectCards = [];
      for (const line of (notes.sections['守るべきカード'] ?? []).map((l) => l.trim().replace(/^[-*+]\s+/, '')).filter(Boolean)) {
        for (const part of [line, line.split(/[:：]|\s[—–]\s/)[0], line.split(/[:：（(、,]/)[0], line.split(/\s/)[0]]) { const cid = found(part); if (cid) { if (!protectCards.includes(cid)) protectCards.push(cid); break; } }
      }
      const out = {
        id, name: String(deck.name ?? id), userId: deck.userId, cards: pairs,
        notes: { persona: notes.persona, usage: section('使い方'), finish: section('フィニッシュプラン'), protect: section('守るべきカード'), protectCards },
        source: { file: path.basename(file), sha256: createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex'), notesFile: existsSync(notesFile) && list.length === 1 ? path.basename(notesFile) : null }
      };
      if (!opt.check) { if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true }); writeFileSync(path.join(outDir, `${id}.json`), `${JSON.stringify(out, null, 2)}\n`); }
      console.log(`OK ${label} -> ${opt.check ? '(check only)' : path.join(path.relative(process.cwd(), outDir), `${id}.json`)}  ${out.name} / ${cards.USER_CARDS[deck.userId]?.name ?? deck.userId} / ${checked.count} cards (rule ${checked.rule.size}, same name ${checked.rule.sameName}), ${pairs.length} kinds${out.source.notesFile ? ' / notes: ' + out.source.notesFile : ''}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
