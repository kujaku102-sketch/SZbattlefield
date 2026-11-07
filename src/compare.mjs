// Compares two result folders match by match: the same match must give the same moves (hash), result, turns and first player.
//   node src/compare.mjs <run or merged dir A> <run or merged dir B>
// Used to show that (a) shards joined by merge.mjs equal one run of the whole table, (b) two machines or platforms agree.
// Exit code 1 when a common match differs. Matches in only one folder are counted, not compared.
import { readFileSync } from 'node:fs';
import { readRaw } from './raw.mjs';
import path from 'node:path';

const [a, b] = process.argv.slice(2).map((dir) => path.resolve(dir));
const read = (dir) => new Map(readRaw(path.join(dir, 'raw.jsonl')).rows.map((row) => [row.job, row]));
const readEnv = (dir) => { try { return JSON.parse(readFileSync(path.join(dir, 'env.json'), 'utf8')); } catch { return null; } };
const ra = read(a); const rb = read(b);
const differences = [];
let common = 0;
for (const [job, x] of ra) {
  const y = rb.get(job);
  if (!y) continue;
  common += 1;
  for (const key of ['hash', 'status', 'turns', 'commands', 'firstSeat']) if (x[key] !== y[key]) differences.push({ job, what: key, a: x[key], b: y[key] });
  if (JSON.stringify(x.outcome) !== JSON.stringify(y.outcome)) differences.push({ job, what: 'outcome', a: x.outcome, b: y.outcome });
}
const onlyA = [...ra.keys()].filter((job) => !rb.has(job)).length;
const onlyB = [...rb.keys()].filter((job) => !ra.has(job)).length;
const ea = readEnv(a); const eb = readEnv(b);
console.log(`A: ${a} (${ea?.info?.platform ?? '?'}, node ${ea?.key?.node ?? '?'}); B: ${b} (${eb?.info?.platform ?? '?'}, node ${eb?.key?.node ?? '?'})`);
console.log(`compared ${common} matches in both; only in A ${onlyA}, only in B ${onlyB}; ${differences.length === 0 ? 'identical' : `${differences.length} differences`}`);
for (const d of differences.slice(0, 40)) console.log(JSON.stringify(d));
process.exit(differences.length === 0 ? 0 : 1);
