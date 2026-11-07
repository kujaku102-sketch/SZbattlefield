// CPU bench: plays a fixed table of matches "CPU A against CPU B" and writes one JSON line per match.
//
//   node src/run.mjs --a simple --b simple --seeds 40 --out <dir> [--shard 2/4] [--workers 5]
//
//   --a, --b        CPU specs: a name (cpus/<name>.mjs) or a path, optionally `?key=value&...` (parameters for the CPU). A plays seat-a, B seat-b.
//   --swap          also play every match with the CPUs on the other seats (needed to compare two different CPUs)
//   --seeds N|a,b   seeds 1..N, or a list. The same seed list for every pair of decks.
//   --decks all|ids start deck ids (default: every start deck of the game under test)
//   --shard i/n     play only the i-th of n shards (1-based) of the table: match k of the full table belongs to shard (k mod n)+1,
//                   so shards never overlap and together cover the table. The same shard is the same set of matches on every machine,
//                   and a match gives the same result wherever and whenever it is played (checked: determinism.mjs, compare.mjs).
//   --workers N     worker processes (default: logical cores - 1)
//   --max-commands  a match is cut off (status "capped") after this many accepted commands (default 3000)
//   --max-wall-sec  ... or after this wall time (default 900)
//   --max-loop N    ... or when the same board with the same kind of window comes back N times in one turn, whoever acts (a loop between the two seats; default 30; cap "loop")
//   --max-repeat N  ... or when the same command is accepted N times in a row in the same state (a loop; default 10; cap "repeat")
//   --only <text>   only jobs whose id contains the text (for a re-run of one match)
//   --sample N      only every k-th job so that about N matches are played (a fixed pick, for the determinism check)
//   --reverse       play the jobs in the opposite order
//   --commit <sha>  the game commit to test (GAME_COMMIT does the same). The game is fetched from GAME_SOURCE (default: the public Siege_Zeke_openbeta);
//                   with neither commit nor GAME_DIR, the head of GAME_REF (default main). GAME_DIR=<path> uses a checkout as it is. See game-dir.mjs.
//   --variant <id>  play on a copy of the game with the rule variant variants/<id>.json applied (src/variants.mjs); recorded in env.json
//   --trace         write what each match does to the two users' STR and memory (src/trace.mjs) into every result
//   --out <dir>     where raw.jsonl, config.json and env.json go (default: ./cpu-bench-out/<a>-<b>[/shard-i-of-n])
//
// The deck table is every ordered pair (deck of seat-a, deck of seat-b), same deck against itself included. Who moves first
// is decided by the game's own opening dice from the seed, so "first" and "second" are read from the match (firstSeat).
//
// Resuming: run the same command again. Matches already in <out>/raw.jsonl are skipped. The environment (node version, game commit,
// CPU versions, bench code, limits: env.json) must be the same as the one the first lines were made in; if not, nothing is played.
// Several shards are put together afterwards with merge.mjs.
import { oreHeader } from './ore.mjs';
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveGameDir } from './game-dir.mjs';
import { startDeckIds } from './play.mjs';
import { buildJobs, parseShard, inShard } from './table.mjs';
import { describeEnv, keyDifferences } from './env.mjs';
import { cleanRaw } from './raw.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, index, all) => {
  if (token.startsWith('--')) pairs.push([token.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true]);
  return pairs;
}, []));

const cpuA = args.a ?? 'simple';
const cpuB = args.b ?? 'simple';
const shard = args.shard ? parseShard(args.shard) : null;
const outDir = path.resolve(args.out ?? path.join('cpu-bench-out', `${cpuA.replace(/[^\w.-]+/g, '_')}-${cpuB.replace(/[^\w.-]+/g, '_')}`, ...(shard ? [`shard-${shard.index}-of-${shard.count}`] : [])));
const workers = Number(args.workers ?? Math.max(1, os.cpus().length - 1));
const limits = { maxCommands: Number(args['max-commands'] ?? 3000), maxWallMs: Number(args['max-wall-sec'] ?? 900) * 1000, idle: 8, maxRepeat: Number(args['max-repeat'] ?? 10), maxLoop: Number(args['max-loop'] ?? 30), ...(args['watch-noop'] ? { watchNoop: true } : {}), ...(args.trace ? { trace: true } : {}) };
const seeds = String(args.seeds ?? '10').includes(',') ? String(args.seeds).split(',').map(Number)
  : Array.from({ length: Number(args.seeds ?? 10) }, (_, index) => index + 1);

const gameDir = resolveGameDir(typeof args.commit === 'string' ? args.commit : null, typeof args.variant === 'string' ? args.variant : null);
const allDecks = await startDeckIds(gameDir);
const decks = args.decks && args.decks !== 'all' ? String(args.decks).split(',') : allDecks;
const swap = Boolean(args.swap);
const env = await describeEnv({ gameDir, cpuSpecs: [cpuA, cpuB], limits });

// --record <dir>: the decisions of the CPUs that look ahead are written down (src/ore.mjs)
// The rules the records were made under go into the header: the game's rule and card versions, its commit and variant, and the first-turn draw read from its source
// (so that a record made under another first-turn draw is told apart from this one).
function gameRules(dir) {
  const read = (file) => { try { return readFileSync(path.join(dir, file), 'utf8'); } catch { return ''; } };
  const versions = read('src/game/runtime/versions.js');
  const turn = read('src/game/core/turn.js');
  // the first-turn draw, read from the lines of turn.js that set it: `... === state.firstPlayer) drawCount = N;` for the first player (when the line is gone the first player draws the plain 1),
  // `else if (player.turnsTaken === 0) drawCount = N;` (or `playerId !== state.firstPlayer`) for the second
  const firstLine = /playerId === state\.firstPlayer\) drawCount = (\d)/.exec(turn);
  const secondLine = /playerId !== state\.firstPlayer\) drawCount = (\d)|else if \(player\.turnsTaken === 0\) drawCount = (\d)/.exec(turn);
  const firstTurnDraw = secondLine ? { first: firstLine ? Number(firstLine[1]) : 1, second: Number(secondLine[1] ?? secondLine[2]) } : null;
  return { ruleVersion: /RULE_VERSION = '([^']+)'/.exec(versions)?.[1] ?? null, cardVersion: /CARD_VERSION = '([^']+)'/.exec(versions)?.[1] ?? null, firstTurnDraw };
}
const recordOut = typeof args.record === 'string'
  ? { dir: path.resolve(args.record), header: oreHeader({ game: { commit: env.key.game.commit, variant: env.info.game?.variant ?? null }, rules: gameRules(gameDir), cpus: { a: cpuA, b: cpuB }, envId: env.id }) }
  : null;

// The table. A job id is a stable name: it is also the match id the game sees.
const table = buildJobs({ cpuA, cpuB, swap, decks, seeds });
let wanted = shard ? table.filter((_, position) => inShard(position, shard)) : table;
if (typeof args.only === 'string') wanted = wanted.filter((job) => job.id.includes(args.only));
if (args.sample) { const step = Math.max(1, Math.floor(wanted.length / Number(args.sample))); wanted = wanted.filter((_, index) => index % step === 0).slice(0, Number(args.sample)); }
if (args.reverse) wanted = [...wanted].reverse();

mkdirSync(outDir, { recursive: true });
const rawFile = path.join(outDir, 'raw.jsonl');
const envFile = path.join(outDir, 'env.json');

// Resuming is allowed only in the same environment.
if (existsSync(envFile)) {
  const before = JSON.parse(readFileSync(envFile, 'utf8'));
  const differences = keyDifferences(before.key, env.key);
  if (differences.length > 0) {
    console.error(`${outDir} was made in another environment; not playing into it. Differences:`);
    for (const d of differences) console.error(`  ${d.field}: ${JSON.stringify(d.a)} (there) / ${JSON.stringify(d.b)} (here)`);
    console.error('Use another --out, or run in the environment of the existing results.');
    process.exit(3);
  }
} else if (existsSync(rawFile) && statSync(rawFile).size > 0) {
  console.error(`${rawFile} has results but no env.json (made before environments were recorded); not playing into it.`);
  process.exit(3);
}

// Read what is done. A killed run can leave half a line at the end: it is dropped (the file is rewritten without it) before anything is appended.
const { rows: finishedRows, unreadable } = cleanRaw(rawFile);
const done = new Set(finishedRows.map((row) => row.job));
const queue = wanted.filter((job) => !done.has(job.id));

const previous = existsSync(envFile) ? JSON.parse(readFileSync(path.join(outDir, 'config.json'), 'utf8')) : null;
writeFileSync(envFile, JSON.stringify(env, null, 2));
writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({
  cpuA, cpuB, swap, seeds, decks, limits, shard, workers, game: { ...env.info.game, commit: env.key.game.commit, dirty: env.key.game.dirty }, node: process.version,
  envId: env.id, machine: { ...env.info.machine, platform: env.info.platform },
  jobs: wanted.length, startedAt: previous?.startedAt ?? new Date().toISOString(), resumes: [...(previous?.resumes ?? []), ...(previous ? [new Date().toISOString()] : [])]
}, null, 2));
console.log(`env ${env.id} (node ${env.key.node}, game ${env.key.game.commit?.slice(0, 7)}${env.key.game.dirty ? ' DIRTY' : ''}, ${env.info.platform})`);
console.log(`${shard ? `shard ${shard.index}/${shard.count}: ` : ''}${wanted.length} matches, ${done.size} already done${unreadable ? ` (${unreadable} unreadable line(s) ignored)` : ''}, ${queue.length} to play, ${workers} workers`);

let finishedCount = 0;
const total = queue.length;
const attempts = new Map();
const startedAt = Date.now();
await new Promise((resolve) => {
  if (queue.length === 0) return resolve();
  let running = 0;
  const record = (result) => {
    appendFileSync(rawFile, `${JSON.stringify(result)}\n`);
    finishedCount += 1;
    console.log(`[${finishedCount}/${total}] ${result.job} ${result.status} turns=${result.turns} cmds=${result.commands} ${Math.round(result.wallMs / 1000)}s${result.anomalies.length ? ` anomalies=${result.anomalies.length}` : ''}`);
  };
  const spawn = () => {
    const child = fork(path.join(here, 'worker.mjs'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    running += 1;
    let current = null;
    let leaving = false;
    const next = () => {
      current = queue.shift() ?? null;
      if (!current) { leaving = true; child.send({ type: 'exit' }); return; }
      child.send({ type: 'job', job: current, gameDir, limits, record: recordOut });
    };
    child.on('message', (message) => {
      if (message.type === 'ready') return next();
      if (message.type === 'result') { current = null; record(message.result); next(); }
    });
    child.on('exit', (code) => {
      running -= 1;
      if (current && !leaving) {
        // The worker died with a match in hand (out of memory, a crash in the game): try it once more elsewhere, then record the loss.
        const tries = (attempts.get(current.id) ?? 0) + 1;
        attempts.set(current.id, tries);
        if (tries < 2) queue.unshift(current);
        else record({ job: current.id, seed: current.seed, decks: { 'seat-a': current.deckA, 'seat-b': current.deckB }, cpus: current.cpus, status: 'error', firstSeat: null,
          outcome: null, turns: null, commands: 0, wallMs: 0, hash: null, choose: [], planning: [], queryMs: [], submitMs: [],
          anomalies: [{ type: 'worker_crash', exitCode: code }] });
        if (queue.length > 0) spawn();
      }
      if (running === 0 && queue.length === 0) resolve();
    });
  };
  for (let index = 0; index < Math.min(workers, queue.length); index += 1) spawn();
});
console.log(`done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
