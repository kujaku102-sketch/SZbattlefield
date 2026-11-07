// Determinism check: the same table, played twice in two separate runs (different worker counts, opposite order, new processes),
// must give the same moves, result and turn count for every match. Prints the differences and exits 1 when there are any.
//   node src/determinism.mjs --a simple --b simple --sample 24 --seeds 40 --out cpu-bench-out/determinism
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { readRaw } from './raw.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const at = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : fallback; };
const out = at('out', 'cpu-bench-out/determinism');
const passthrough = ['a', 'b', 'seeds', 'sample', 'decks', 'commit'].flatMap((name) => at(name) === undefined ? [] : [`--${name}`, at(name)]);
const runs = [['first', ['--workers', '3']], ['second', ['--workers', '1', '--reverse']]];
const results = {};
for (const [name, extra] of runs) {
  const dir = path.join(out, name);
  rmSync(dir, { recursive: true, force: true });
  const run = spawnSync(process.execPath, [path.join(here, 'run.mjs'), ...passthrough, ...extra, '--out', dir], { stdio: 'inherit' });
  if (run.status !== 0) { console.error(`run ${name} failed`); process.exit(2); }
  results[name] = new Map(readRaw(path.join(dir, 'raw.jsonl')).rows.map((r) => [r.job, r]));
}
const differences = [];
for (const [job, a] of results.first) {
  const b = results.second.get(job);
  if (!b) { differences.push({ job, what: 'missing in second run' }); continue; }
  for (const key of ['hash', 'status', 'turns', 'commands', 'firstSeat']) if (a[key] !== b[key]) differences.push({ job, what: key, first: a[key], second: b[key] });
  if (JSON.stringify(a.outcome) !== JSON.stringify(b.outcome)) differences.push({ job, what: 'outcome', first: a.outcome, second: b.outcome });
}
console.log(`compared ${results.first.size} matches (run 1: 3 workers, run 2: 1 worker in the opposite order): ${differences.length === 0 ? 'identical' : `${differences.length} differences`}`);
for (const d of differences) console.log(JSON.stringify(d));
process.exit(differences.length === 0 ? 0 : 1);
