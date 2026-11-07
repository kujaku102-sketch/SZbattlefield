// Summarizes probe/probe.mjs output (positions.jsonl) into summary.md / summary.json.
//   node probe/summarize.mjs <probe run dir>
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2]);
const config = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
const rows = readFileSync(path.join(dir, 'positions.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const used = rows.filter((row) => !row.skipped);
const skipped = rows.filter((row) => row.skipped);

const quantile = (sorted, q) => sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const stats = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { n: sorted.length, mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    median: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99), max: sorted.at(-1) ?? null };
};
const f = (v, d = 2) => v === null || v === undefined ? '-' : Number(v).toFixed(d);
const sum = (a, b) => a.map((value, index) => value + b[index]);

const series = {
  'copy of the real state (engine\'s own copy, with log/events)': (r) => r.ms.cloneFull,
  'apply one command to it': (r) => r.ms.applyFull,
  'copy + apply (real state, full copy)': (r) => sum(r.ms.cloneFull, r.ms.applyFull),
  'lean copy (no log/events/history)': (r) => r.ms.cloneLean,
  'apply one command to the lean copy': (r) => r.ms.applyLean,
  'lean copy + apply': (r) => sum(r.ms.cloneLean, r.ms.applyLean),
  'copy that shares the compiled effects': (r) => r.ms.cloneShare,
  'apply one command to the shared copy': (r) => r.ms.applyShare,
  'shared copy + apply': (r) => sum(r.ms.cloneShare, r.ms.applyShare),
  'determinized state: build, total (shared copy + derive + fill)': (r) => [r.ms.determinize.total],
  '  of which copy': (r) => [r.ms.determinize.clone],
  '  of which derive the card pool and hidden slots': (r) => [r.ms.determinize.derive],
  '  of which fill the hidden slots + re-seed': (r) => [r.ms.determinize.fill],
  'try one move on a determinized state: copy of it': (r) => r.ms.cloneDet,
  'try one move on a determinized state: apply': (r) => r.ms.applyDet,
  'try one move on a determinized state: copy + apply': (r) => sum(r.ms.cloneDet, r.ms.applyDet),
  'for reference: prepare the command (runtime path, once per candidate)': (r) => [r.ms.prepare],
  'for reference: the seat\'s query (runtime)': (r) => [r.ms.query]
};

const table = (rowsIn, title) => {
  const lines = [`| ${title} | n | mean | median | p95 | p99 | max |`, '|---|---|---|---|---|---|---|'];
  for (const [name, pick] of Object.entries(series)) {
    const s = stats(rowsIn.flatMap(pick));
    lines.push(`| ${name} | ${s.n} | ${f(s.mean)} | ${f(s.median)} | ${f(s.p95)} | ${f(s.p99)} | ${f(s.max)} |`);
  }
  return lines;
};

const phase = (r) => r.fraction < 1 / 3 ? 'early' : r.fraction < 2 / 3 ? 'mid' : 'late';
const handBucket = (r) => r.size.hand <= 3 ? 'hand 0-3' : r.size.hand <= 6 ? 'hand 4-6' : 'hand 7+';
const tryTotal = (r) => sum(r.ms.cloneDet, r.ms.applyDet);

const group = (key) => {
  const map = new Map();
  for (const r of used) { const k = key(r); (map.get(k) ?? map.set(k, []).get(k)).push(r); }
  return map;
};
const breakdown = (title, key, order) => {
  const lines = [`| ${title} | positions | copy+apply on a determinized state: median | p95 | max | determinize median | lean copy median | apply median | log entries (median) |`, '|---|---|---|---|---|---|---|---|---|'];
  const g = group(key);
  for (const k of order ?? [...g.keys()].sort()) {
    const rs = g.get(k); if (!rs) continue;
    const t = stats(rs.flatMap(tryTotal)); const d = stats(rs.map((r) => r.ms.determinize.total));
    const c = stats(rs.flatMap((r) => r.ms.cloneLean)); const a = stats(rs.flatMap((r) => r.ms.applyDet)); const l = stats(rs.map((r) => r.size.log));
    lines.push(`| ${k} | ${rs.length} | ${f(t.median)} | ${f(t.p95)} | ${f(t.max)} | ${f(d.median)} | ${f(c.median)} | ${f(a.median)} | ${f(l.median, 0)} |`);
  }
  return lines;
};

const kinds = (name) => used.reduce((acc, r) => ({ ...acc, [r.kinds[name]]: (acc[r.kinds[name]] ?? 0) + 1 }), {});
const partTotals = {};
for (const r of used) for (const [key, ms] of r.cloneParts) { (partTotals[key] ??= []).push(ms); }
const parts = Object.entries(partTotals).map(([key, list]) => [key, stats(list)]).sort((a, b) => b[1].mean - a[1].mean);

const pool = used.map((r) => r.checks.pool);
const summary = {
  config, positions: rows.length, used: used.length, skipped: skipped.length,
  skippedReasons: skipped.reduce((acc, r) => ({ ...acc, [r.skipped]: (acc[r.skipped] ?? 0) + 1 }), {}),
  series: Object.fromEntries(Object.entries(series).map(([name, pick]) => [name, stats(used.flatMap(pick))])),
  kinds: { full: kinds('full'), lean: kinds('lean'), det: kinds('det') },
  checks: {
    leanSameAsFull: used.filter((r) => r.checks.leanSameAsFull).length,
    shareSameAsFull: used.filter((r) => r.checks.shareSameAsFull).length,
    poolMatchesRealHidden: pool.filter((p) => p.poolMatches).length, leakedRealHiddenCards: pool.reduce((n, p) => n + p.leaked, 0),
    hiddenSlots: stats(pool.map((p) => p.slotCount)), poolMismatches: pool.filter((p) => !p.poolMatches).slice(0, 5)
  },
  legal: stats(used.map((r) => r.legal)),
  cloneParts: parts
};
writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));

const out = [];
const line = (t = '') => out.push(t);
line('# Stage 1 probe: the time of trying one move outside the runtime (ms)');
line();
line(`game ${config.game.commit?.slice(0, 7)} (${config.game.subject}); ${config.machine.cpu}, ${config.machine.logicalCores} threads, node ${config.node}`);
line(`${rows.length} positions taken from ${new Set(rows.map((r) => r.game)).size} matches played by the current CPU (${config.positionsPerGame} per match, spread over the match); ${used.length} measured, ${skipped.length} skipped (${JSON.stringify(summary.skippedReasons)}); ${config.reps} repetitions each, every repetition is one sample`);
line();
line('## Per step');
out.push(...table(used, 'step'));
line();
line('## Per phase of the match, by hand size, by what the move is');
out.push(...breakdown('phase', phase, ['early', 'mid', 'late']));
line();
out.push(...breakdown('own hand', handBucket, ['hand 0-3', 'hand 4-6', 'hand 7+']));
line();
out.push(...breakdown('move', (r) => r.action));
line();
out.push(...breakdown('choice open', (r) => r.size.pending ? 'a choice is open' : 'no choice open', ['no choice open', 'a choice is open']));
line();
line('## Where the copy\'s time goes (each top-level key of the state copied alone, ms, mean over positions)');
line('| key | n | mean | median | p95 | max |');
line('|---|---|---|---|---|---|');
for (const [key, s] of parts.slice(0, 8)) line(`| ${key} | ${s.n} | ${f(s.mean)} | ${f(s.median)} | ${f(s.p95)} | ${f(s.max)} |`);
line();
line('## Checks');
line(`- the lean copy gave the same state as the engine's own copy after the same move (log, events and history excluded): ${summary.checks.leanSameAsFull}/${used.length}`);
 line(`- the shared copy (compiled effects shared) gave the same state as the engine's own copy after the same move: ${summary.checks.shareSameAsFull}/${used.length}`);
line(`- the card pool the determinization drew from (decklist minus the cards the seat sees) equals the real hidden cards of that owner: ${summary.checks.poolMatchesRealHidden}/${used.length}; real hidden card objects that survived into the determinized state: ${summary.checks.leakedRealHiddenCards}`);
line(`- hidden slots re-drawn per position: median ${summary.checks.hiddenSlots.median}, max ${summary.checks.hiddenSlots.max}`);
line(`- result of the move on the real copy / lean copy / determinized copy: ${JSON.stringify(summary.kinds)}`);
line(`- legal actions the seat has at those positions (query.legalActions): median ${summary.legal.median}, p95 ${summary.legal.p95}, max ${summary.legal.max}`);
writeFileSync(path.join(dir, 'summary.md'), `${out.join('\n')}\n`);
console.log(out.join('\n'));
