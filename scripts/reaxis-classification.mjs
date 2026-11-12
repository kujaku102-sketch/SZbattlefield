// Re-sets the axis tags of a classification run (scripts/classify-cards.mjs) from the card data, where the axis is a class: the review found cards of one class that the model tagged differently.
//   node scripts/reaxis-classification.mjs --out <folder with classification.json and taxonomy.approved.json> --game <game checkout>
// Writes classification.reviewed.json (the same shape, with `reviewed` in the meta) and classification.reviewed.changes.json (every change and why). classification.json is not touched.
// Rules (nothing else is changed: power, effect kinds, roles, timings stay as the model gave them; the review's proposals for those are in review.json):
//   add     a card whose classes (from the game's data, `derived.classes`) hold a class of the axis gets the axis;
//   remove  a card that has the axis without a class of it AND without a word of the axis in its name or text loses it (only for the axes with a clear word list below).
// An axis that is a theme, not a class (聖樹・Script主体), is left as the model gave it.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const at = process.argv.indexOf('--out');
if (at < 0) { console.error('reaxis-classification: --out <folder>'); process.exit(2); }
const dir = path.resolve(process.argv[at + 1]);
const read = (name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
const classification = read('classification.json');
const taxonomy = read('taxonomy.approved.json').taxonomy;

// the classes that make a card belong to the axis; the words that make a card without that class still belong (it refers to it)
const RULES = {
  axis_noid_allied: { classes: ['連合軍', 'ノイド'], words: ['連合軍', 'ノイド'], removable: true },
  axis_redpunks: { classes: ['レッドパンクス'], words: ['レッドパンクス', 'ジャンク', 'レッパオー', 'Lyd-Ob', 'レイヤー', '合体'], removable: true },
  axis_electron_fairy: { classes: ['ニュートロン・セキュリティ', 'エレクトロン・フェアリー'], words: ['ニュートロン', 'エレクトロン', '情報管理端末'], nameStartsWith: ['/'], removable: true },
  axis_knights_security: { classes: ['ナイツ・オブ・マキナ'], words: ['ナイツ・オブ・マキナ', 'セキュリティ'], removable: true },
  axis_orange_registry: { classes: ['微橙院'], words: ['レジストリ', 'アンブッシュ', '微橙院'], removable: true },
  axis_black_immortal: { classes: ['イモータルス', 'ゴエティア', 'ウィザード', 'サーヴァント'], removable: false },
  axis_insect_script: { classes: ['インセクト', 'インセクト・ゼクター'], removable: false },
  axis_old_gods_madness: { classes: ['旧支配者'], removable: false },
  axis_agent_proxy: { classes: ['エージェント'], removable: false },
  axis_purple_dolls: { classes: ['マスターピース'], removable: false }
};
// the card texts come from the game's data (--game <checkout>), the words are looked for in the name and the real text
const gameAt = process.argv.indexOf('--game');
if (gameAt < 0) { console.error('reaxis-classification: --game <game checkout>'); process.exit(2); }
const { BUILDABLE_CARDS } = await import(pathToFileURL(path.join(path.resolve(process.argv[gameAt + 1]), 'src/game/deck-builder.js')).href);
const textOf = new Map(BUILDABLE_CARDS.map((c) => [c.id, c.text ?? '']));
const known = new Set(taxonomy.axisTags.map((k) => k.id));
const cardsText = JSON.parse(JSON.stringify(classification));
const changes = [];
for (const card of Object.values(cardsText.cards)) {
  const classes = card.derived?.classes ?? [];
  const text = `${card.name ?? ''} ${textOf.get(card.id) ?? ''}`;
  for (const [axis, rule] of Object.entries(RULES)) {
    if (!known.has(axis)) continue;
    const has = card.axisTags.includes(axis);
    const byClass = rule.classes.some((c) => classes.includes(c));
    if (byClass && !has) { card.axisTags.push(axis); changes.push({ id: card.id, name: card.name, axis, change: 'add', why: `class ${classes.filter((c) => rule.classes.includes(c)).join('・')}` }); }
    if (!byClass && has && rule.removable) {
      const byWord = (rule.words ?? []).some((w) => text.includes(w)) || (rule.nameStartsWith ?? []).some((p) => String(card.name).startsWith(p));
      if (!byWord) { card.axisTags = card.axisTags.filter((a) => a !== axis); changes.push({ id: card.id, name: card.name, axis, change: 'remove', why: 'no class of the axis, and no word of it in the name or the text' }); }
    }
  }
}
cardsText.meta = { ...cardsText.meta, reviewed: { from: 'classification.json', by: 'scripts/reaxis-classification.mjs', rule: 'axis tags re-set from the classes of the card data (add) and from the words of the axis (remove); nothing else changed', changes: changes.length, at: new Date().toISOString() } };
writeFileSync(path.join(dir, 'classification.reviewed.json'), `${JSON.stringify(cardsText, null, 1)}\n`);
writeFileSync(path.join(dir, 'classification.reviewed.changes.json'), `${JSON.stringify(changes, null, 1)}\n`);
const byAxis = {}; for (const c of changes) { const k = `${c.axis} ${c.change}`; byAxis[k] = (byAxis[k] ?? 0) + 1; }
console.log(`${changes.length} changes`, byAxis);
