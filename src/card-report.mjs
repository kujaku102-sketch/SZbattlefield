#!/usr/bin/env node
// Card by card: how often a card was executed, how the seat did in the matches where it was executed / where it came to the hand, and how often it was left unused.
// Counted from runs made with `--style` (src/style.mjs, "cards"); nothing is played here.
//
//   node src/card-report.mjs <run dir>... [--by cpu|deck|persona|cpu+deck|user|cpu+user] [--min 20] [--out report.md] [--json out.json]
//
// What is counted (the seat's OWN cards only: its hand, its registry, its executions; the other side's hand and deck are never looked at):
//   came        the copies of the card that were in the seat's hand or registry at some point of the match (opening hand, draws, what it installed)
//   executed    the executions of the card (executeCard, executeSpell, setScript, executeLayered, executeRegistry, mountCard); a card put on the board by another card's effect is not an execution
//   activated   the activations of its effect or script once it is on the board (activateCardEffect, activateScript); not an execution, so a card activated many times can still be "left" if it never was executed
//   left        the copies that came and were NEVER executed before the match ended (installed or held, and unused). The column "left rate" no longer says this alone: a card used through its effect
//               (an activation: a hand [プロキシ], a Script, an Ob's effect) is not unused, so the left rate takes the activations off (see leftUsed below); the execution-only rate stays as its own column
// Columns:
//   matches came / executed   matches (of the seat) in which at least one copy came / was executed
//   win | executed            the seat's win rate in the matches in which the card was executed (95% range: Wilson), n = those matches
//   win | came                the seat's win rate in the matches in which the card came (95% range), n = those matches
//   left rate                 left / came, in copies
// A win rate is the seat's own, whoever the other side was: it is not caused by the card (a card that is executed late in won matches is executed in won matches); read it as "where it shows up".
// Rows with fewer than --min matches that came are marked (few): the range is wide.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2); const dirs = []; const opt = {};
for (let i = 0; i < argv.length; i += 1) { if (argv[i].startsWith('--')) { opt[argv[i].slice(2)] = argv[i + 1]; i += 1; } else dirs.push(argv[i]); }
if (dirs.length === 0) { console.error('usage: card-report.mjs <run dir>... [--by cpu|deck|persona|cpu+deck|user|cpu+user] [--min 20] [--out report.md] [--json out.json]'); process.exit(2); }
const by = opt.by ?? 'cpu'; const min = Number(opt.min ?? 20);
if (!['cpu', 'deck', 'persona', 'cpu+deck', 'user', 'cpu+user'].includes(by)) { console.error('--by: cpu, deck, persona, cpu+deck, user or cpu+user'); process.exit(2); }

// cpus/release/gen2/beatZIG.mjs is 'beatZIG gen2'; any other CPU by its file name
const cpuName = (spec) => {
  const m = /(?:^|[\\/])release[\\/](gen\d+)[\\/]([^\\/]+)\.mjs$/.exec(String(spec));
  return m ? `${m[2]} ${m[1]}` : path.basename(String(spec)).replace(/\.mjs$/, '');
};
const personaOf = (spec) => /[?&]persona=([a-z0-9_-]+)/.exec(String(spec))?.[1] ?? 'none';
const keyOf = (r, seat) => {
  const spec = r.cpus[seat]; const deck = r.decks[seat];
  if (by === 'cpu') return cpuName(spec);
  if (by === 'deck') return deck;
  if (by === 'persona') return `persona ${personaOf(spec)}`;
  const user = r.users?.[seat] ?? 'doors_zx';
  if (by === 'user') return `user ${user}`;
  if (by === 'cpu+user') return `${cpuName(spec)} / ${user}`;
  return `${cpuName(spec)} / ${deck}`;
};

const groups = new Map(); const names = {}; let matches = 0;
for (const dir of dirs) {
  const file = path.join(dir, 'raw.jsonl'); if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue; const r = JSON.parse(line);
    if (r.status !== 'finished' || !r.style?.['seat-a']?.cards) continue;
    Object.assign(names, r.style.names ?? {}); matches += 1;
    for (const seat of ['seat-a', 'seat-b']) {
      const key = keyOf(r, seat);
      const g = groups.get(key) ?? { matches: 0, wins: 0, cards: new Map() };
      const won = r.outcome?.kind === 'win' && r.outcome.winnerSeat === seat;
      g.matches += 1; if (won) g.wins += 1;
      for (const [id, [came, executed, left, activated, placedSelf, placedOther]] of Object.entries(r.style[seat].cards)) {
        const c = g.cards.get(id) ?? { cameMatches: 0, cameWins: 0, execMatches: 0, execWins: 0, came: 0, executed: 0, left: 0, leftUsed: 0, activated: 0, placedSelf: 0, placedOther: 0 };
        c.came += came; c.executed += executed; c.left += left; c.activated += activated ?? 0; c.placedSelf += placedSelf ?? 0; c.placedOther += placedOther ?? 0;
        // left, counting a use by an effect: each activation and each placement by an effect takes one never-executed copy off (per match; at most `left`). Exact when they are of different copies, a lower bound of the use otherwise.
        c.leftUsed += Math.max(0, left - (activated ?? 0) - (placedSelf ?? 0) - (placedOther ?? 0));
        if (came > 0) { c.cameMatches += 1; if (won) c.cameWins += 1; }
        if (executed > 0) { c.execMatches += 1; if (won) c.execWins += 1; }
        g.cards.set(id, c);
      }
      groups.set(key, g);
    }
  }
}

const wilson = (w, n) => { if (n === 0) return null; const z = 1.96; const p = w / n; const d = 1 + z * z / n; const c = (p + z * z / (2 * n)) / d; const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [c - h, c + h]; };
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const rate = (w, n) => { if (n === 0) return '-'; const [lo, hi] = wilson(w, n); return `${pct(w / n)} (${pct(lo)}..${pct(hi)}) n=${n}`; };
const idOrder = (a, b) => a.localeCompare(b, 'en', { numeric: true });

const out = []; const json = {};
out.push(`# カード別の集計（${by} 別）`, '');
out.push(`対戦の記録 ${matches} 試合（席ごとに数える）。数えるのは、その席から見えたものだけ（自分の手札・レジストリ・自分の実行）。相手の手札や山札の中身は使っていない。`, '');
out.push('定義:');
out.push('- 来た = その席の手札かレジストリに、試合のどこかで一度でもあったカード（初手、ドロー、レジストリへの配置を含む）。枚数で数える。');
out.push('- 実行 = executeCard・executeSpell・setScript・executeLayered・executeRegistry・mountCard で実行されたこと。他のカードの効果で場に出たものは実行に入れない。Plugin（P-in）はレジストリにある間だけ効果を出すので、インストールを実行に数える。');
out.push('- 起動回数 = カードの効果・スクリプトを起動した回数（activateCardEffect・activateScript。手札からの [プロキシ] も入る）。実行ではないが、使われたことには数える。ルールで自動に起きること（最初のドローで引いたら自動でドラッグ、など）は手として見えないので、どちらにも入らない。');
out.push('- **使われず残った率 = 手札かレジストリに来たのに、試合が終わるまで実行も起動もされなかった枚数 ÷ 来た枚数。**（試合ごとに、実行されなかった枚数から起動回数を引いて数える）');
out.push('- 自分の効果で場に出た = そのカード自身の効果（またはルール）で場に出た回数（例: Script の起動時に手札からドラッグ。最初のドローで引いて自動でドラッグ。この2つは分けていない）。他のカードの効果で場に出た = 別のカードの効果で場に出た回数。どちらも実行ではないが、使われたことには数える（style.mjs が試合のイベントから数える。この数え方の前の記録には無い）。');
out.push('- 実行だけで数えた残った率 = 来たのに一度も実行されなかった枚数 ÷ 来た枚数（前の版の「使われず残った率」。起動で使うカードが高く出る）。');
out.push('- 来た試合の勝率 / 実行した試合の勝率 = その席が勝った割合（95% の幅は Wilson、n はその試合数）。カードが勝ちを生んだ印ではなく、「そのカードが出てくる試合での勝率」。');
out.push(`- 来た試合が ${min} 未満の行には (少) を付けた。幅が広い。`, '');
for (const [key, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ja'))) {
  out.push(`## ${key}（${g.matches} 席の試合、勝率 ${pct(g.wins / g.matches)}）`, '');
  out.push('| id | 名前 | 来た試合 | 来た枚数 | 実行回数 | 起動回数 | 実行した試合 | 実行した試合の勝率 | 来た試合の勝率 | 使われず残った率 | 実行だけで数えた残った率 | 自分の効果で場に出た | 他のカードの効果で場に出た |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  json[key] = { matches: g.matches, wins: g.wins, cards: {} };
  for (const [id, c] of [...g.cards.entries()].sort((a, b) => idOrder(a[0], b[0]))) {
    out.push(`| ${id} | ${names[id] ?? ''} | ${c.cameMatches}${c.cameMatches < min ? ' (少)' : ''} | ${c.came} | ${c.executed} | ${c.activated} | ${c.execMatches} | ${rate(c.execWins, c.execMatches)} | ${rate(c.cameWins, c.cameMatches)} | ${c.came ? pct(c.leftUsed / c.came) : '-'} | ${c.came ? pct(c.left / c.came) : '-'} | ${c.placedSelf} | ${c.placedOther} |`);
    json[key].cards[id] = { name: names[id] ?? null, ...c, leftRate: c.came ? c.leftUsed / c.came : null, leftRateExecutionOnly: c.came ? c.left / c.came : null };
  }
  out.push('');
}
const text = out.join('\n') + '\n';
if (opt.out) writeFileSync(opt.out, text); else process.stdout.write(text);
if (opt.json) writeFileSync(opt.json, JSON.stringify(json, null, 2) + '\n');
