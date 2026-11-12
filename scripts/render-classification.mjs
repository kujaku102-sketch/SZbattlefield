// Writes the readable pages of a classification run (scripts/classify-cards.mjs): the cards by role, by axis, the places where the text reads two ways, the review.
//   node scripts/render-classification.mjs --out <folder with taxonomy.approved.json, classification.json, ambiguities.json, review.json>
// Writes into the same folder: 分類-役割ごと.md, 分類-軸ごと.md, 読みが分かれる.md, 見直し.md, 分類-全カード.md. Nothing is asked of a model here.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const at = process.argv.indexOf('--out');
if (at < 0) { console.error('render-classification: --out <folder>'); process.exit(2); }
const dir = path.resolve(process.argv[at + 1]);
const read = (name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
const taxonomy = read('taxonomy.approved.json').taxonomy;
const classification = read('classification.json');
const cards = Object.values(classification.cards).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
const meta = classification.meta ?? {};
const nameOf = (list, id) => list.find((k) => k.id === id)?.name ?? id;
const NL = '\n';
const cell = (text) => String(text ?? '').replace(/\|/g, '／').replace(/\n/g, ' ');
const head = (title) => [`# ${title}`, '',
  `モデル ${meta.model}（effort ${meta.effort}）／分類スクリプト版 ${meta.classifyVersion}／PROMPT_VERSION ${meta.promptVersion}／ルールとプールの hash ${String(meta.contextSha256 ?? '').slice(0, 16)}…／ゲーム ${String(meta.gameCommit ?? '').slice(0, 7)}／${meta.at ?? ''}`,
  '初期評価です。power＝単体の強さ 1〜5、適性＝beatdown / midrange / control / tactic の合い方 1〜5（目盛りは taxonomy.approved.json の ratingScale）。', ''];
const line = (c) => `| ${c.id} | ${cell(c.name)} | ${c.derived?.cardType ?? ''} | ${c.derived?.color ?? ''} | ${c.derived?.memoryCost ?? ''} | ${c.power} | ${c.personaFit.beatdown}/${c.personaFit.midrange}/${c.personaFit.control}/${c.personaFit.tactic} | ${c.confidence} | ${cell(c.effectKinds.map((k) => nameOf(taxonomy.effectKinds, k)).join('・'))} | ${cell(c.timings.map((k) => nameOf(taxonomy.timings, k)).join('・'))} | ${c.ambiguity.ambiguous ? `読み分かれ（${c.ambiguity.severity}）` : ''} |`;
const tableHead = ['| id | 名前 | 種別 | 色 | メモリ | power | 適性(攻/中/制/戦) | 確からしさ | 効果の種類 | 使う時 | 読み |', '|---|---|---|---|---|---|---|---|---|---|---|'];

// by role (the main role first; the other roles named)
{
  const out = head('カードの LLM 分類：役割ごと');
  out.push('主な役割（先頭）でグループにした。副の役割は名前の後ろ。', '');
  for (const role of taxonomy.roles) {
    const mine = cards.filter((c) => c.roles[0] === role.id);
    out.push(`## ${role.name}（${role.id}）：${mine.length}枚`, '', role.definition, '', ...tableHead);
    for (const c of mine.sort((a, b) => b.power - a.power)) out.push(line({ ...c, name: `${c.name}${c.roles.length > 1 ? `（副：${c.roles.slice(1).map((r) => nameOf(taxonomy.roles, r)).join('・')}）` : ''}` }));
    out.push('');
  }
  writeFileSync(path.join(dir, '分類-役割ごと.md'), out.join(NL));
}
// by axis
{
  const out = head('カードの LLM 分類：軸ごと');
  out.push('軸のタグは、クラス・名前・テーマのまとまり。1枚が複数の軸に入ることがある。軸のないカードは最後。', '');
  for (const axis of taxonomy.axisTags) {
    const mine = cards.filter((c) => c.axisTags.includes(axis.id));
    out.push(`## ${axis.name}（${axis.id}）：${mine.length}枚`, '', axis.definition, '', ...tableHead);
    for (const c of mine.sort((a, b) => b.power - a.power)) out.push(line(c));
    out.push('');
  }
  const none = cards.filter((c) => c.axisTags.length === 0);
  out.push(`## 軸なし：${none.length}枚`, '', ...tableHead, ...none.map(line), '');
  writeFileSync(path.join(dir, '分類-軸ごと.md'), out.join(NL));
}
// all cards with the reason
{
  const out = head('カードの LLM 分類：全カード（理由つき）');
  for (const c of cards) {
    out.push(`## ${c.id} ${c.name}`, '', `- 種別 ${c.derived?.cardType}／色 ${c.derived?.color ?? '無色'}／メモリ ${c.derived?.memoryCost}／キーワード ${(c.derived?.keywords ?? []).map((k) => k.name + (k.value !== null && k.value !== undefined ? `:${k.value}` : '')).join('・') || 'なし'}／クラス ${(c.derived?.classes ?? []).join('・') || 'なし'}（ここまでデータから）`,
      `- 効果の種類：${c.effectKinds.map((k) => nameOf(taxonomy.effectKinds, k)).join('・') || 'なし'}／役割：${c.roles.map((k) => nameOf(taxonomy.roles, k)).join('・')}／軸：${c.axisTags.map((k) => nameOf(taxonomy.axisTags, k)).join('・') || 'なし'}／使う時：${c.timings.map((k) => nameOf(taxonomy.timings, k)).join('・')}`,
      `- 条件とコスト：${c.conditionAndCost}`, `- power ${c.power}／適性 beatdown ${c.personaFit.beatdown}・midrange ${c.personaFit.midrange}・control ${c.personaFit.control}・tactic ${c.personaFit.tactic}／確からしさ ${c.confidence}`, `- 理由：${c.reason}`, '');
  }
  writeFileSync(path.join(dir, '分類-全カード.md'), out.join(NL));
}
// the places that read two ways
{
  const list = cards.filter((c) => c.ambiguity.ambiguous);
  const rank = { 高: 0, 中: 1, 低: 2 };
  const out = ['# 読みが分かれるところ（カードの裁定になるもの。人が決める）', '',
    `${list.length}件（高 ${list.filter((c) => c.ambiguity.severity === '高').length}・中 ${list.filter((c) => c.ambiguity.severity === '中').length}・低 ${list.filter((c) => c.ambiguity.severity === '低').length}）。付けるのは、試合で起きることが変わる・どの文面でも決まらない・普通の試合で起こる、の3つがそろうときだけ（モデルの判断）。`,
    'エンジンが今どちらの読みで動いているかは、別に確かめて書き足す（「実装の読み」）。', ''];
  for (const c of list.sort((a, b) => rank[a.ambiguity.severity] - rank[b.ambiguity.severity] || a.id.localeCompare(b.id, 'en', { numeric: true }))) {
    const a = c.ambiguity;
    out.push(`## ${c.id} ${c.name}（${a.severity}）`, '', `- どう読めるか：${a.readings}`, `- 何が変わるか：${a.whatChanges}`, `- なぜ決まらないか：${a.whyUndecided}`, `- 起きる場面：${a.whenItComesUp}`, '');
  }
  writeFileSync(path.join(dir, '読みが分かれる.md'), out.join(NL));
}
// the review
if (existsSync(path.join(dir, 'review.json'))) {
  const { review, firstRound } = read('review.json');
  const out = ['# 見直し（同じ種類のカードの間の食い違い。直す案だけで、上書きはしていない）', '', `2回目の指摘 ${review.inconsistencies.length}件（1回目 ${firstRound?.inconsistencies?.length ?? '?'}件。2回目は1回目を確かめて残す・外す・足す）。`, '', '## 全体の様子', '', review.summary, ''];
  review.inconsistencies.forEach((x, i) => {
    out.push(`## ${i + 1}. ${x.cardIds.join('・')}`, '', x.problem, '');
    for (const p of x.proposals) out.push(`- ${p.cardId}：${p.field} を「${p.from}」→「${p.to}」（${p.why}）`);
    out.push('');
  });
  out.push('## 分け方（一覧）への指摘', '', ...review.taxonomyNotes.map((n) => `- ${n}`), '');
  writeFileSync(path.join(dir, '見直し.md'), out.join(NL));
}
console.log(`rendered ${cards.length} cards into ${dir}`);
