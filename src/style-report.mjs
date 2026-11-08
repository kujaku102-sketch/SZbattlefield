#!/usr/bin/env node
// How the CPUs played, from runs made with `--style` (src/style.mjs).
//
//   node src/style-report.mjs <run dir>... [--by cpu|cpu+opponent] [--json out.json]
// One row for each CPU (the seats it played, over all the runs): the share of its attacks that went at the other user, at cards; trades and kills per match; what it held at the end
// of its turns (hand, registry, cards on the board, memory left); the length of its matches (turns); its win rate.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2); const dirs = []; const opt = {};
for (let i = 0; i < argv.length; i += 1) { if (argv[i].startsWith('--')) { opt[argv[i].slice(2)] = argv[i + 1]; i += 1; } else dirs.push(argv[i]); }
if (dirs.length === 0) { console.error('usage: style-report.mjs <run dir>... [--by cpu|cpu+opponent] [--json out.json]'); process.exit(2); }
// cpus/release/gen2/beatZIG.mjs is named 'beatZIG gen2' (the line and the generation); any other CPU by its file name
const nameOf = (spec) => {
  const m = /(?:^|[\\/])release[\\/](gen\d+)[\\/]([^\\/]+)\.mjs$/.exec(String(spec));
  return m ? `${m[2]} ${m[1]}` : path.basename(String(spec)).replace(/\.mjs$/, '');
};
const rows = new Map();
for (const dir of dirs) {
  const file = path.join(dir, 'raw.jsonl'); if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue; const r = JSON.parse(line);
    if (!r.style || r.status !== 'finished') continue;
    for (const seat of ['seat-a', 'seat-b']) {
      const other = seat === 'seat-a' ? 'seat-b' : 'seat-a';
      const key = opt.by === 'cpu+opponent' ? `${nameOf(r.cpus[seat])} vs ${nameOf(r.cpus[other])}` : nameOf(r.cpus[seat]);
      const g = rows.get(key) ?? { matches: 0, wins: 0, turns: 0, user: 0, card: 0, trades: 0, kills: 0, lost: 0, ends: 0, hand: 0, registry: 0, front: 0, back: 0, memoryLeft: 0 };
      const s = r.style[seat]; g.matches += 1; g.turns += r.turns ?? 0; if (r.outcome?.kind === 'win' && r.outcome.winnerSeat === seat) g.wins += 1;
      g.user += s.attacks.user; g.card += s.attacks.card; g.trades += s.trades; g.kills += s.kills; g.lost += s.lost; g.ends += s.ends;
      for (const k of ['hand', 'registry', 'front', 'back', 'memoryLeft']) g[k] += s[k];
      rows.set(key, g);
    }
  }
}
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const out = []; const json = {};
out.push('| CPU | 試合 | 勝率 | ユーザーへの攻撃の割合 | Ob(カード)への攻撃の割合 | 攻撃/試合 | 相打ち/試合 | 倒した/試合 | 失った/試合 | 手札(ターン終了時) | レジストリ | 場(前) | 場(後) | 残りメモリ | 試合の長さ(ターン) |');
out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const [key, g] of [...rows.entries()].sort()) {
  const att = g.user + g.card; const m = g.matches;
  const v = { matches: m, win: g.wins / m, userShare: att ? g.user / att : null, cardShare: att ? g.card / att : null, attacksPerMatch: att / m, tradesPerMatch: g.trades / m, killsPerMatch: g.kills / m, lostPerMatch: g.lost / m,
    hand: g.hand / g.ends, registry: g.registry / g.ends, front: g.front / g.ends, back: g.back / g.ends, memoryLeft: g.memoryLeft / g.ends, turns: g.turns / m };
  json[key] = v;
  out.push(`| ${key} | ${m} | ${f(100 * v.win, 1)}% | ${f(100 * v.userShare, 1)}% | ${f(100 * v.cardShare, 1)}% | ${f(v.attacksPerMatch)} | ${f(v.tradesPerMatch)} | ${f(v.killsPerMatch)} | ${f(v.lostPerMatch)} | ${f(v.hand)} | ${f(v.registry)} | ${f(v.front)} | ${f(v.back)} | ${f(v.memoryLeft)} | ${f(v.turns, 1)} |`);
}
console.log(out.join('\n'));
if (opt.json) writeFileSync(opt.json, `${JSON.stringify(json, null, 1)}\n`);
