// Puts the results of several runs (the shards of one table, or a partial run and its continuation) into one result folder that
// report.mjs reads like any other run.
//
//   node src/merge.mjs --out <merged dir> <run dir> <run dir> ...     (a "run dir" holds raw.jsonl, config.json, env.json)
//
// Refuses (exit 2, nothing written) when the runs are not the same table or not the same environment (node version, game commit,
// CPU versions, bench code, limits: see env.mjs). Otherwise writes <merged dir>/raw.jsonl (each match once, in table order),
// config.json, env.json and merge-report.json / merge-report.md, which say:
//   - missing matches (in the table, in no run), and which shard they belong to
//   - duplicated matches (more than once): identical ones are kept once, conflicting ones (same match, different result) are
//     listed and the first is kept: that means a result depends on the machine or the order, which must not happen
//   - matches that are not in the table, or are in a run of another shard
//   - the platforms and machines the results come from (results of different platforms are joined; compare.mjs checks they agree)
// Exit code 1 when anything is missing, conflicting or unexpected (`--allow-partial` makes missing matches exit 0), 0 otherwise.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildJobs, tableKey, shardOfPosition } from './table.mjs';
import { keyDifferences } from './env.mjs';
import { readRaw } from './raw.mjs';

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
if (outIndex < 0) { console.error('usage: node src/merge.mjs --out <dir> <run dir>...'); process.exit(2); }
const outDir = path.resolve(argv[outIndex + 1]);
const allowPartial = argv.includes('--allow-partial');
const inputs = argv.filter((token, index) => !token.startsWith('--') && index !== outIndex + 1).map((dir) => path.resolve(dir));
if (inputs.length === 0) { console.error('no run dirs'); process.exit(2); }

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const runs = inputs.map((dir) => {
  for (const name of ['config.json', 'env.json', 'raw.jsonl']) if (!existsSync(path.join(dir, name))) { console.error(`${dir}: no ${name}`); process.exit(2); }
  const { rows, unreadable } = readRaw(path.join(dir, 'raw.jsonl'));
  return { dir, config: readJson(path.join(dir, 'config.json')), env: readJson(path.join(dir, 'env.json')), rows, unreadable };
});

// Same table, same environment.
const refuse = [];
for (const run of runs.slice(1)) {
  if (tableKey(run.config) !== tableKey(runs[0].config)) refuse.push({ dir: run.dir, what: 'another table', a: tableKey(runs[0].config), b: tableKey(run.config) });
  for (const d of keyDifferences(runs[0].env.key, run.env.key)) refuse.push({ dir: run.dir, what: `environment: ${d.field}`, a: d.a, b: d.b });
}
if (refuse.length > 0) {
  console.error('not merging: the runs are not from the same table and environment');
  for (const r of refuse) console.error(`  ${r.dir}: ${r.what}: ${JSON.stringify(r.a)} / ${JSON.stringify(r.b)}`);
  process.exit(2);
}

const config = runs[0].config;
const table = buildJobs(config);
const position = new Map(table.map((job, index) => [job.id, index]));

// Every match of every run, once per line.
const seen = new Map();
const duplicates = []; const conflicts = []; const unexpected = []; const wrongShard = [];
for (const run of runs) {
  const shard = run.config.shard;
  for (const row of run.rows) {
    const index = position.get(row.job);
    if (index === undefined) { unexpected.push({ job: row.job, dir: run.dir }); continue; }
    if (shard && shardOfPosition(index, shard.count) !== shard.index) wrongShard.push({ job: row.job, dir: run.dir, shard: `${shard.index}/${shard.count}` });
    const first = seen.get(row.job);
    if (!first) { seen.set(row.job, { row, dir: run.dir }); continue; }
    const same = first.row.hash === row.hash && first.row.status === row.status && first.row.turns === row.turns
      && JSON.stringify(first.row.outcome) === JSON.stringify(row.outcome) && first.row.firstSeat === row.firstSeat;
    (same ? duplicates : conflicts).push({ job: row.job, dirs: [first.dir, run.dir], ...(same ? {} : { first: { hash: first.row.hash, status: first.row.status, outcome: first.row.outcome }, second: { hash: row.hash, status: row.status, outcome: row.outcome } }) });
  }
}

// What is missing, by shard (the shard a match belongs to when the table is split the way the runs were split).
const shardCounts = [...new Set(runs.map((run) => run.config.shard?.count).filter(Boolean))];
const missing = table.filter((job) => !seen.has(job.id)).map((job) => ({ job: job.id, position: position.get(job.id) }));
const shardsGiven = runs.map((run) => run.config.shard ? `${run.config.shard.index}/${run.config.shard.count}` : 'whole table');
const missingByShard = {};
if (shardCounts.length === 1) for (const m of missing) { const key = `${shardOfPosition(m.position, shardCounts[0])}/${shardCounts[0]}`; missingByShard[key] = (missingByShard[key] ?? 0) + 1; }

const merged = table.filter((job) => seen.has(job.id)).map((job) => seen.get(job.id).row);
const platforms = [...new Set(runs.map((run) => run.env.info.platform))];
const machines = runs.map((run) => ({ dir: path.basename(run.dir), platform: run.env.info.platform, ...run.env.info.machine }));
const statusCounts = merged.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }), {});

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'raw.jsonl'), merged.map((row) => JSON.stringify(row)).join('\n') + (merged.length ? '\n' : ''));
writeFileSync(path.join(outDir, 'env.json'), JSON.stringify({ ...runs[0].env, merged: true }, null, 2));
writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({
  ...config, shard: null, workers: null, jobs: table.length, machine: machines[0], machines, platforms,
  merged: { from: inputs, shards: shardsGiven, at: new Date().toISOString() }
}, null, 2));

const report = { table: { matches: table.length, decks: config.decks, seeds: config.seeds.length, swap: config.swap }, envId: runs[0].env.id, shards: shardsGiven,
  matches: merged.length, missing: missing.length, missingByShard, missingExamples: missing.slice(0, 20).map((m) => m.job),
  duplicatesIdentical: duplicates.length, conflicts, unexpected: unexpected.slice(0, 20), unexpectedCount: unexpected.length, wrongShard: wrongShard.slice(0, 20), wrongShardCount: wrongShard.length,
  unreadableLines: runs.reduce((n, run) => n + run.unreadable, 0), platforms, mixedPlatforms: platforms.length > 1, statusCounts };
writeFileSync(path.join(outDir, 'merge-report.json'), JSON.stringify(report, null, 2));

const lines = [];
lines.push(`# merge report`, '');
lines.push(`table: ${table.length} matches (${config.decks.length} decks, ${config.seeds.length} seeds${config.swap ? ', both seatings' : ''}); environment ${runs[0].env.id}; inputs: ${shardsGiven.join(', ')}`);
lines.push(`merged: ${merged.length} matches (${JSON.stringify(statusCounts)})`);
lines.push(`missing: ${missing.length}${Object.keys(missingByShard).length ? ` (by shard: ${JSON.stringify(missingByShard)})` : ''}${missing.length ? `; for example ${report.missingExamples.slice(0, 5).join(', ')}` : ''}`);
lines.push(`duplicated, identical: ${duplicates.length}; duplicated, different result (conflicts): ${conflicts.length}${conflicts.length ? ` ${JSON.stringify(conflicts.slice(0, 5))}` : ''}`);
lines.push(`not in the table: ${unexpected.length}; in a run of another shard: ${wrongShard.length}; unreadable lines: ${report.unreadableLines}`);
lines.push(`platforms: ${platforms.join(' | ')}${platforms.length > 1 ? ' — results of different platforms are joined here; run compare.mjs on a shared sample to show they agree. Timing from different machines must not be pooled.' : ''}`);
writeFileSync(path.join(outDir, 'merge-report.md'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));

const bad = conflicts.length > 0 || unexpected.length > 0 || wrongShard.length > 0 || (!allowPartial && missing.length > 0);
process.exit(bad ? 1 : 0);
