// Aggregates a run's raw.jsonl into tables (summary.md) and numbers (summary.json).
//   node src/report.mjs <run dir>
import { readFileSync, writeFileSync } from 'node:fs';
import { readRaw } from './raw.mjs';
import path from 'node:path';

const dir = path.resolve(process.argv[2]);
const config = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
const rows = readRaw(path.join(dir, 'raw.jsonl')).rows;

const pct = (part, whole) => whole === 0 ? '-' : `${(100 * part / whole).toFixed(1)}%`;
const quantile = (sorted, q) => sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return { n: sorted.length, mean: sorted.length ? sum / sorted.length : null, median: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99), max: sorted.at(-1) ?? null };
};
const f = (value, digits = 2) => value === null || value === undefined ? '-' : Number(value).toFixed(digits);

const finished = rows.filter((row) => row.status === 'finished');
const side = (row) => {
  const winner = row.outcome?.kind === 'win' ? row.outcome.winnerSeat : null;
  const draw = row.outcome?.kind === 'draw';
  return { winner, draw, first: row.firstSeat, second: row.firstSeat === 'seat-a' ? 'seat-b' : row.firstSeat === 'seat-b' ? 'seat-a' : null };
};
const decks = config.decks;

// ---- Per deck, first / second (mirror matches left out: both sides are the same deck)
const perDeck = Object.fromEntries(decks.map((deck) => [deck, { first: { w: 0, l: 0, d: 0 }, second: { w: 0, l: 0, d: 0 } }]));
const firstPlayer = { w: 0, l: 0, d: 0, matches: 0 };
for (const row of finished) {
  const { winner, draw, first, second } = side(row);
  if (first === null) continue;
  firstPlayer.matches += 1;
  if (draw) firstPlayer.d += 1; else if (winner === first) firstPlayer.w += 1; else firstPlayer.l += 1;
  if (row.decks['seat-a'] === row.decks['seat-b']) continue;
  for (const [seat, which] of [[first, 'first'], [second, 'second']]) {
    const bucket = perDeck[row.decks[seat]][which];
    if (draw) bucket.d += 1; else if (winner === seat) bucket.w += 1; else bucket.l += 1;
  }
}

// ---- Deck against deck: win rate of the row deck against the column deck (either seat, either turn order); draws count half
const pair = {};
for (const row of finished) {
  const { winner, draw } = side(row);
  for (const seat of ['seat-a', 'seat-b']) {
    const mine = row.decks[seat]; const theirs = row.decks[seat === 'seat-a' ? 'seat-b' : 'seat-a'];
    if (mine === theirs && seat === 'seat-b') continue; // a mirror match is one match
    const cell = (pair[mine] ??= {})[theirs] ??= { w: 0, l: 0, d: 0, n: 0 };
    cell.n += 1;
    if (draw) cell.d += 1; else if (winner === seat) cell.w += 1; else cell.l += 1;
  }
}

// ---- Turns
const turnStats = stats(finished.map((row) => row.turns).filter(Number.isFinite));
const turnsByDeckPair = Object.fromEntries(decks.flatMap((a) => decks.map((b) => [`${a} / ${b}`,
  stats(finished.filter((row) => row.decks['seat-a'] === a && row.decks['seat-b'] === b).map((row) => row.turns))])));
const commandStats = stats(finished.map((row) => row.commands));

// ---- Status and anomalies
const statusCounts = rows.reduce((counts, row) => ({ ...counts, [row.status]: (counts[row.status] ?? 0) + 1 }), {});
const anomalyCounts = {};
const anomalyMatches = [];
for (const row of rows) {
  if (row.anomalies.length === 0 && row.status === 'finished') continue;
  for (const anomaly of row.anomalies) { const key = `${anomaly.type}${anomaly.code ? `:${anomaly.code}` : ''}`; anomalyCounts[key] = (anomalyCounts[key] ?? 0) + 1; }
  anomalyMatches.push({ job: row.job, status: row.status, cap: row.cap ?? null, firstAnomaly: row.anomalies[0] ?? null, count: row.anomalies.length });
}

// ---- Time per move (ms). A move is one command the CPU chose. choose = what the CPU call took, planning = the part of it
// spent inside the game's queryAction (runtime), own = choose - planning (the CPU's own code). query = one seat's query, submit = the command.
const all = (key) => finished.concat(rows.filter((row) => row.status !== 'finished')).flatMap((row) => row[key]);
const own = rows.flatMap((row) => row.choose.map((value, index) => Math.max(0, value - row.planning[index])));
const timing = { choose: stats(all('choose')), planning: stats(all('planning')), own: stats(own), query: stats(all('queryMs')), submit: stats(all('submitMs')) };
const turnTime = []; // wall per match / commands
const wall = stats(rows.map((row) => row.wallMs));
// Per move, CPU decision + the query that precedes it + the submit that follows: what one CPU move costs a player's wait.
const perMoveTotal = stats(rows.flatMap((row) => row.choose.map((value, index) => value + row.queryMs[index] + row.submitMs[index])));
// By action type is not recorded (the CPU is not asked to name it); by deck of the moving seat is.
const timingByDeck = Object.fromEntries(decks.map((deck) => [deck, stats(rows.flatMap((row) => ['seat-a', 'seat-b']
  .filter((seat) => row.decks[seat] === deck).length === 0 ? [] : row.choose))]));

const summary = { config, matches: rows.length, finished: finished.length, statusCounts, firstPlayer, perDeck, pair, turns: turnStats, commands: commandStats,
  turnsByDeckPair, anomalyCounts, anomalyMatches, timing, perMoveTotal, wall };
writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));

// ---- Markdown
const out = [];
const line = (text = '') => out.push(text);
line(`# CPU bench summary — ${config.cpuA} (seat-a) vs ${config.cpuB} (seat-b)${config.swap ? ' + swapped seats' : ''}`);
line();
const machineText = config.machines?.length > 1
  ? `${config.machines.length} runs on ${[...new Set(config.machines.map((m) => `${m.cpu} (${m.platform})`))].join(' | ')} — the timing section pools different machines and means nothing; use a single-machine run for time`
  : `${config.machine.cpu}, ${config.machine.logicalCores} threads${config.workers ? `, ${config.workers} worker processes` : ''}`;
line(`game ${config.game.commit?.slice(0, 7)} (${config.game.subject}); seeds ${config.seeds[0]}..${config.seeds.at(-1)} (${config.seeds.length}); ${rows.length} matches; ${machineText}, node ${config.node}${config.envId ? `, environment ${config.envId}` : ''}`);
line(`cut-off: ${config.limits.maxCommands} accepted commands or ${config.limits.maxWallMs / 1000} s per match; a match is "stuck" after ${config.limits.idle} moves in a row that were not accepted`);
line();
line(`status: ${Object.entries(statusCounts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
line();
line('## First player');
line(`first player wins ${firstPlayer.w}, loses ${firstPlayer.l}, draws ${firstPlayer.d} of ${firstPlayer.matches} finished matches (win ${pct(firstPlayer.w, firstPlayer.matches)}, lose ${pct(firstPlayer.l, firstPlayer.matches)}, draw ${pct(firstPlayer.d, firstPlayer.matches)})`);
line();
line('## Per deck, as first and as second player (mirror matches left out)');
line('| deck | first: W | L | D | n | win | second: W | L | D | n | win |');
line('|---|---|---|---|---|---|---|---|---|---|---|');
for (const deck of decks) {
  const a = perDeck[deck].first; const b = perDeck[deck].second; const na = a.w + a.l + a.d; const nb = b.w + b.l + b.d;
  line(`| ${deck} | ${a.w} | ${a.l} | ${a.d} | ${na} | ${pct(a.w, na)} | ${b.w} | ${b.l} | ${b.d} | ${nb} | ${pct(b.w, nb)} |`);
}
line();
line('## Deck against deck: win rate of the row deck (either seat; a draw is half a win; n = matches)');
line(`| row \\ column | ${decks.join(' | ')} |`);
line(`|---|${decks.map(() => '---').join('|')}|`);
for (const row of decks) {
  line(`| ${row} | ${decks.map((col) => { const c = pair[row]?.[col]; return c ? `${pct(c.w + c.d / 2, c.n)} (${c.n})` : '-'; }).join(' | ')} |`);
}
line();
line('## Turns of a finished match');
line(`turns: median ${turnStats.median}, mean ${f(turnStats.mean)}, p95 ${turnStats.p95}, max ${turnStats.max}; accepted commands: median ${commandStats.median}, mean ${f(commandStats.mean, 1)}, p95 ${commandStats.p95}, max ${commandStats.max}`);
line();
line('| seat-a deck \\ seat-b deck | ' + decks.join(' | ') + ' |');
line(`|---|${decks.map(() => '---').join('|')}|`);
for (const a of decks) line(`| ${a} | ${decks.map((b) => f(turnsByDeckPair[`${a} / ${b}`].mean, 1)).join(' | ')} |`);
line('(mean turns)');
line();
line('## Anomalies');
line(Object.keys(anomalyCounts).length === 0 && anomalyMatches.length === 0 ? 'none' : `by kind: ${JSON.stringify(anomalyCounts)}`);
for (const match of anomalyMatches.slice(0, 40)) line(`- ${match.job}: ${match.status}${match.cap ? ` (${match.cap})` : ''}, ${match.count} anomalies, first: ${JSON.stringify(match.firstAnomaly)}`);
line();
line('## Time per move (ms; one move = one command the CPU chose)');
line('| part | n | mean | median | p95 | p99 | max |');
line('|---|---|---|---|---|---|---|');
for (const [name, label] of [['choose', 'CPU call (choose) = own + planning'], ['own', 'CPU own code (choose - planning)'], ['planning', 'planning: the game\'s queryAction called by the CPU'],
  ['query', 'the seat\'s query before the move'], ['submit', 'submit of the command']]) {
  const s = timing[name];
  line(`| ${label} | ${s.n} | ${f(s.mean)} | ${f(s.median)} | ${f(s.p95)} | ${f(s.p99)} | ${f(s.max)} |`);
}
line(`| query + choose + submit | ${perMoveTotal.n} | ${f(perMoveTotal.mean)} | ${f(perMoveTotal.median)} | ${f(perMoveTotal.p95)} | ${f(perMoveTotal.p99)} | ${f(perMoveTotal.max)} |`);
line();
line(`wall time of a match (s): median ${f(wall.median / 1000, 1)}, p95 ${f(wall.p95 / 1000, 1)}, max ${f(wall.max / 1000, 1)}`);
writeFileSync(path.join(dir, 'summary.md'), `${out.join('\n')}\n`);
console.log(out.join('\n'));
