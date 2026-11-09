// Two runs of the same table, one with a released CPU file and one with the same CPU as the game ships it (cpus/game-cpu.mjs), must have played the same matches.
//   node src/compare-shipped.mjs <run dir of the released file> <run dir of the shipped CPU>
// A match is named by its decks, its seed and which side the CPU was on (the job names differ: they carry the CPU's name). Equal means the same hash of the whole match
// (every command and the final state), so the moves, the outcome and the length are the same.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readRaw } from './raw.mjs';

const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error('usage: node src/compare-shipped.mjs <released run> <shipped run>'); process.exit(2); }
const key = (row) => `${row.decks['seat-a']}|${row.decks['seat-b']}|${row.seed}|${row.cpus['seat-a'] === 'simple' ? 'cpu-on-b' : 'cpu-on-a'}`;
const load = (dir) => new Map(readRaw(path.join(dir, 'raw.jsonl')).rows.map((row) => [key(row), row]));
const left = load(a); const right = load(b);
let same = 0; const different = []; const missing = [];
for (const [k, row] of left) {
  const other = right.get(k);
  if (!other) { missing.push(k); continue; }
  if (row.hash === other.hash && JSON.stringify(row.outcome) === JSON.stringify(other.outcome)) same += 1; else different.push({ match: k, a: { turns: row.turns, commands: row.commands, outcome: row.outcome?.kind }, b: { turns: other.turns, commands: other.commands, outcome: other.outcome?.kind } });
}
const onlyRight = [...right.keys()].filter((k) => !left.has(k));
console.log(`compared ${left.size} matches: ${same} identical, ${different.length} different, ${missing.length} only in the first, ${onlyRight.length} only in the second`);
for (const d of different.slice(0, 10)) console.log(' different', JSON.stringify(d));
process.exit(different.length || missing.length || onlyRight.length ? 1 : 0);
