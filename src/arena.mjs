// Strength of CPU A against CPU B from a run of `run.mjs --a A --b B --swap` (or without --swap): who wins, by deck, by seat and by turn order.
//   node src/arena.mjs <run or merged dir>        -> arena.md, arena.json in that dir
// "A" is the first CPU of the table (config.cpuA). A match has A on seat-a (first half of a swapped table) or on seat-b (second half).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readRaw } from './raw.mjs';

const dir = path.resolve(process.argv[2]);
const config = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
const rows = readRaw(path.join(dir, 'raw.jsonl')).rows;
const A = config.cpuA; const B = config.cpuB;

const wilson = (wins, n) => { // 95% interval of a proportion
  if (n === 0) return [0, 0];
  const z = 1.96; const p = wins / n; const d = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / d; const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [centre - half, centre + half];
};
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const cell = (c) => c.n === 0 ? '-' : `${pct((c.w + c.d / 2) / c.n)} (${c.w}-${c.l}${c.d ? `-${c.d}` : ''}, n=${c.n})`;
const tally = () => ({ w: 0, l: 0, d: 0, n: 0 });
const add = (c, result) => { c.n += 1; if (result === 'w') c.w += 1; else if (result === 'l') c.l += 1; else c.d += 1; };

const decksA = config.decks;
const overall = tally(); const bySeat = { 'seat-a': tally(), 'seat-b': tally() }; const byOrder = { first: tally(), second: tally() };
const byDeckA = Object.fromEntries(decksA.map((d) => [d, tally()])); const byDeckB = Object.fromEntries(decksA.map((d) => [d, tally()]));
const matrix = Object.fromEntries(decksA.map((d) => [d, Object.fromEntries(decksA.map((e) => [e, tally()]))]));
const deckOrder = Object.fromEntries(decksA.map((d) => [d, { first: tally(), second: tally() }]));
const status = {}; let anomalies = 0; const anomalyKinds = {};
const own = { own: 0, baseline: 0, why: {} };
const turns = []; const excluded = [];
for (const row of rows) {
  status[row.status] = (status[row.status] ?? 0) + 1;
  for (const a of row.anomalies) { anomalies += 1; anomalyKinds[a.type] = (anomalyKinds[a.type] ?? 0) + 1; }
  if (row.status !== 'finished') { excluded.push(row.job); continue; }
  const aSeat = row.cpus['seat-a'] === A ? 'seat-a' : 'seat-b';
  const bSeat = aSeat === 'seat-a' ? 'seat-b' : 'seat-a';
  const result = row.outcome?.kind === 'win' ? (row.outcome.winnerSeat === aSeat ? 'w' : 'l') : 'd';
  const deckOfA = row.decks[aSeat]; const deckOfB = row.decks[bSeat];
  add(overall, result); add(bySeat[aSeat], result); add(byDeckA[deckOfA], result); add(byDeckB[deckOfB], result); add(matrix[deckOfA][deckOfB], result);
  const order = row.firstSeat === aSeat ? 'first' : 'second';
  add(byOrder[order], result); add(deckOrder[deckOfA][order], result);
  turns.push(row.turns);
  const stats = row.cpuStats?.[aSeat];
  if (stats) { own.own += stats.own; own.baseline += stats.baseline; for (const [k, v] of Object.entries(stats.baselineWhy)) own.why[k] = (own.why[k] ?? 0) + v; }
}

const out = [];
const line = (t = '') => out.push(t);
const lo = wilson(overall.w + overall.d / 2, overall.n);
line(`# ${A} against ${B}${config.swap ? ' (seats swapped too)' : ''}`);
line();
line(`game ${config.game?.commit?.slice(0, 7)}; environment ${config.envId ?? '-'}; ${rows.length} matches; seeds ${config.seeds[0]}..${config.seeds.at(-1)}; status ${JSON.stringify(status)}; anomalies ${anomalies}${anomalies ? ` ${JSON.stringify(anomalyKinds)}` : ''}`);
line();
line(`**${A}: ${overall.w} wins, ${overall.l} losses, ${overall.d} draws of ${overall.n} (${pct((overall.w + overall.d / 2) / overall.n)}, 95% ${pct(lo[0])}..${pct(lo[1])})**`);
line();
line('## By the seat A played, and by turn order');
line(`| | result for ${A} |`); line('|---|---|');
line(`| A on seat-a | ${cell(bySeat['seat-a'])} |`); line(`| A on seat-b | ${cell(bySeat['seat-b'])} |`);
line(`| A moved first | ${cell(byOrder.first)} |`); line(`| A moved second | ${cell(byOrder.second)} |`);
line();
line(`## By A's deck (rows) — against every deck of ${B}; and by turn order`);
line(`| A's deck | overall | A first | A second |`); line('|---|---|---|---|');
for (const d of decksA) line(`| ${d} | ${cell(byDeckA[d])} | ${cell(deckOrder[d].first)} | ${cell(deckOrder[d].second)} |`);
line();
line(`## By B's deck`);
line(`| B's deck | result for ${A} |`); line('|---|---|');
for (const d of decksA) line(`| ${d} | ${cell(byDeckB[d])} |`);
line();
line(`## Deck of A (rows) against deck of B (columns): ${A}'s result`);
line(`| | ${decksA.join(' | ')} |`); line(`|---|${decksA.map(() => '---').join('|')}|`);
for (const d of decksA) line(`| ${d} | ${decksA.map((e) => cell(matrix[d][e])).join(' | ')} |`);
line();
const decisions = own.own + own.baseline;
if (decisions > 0) {
  line(`## What ${A} decided itself`);
  line(`${decisions} decisions of ${A}: its own move ${own.own} (${pct(own.own / decisions)}); handed to the current CPU ${own.baseline} (${pct(own.baseline / decisions)}): ${JSON.stringify(own.why)}`);
  line();
}
const sorted = [...turns].sort((a, b) => a - b);
line(`turns of a finished match: median ${sorted[sorted.length >> 1]}, mean ${(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2)}, max ${sorted.at(-1)}`);
if (excluded.length) line(`not counted (not finished): ${excluded.slice(0, 10).join(', ')}${excluded.length > 10 ? ' ...' : ''}`);
writeFileSync(path.join(dir, 'arena.md'), `${out.join('\n')}\n`);
writeFileSync(path.join(dir, 'arena.json'), JSON.stringify({ A, B, overall, bySeat, byOrder, byDeckA, byDeckB, matrix, deckOrder, decisions: own, status, anomalies, anomalyKinds }, null, 2));
console.log(out.join('\n'));
