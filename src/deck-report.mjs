#!/usr/bin/env node
// Deck by CPU: the seat's win rate for each (deck, CPU), from the results of runs (raw.jsonl). Nothing is played here.
//
//   node src/deck-report.mjs <run dir>... [--by deck|deck+user] [--min 20] [--out report.md]
// Rows are the decks (with --by deck+user, the deck and the user card it was played with), columns the CPUs; each cell is the win rate of the seat that played that deck with that CPU,
// whoever the other side was (95% range: Wilson; n = the seats). A cell with fewer than --min seats is marked (few).
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2); const dirs = []; const opt = {};
for (let i = 0; i < argv.length; i += 1) { if (argv[i].startsWith('--')) { opt[argv[i].slice(2)] = argv[i + 1]; i += 1; } else dirs.push(argv[i]); }
if (dirs.length === 0) { console.error('usage: deck-report.mjs <run dir>... [--by deck|deck+user] [--min 20] [--out report.md]'); process.exit(2); }
const min = Number(opt.min ?? 20); const by = opt.by ?? 'deck';
const cpuName = (spec) => {
  const m = /(?:^|[\\/])release[\\/](gen\d+)[\\/]([^\\/]+)\.mjs$/.exec(String(spec));
  return m ? `${m[2]} ${m[1]}` : path.basename(String(spec)).replace(/\.mjs$/, '');
};
const cells = new Map(); const rowsSet = new Set(); const colsSet = new Set();
for (const dir of dirs) {
  const file = path.join(dir, 'raw.jsonl'); if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue; const r = JSON.parse(line); if (r.status !== 'finished') continue;
    for (const seat of ['seat-a', 'seat-b']) {
      const deck = by === 'deck+user' ? `${r.decks[seat].split('@')[0]} / ${r.users?.[seat] ?? 'doors_zx'}` : r.decks[seat].split('@')[0];
      const cpu = cpuName(r.cpus[seat]); rowsSet.add(deck); colsSet.add(cpu);
      const key = `${deck}\u0000${cpu}`; const c = cells.get(key) ?? { n: 0, w: 0 };
      c.n += 1; if (r.outcome?.kind === 'win' && r.outcome.winnerSeat === seat) c.w += 1; cells.set(key, c);
    }
  }
}
const wilson = (w, n) => { const z = 1.96; const p = w / n; const d = 1 + z * z / n; const c = (p + z * z / (2 * n)) / d; const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [c - h, c + h]; };
const pct = (x) => `${(100 * x).toFixed(0)}%`;
const cell = (c) => { if (!c) return '-'; const [lo, hi] = wilson(c.w, c.n); return `${pct(c.w / c.n)} (${pct(lo)}..${pct(hi)}) n=${c.n}${c.n < min ? ' (few)' : ''}`; };
const cols = [...colsSet].sort(); const rows = [...rowsSet].sort();
const out = [`# Deck × CPU: the seat's win rate (${by === 'deck+user' ? 'deck / user' : 'deck'} in rows, CPU in columns)`, '',
  `Whoever the other side was. A seat is one side of one match. 95% range: Wilson. (few): fewer than ${min} seats.`, '',
  `| ${by === 'deck+user' ? 'deck / user' : 'deck'} | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`,
  ...rows.map((row) => `| ${row} | ${cols.map((col) => cell(cells.get(`${row}\u0000${col}`))).join(' | ')} |`), ''];
const text = out.join('\n');
if (opt.out) writeFileSync(opt.out, text); else process.stdout.write(text);
