// CPU bench: plays a fixed table of matches "CPU A against CPU B" and writes one JSON line per match.
//
//   node src/run.mjs --a simple --b simple --seeds 40 --out <dir> [--shard 2/4] [--workers 5]
//
//   --a, --b        CPU specs: a name (cpus/<name>.mjs) or a path, optionally `?key=value&...` (parameters for the CPU). A plays seat-a, B seat-b.
//   --swap          also play every match with the CPUs on the other seats (needed to compare two different CPUs)
//   --seed-count N  seeds 1..N.      --seeds a,b,c  exactly those seeds (a single one: --seeds 301,). A bare number in --seeds still means 1..N, with a warning.
//                   The same seed list for every pair of decks.
//   --max-matches N a run of more than N matches (default 500) is not started without --yes; the size of the run is printed first. A run with a language model is also told
//                   its expected cost, and needs --yes when that is more than half of what its set may still spend.
//   --decks all|ids start deck ids, or the names of decks/<name>.json (src/deck-import.mjs); default: every start deck of the game under test
//   --shard i/n     play only the i-th of n shards (1-based) of the table: match k of the full table belongs to shard (k mod n)+1,
//                   so shards never overlap and together cover the table. The same shard is the same set of matches on every machine,
//                   and a match gives the same result wherever and whenever it is played (checked: determinism.mjs, compare.mjs).
//   --workers N     worker processes (default: logical cores - 1)
//   --max-commands  a match is cut off (status "capped") after this many accepted commands (default 3000)
//   --max-wall-sec  ... or after this wall time (default 900)
//   --record-text   with --record: the decisions are also written out as words (text-<tag>.jsonl.gz: the prompt, the numbered candidates, the answers) for reading and auditing
//   --shadow <cpu>  with --record: a teacher CPU (one that looks ahead) looks at every decision of the other CPUs and its answer is recorded, the CPU's own played (DAgger)
//   --llm-config <file>  with --shadow llm: the settings of the language model teacher (model, transport direct|replay|dry, limits on the spend; no key: that is read from the environment)
//   --shadow-compare <cpu>  with --shadow llm: a looking-ahead CPU answers the same decisions too, to be read next to the model's
//   --sim-refs moved|keep  what the states a CPU that looks ahead tries moves on say about the real hidden cards they replaced (src/sim.mjs): moved (default) = nothing of them; keep = as the tables before were made
//   --compare-sim-refs  with --shadow and --record: ask the teacher each decision again on the other kind of re-drawn state (--sim-refs), and write both answers into the result (refsCompare); nothing else changes
//   --plain-match-id  name each match by its decks, its seed and which side plays simple, not by the CPUs' file names (for compare-shipped: the same CPU from two files plays the same matches)
//   --sim-prior real|seen  where a CPU that looks ahead (needsSim: lookahead, deep, beatZIG's reader) draws the other side's hidden cards from (src/sim.mjs): real (default) = the other side's
//                   decklist minus what the seat has seen; seen = only what the seat could know (the library, the colours it has seen, the rules of deck building). Part of the environment.
//   --max-loop N    ... or when the same board with the same kind of window comes back N times in one turn, whoever acts (a loop between the two seats; default 30; cap "loop")
//   --max-repeat N  ... or when the same command is accepted N times in a row in the same state (a loop; default 10; cap "repeat")
//   --only <text>   only jobs whose id contains the text (for a re-run of one match)
//   --jobs-file <f> only the jobs whose ids are listed in the file, one a line (a pick, e.g. loop/select.mjs of forgehammer)
//   --sample N      only every k-th job so that about N matches are played (a fixed pick, for the determinism check)
//   --reverse       play the jobs in the opposite order
//   --commit <sha>  the game commit to test (GAME_COMMIT does the same). The game is fetched from GAME_SOURCE (default: the public Siege_Zeke_openbeta);
//                   with neither commit nor GAME_DIR, the head of GAME_REF (default main). GAME_DIR=<path> uses a checkout as it is. See game-dir.mjs.
//   --variant <id>  play on a copy of the game with the rule variant variants/<id>.json applied (src/variants.mjs); recorded in env.json
//   --style         count how each seat played (attacks on the user / on cards, trades, hand, registry and board at the end of its turns, memory left): result.style, read by src/style-report.mjs
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveGameDir } from './game-dir.mjs';
import { startDeckIds } from './play.mjs';
import { buildJobs, parseShard, inShard } from './table.mjs';
import { describeEnv, keyDifferences } from './env.mjs';
import { estimateLlmRun } from './teachers/estimate.mjs';
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
const limits = { maxCommands: Number(args['max-commands'] ?? 3000), maxWallMs: Number(args['max-wall-sec'] ?? 900) * 1000, idle: 8, maxRepeat: Number(args['max-repeat'] ?? 10), maxLoop: Number(args['max-loop'] ?? 30), ...(typeof args.shadow === 'string' ? { shadow: args.shadow } : {}), ...(typeof args['llm-config'] === 'string' ? { llmConfig: path.resolve(args['llm-config']) } : {}), ...(typeof args['shadow-compare'] === 'string' ? { compare: args['shadow-compare'] } : {}), ...(args['watch-noop'] ? { watchNoop: true } : {}), ...(args.trace ? { trace: true } : {}), ...(args.style ? { style: true } : {}), ...(args['sim-prior'] === 'seen' ? { simPrior: 'seen' } : {}), ...(args['plain-match-id'] ? { plainMatchId: true } : {}), ...(args['sim-refs'] === 'keep' ? { simRefs: 'keep' } : {}), ...(args['compare-sim-refs'] ? { refsCompare: true } : {}) };
if (args['sim-prior'] !== undefined && !['real', 'seen'].includes(args['sim-prior'])) { console.error('--sim-prior real|seen'); process.exit(2); }
process.env.SZB_SIM_PRIOR = args['sim-prior'] === 'seen' ? 'seen' : 'real';
// The old copy of a state (keep) is for reading the tables made before and for the comparison of --compare-sim-refs, by a person at a terminal: it is not offered to the workflows or the notebook,
// which do not set the variable. A table of the bench is of moved.
if ((args['sim-refs'] === 'keep' || args['compare-sim-refs']) && process.env.SZB_ALLOW_SIM_REFS_KEEP !== '1') { console.error('--sim-refs keep and --compare-sim-refs are for a person at a terminal: set SZB_ALLOW_SIM_REFS_KEEP=1'); process.exit(2); }
process.env.SZB_SIM_REFS = args['sim-refs'] === 'keep' ? 'keep' : 'moved';       // the workers read it (src/sim.mjs)
// Seeds. --seed-count N = seeds 1..N; --seeds a,b,c = exactly those (a single one: --seeds 301,). A bare number in --seeds still means 1..N (as before) but says so:
// it has been mistaken for "the seed N" three times, each time for a run of hundreds of matches too many.
const upTo = (n) => Array.from({ length: n }, (_, index) => index + 1);
let seeds;
if (args['seed-count'] !== undefined) seeds = upTo(Number(args['seed-count']));
else if (args.seeds === undefined) seeds = upTo(10);
else if (String(args.seeds).includes(',')) seeds = String(args.seeds).split(',').map((x) => x.trim()).filter((x) => x !== '').map(Number);
else {
  seeds = upTo(Number(args.seeds));
  console.error(`WARNING: --seeds ${args.seeds} means the ${seeds.length} seeds 1..${args.seeds}. For the single seed ${args.seeds} write --seeds ${args.seeds},   for ${args.seeds} seeds from 1 write --seed-count ${args.seeds}.`);
}
if (seeds.length === 0 || seeds.some((x) => !Number.isInteger(x) || x < 0)) { console.error(`seeds? ${JSON.stringify(seeds).slice(0, 80)}`); process.exit(2); }

const gameDir = resolveGameDir(typeof args.commit === 'string' ? args.commit : null, typeof args.variant === 'string' ? args.variant : null);
const allDecks = await startDeckIds(gameDir);
const requestedDecks = args.decks && args.decks !== 'all' ? String(args.decks).split(',') : allDecks;
const swap = Boolean(args.swap);
// Decks that are not the game's start decks come from decks/<name>.json (src/decks.mjs, made by src/deck-import.mjs from a deck the game's deck builder saved). They are checked with the game's
// own checker (deck-builder.js validateDeck) before anything is played: a deck that breaks its rule stops the run.
// A deck is named `<deck>` or `<deck>@<user>` (src/decks.mjs): each seat starts with the user card of its deck (the saved deck's own, or doors_zx for a start deck, or the one named after the @).
// `@<user>` is the key of the game's USER_CARDS (doors_zx, suckintosh, phoenix, humanoid, by_os, doors_nt, savage_salvage, extreme, bigboss). A spec is written without the @ when the user is the one it has anyway.
let decks = requestedDecks; let users = Object.fromEntries(requestedDecks.map((spec) => [spec, 'doors_zx']));
if (requestedDecks.some((spec) => !allDecks.includes(spec))) {
  const { parseSpec, userOf, canonicalSpec, readDeck, gameDeckBuilder, gameCheck } = await import('./decks.mjs');
  const builder = await gameDeckBuilder(gameDir);
  const { USER_CARDS } = await import(pathToFileURL(path.join(gameDir, 'src/data/cards.js')).href);
  const { START_DECKS } = await import(pathToFileURL(path.join(gameDir, 'src/data/start-decks.js')).href);
  const bad = []; const warn = []; const specs = [];
  for (const requested of requestedDecks) {
    const { name, user } = parseSpec(requested);
    let deck = null;
    if (!allDecks.includes(name)) {
      try { deck = readDeck(name).deck; } catch (error) { bad.push(`${requested}: ${error.message} (the start decks: ${allDecks.join(', ')})`); continue; }
    }
    if (user !== null && !Object.hasOwn(USER_CARDS, user)) { bad.push(`${requested}: user ${user}? one of ${Object.keys(USER_CARDS).join(', ')}`); continue; }
    const effective = userOf(requested, allDecks);
    // a saved deck has to keep its user's rule (the game's own checker); a start deck played with another user is allowed, with a warning when it is not a deck that user may build
    const cards = deck ? Object.fromEntries(deck.cards) : START_DECKS.find((d) => d.id === name).cards;
    const checked = gameCheck(builder, { userId: effective, cards: Object.entries(cards) });
    for (const error of checked.errors) (deck ? bad : warn).push(`${requested}: ${error}`);
    specs.push(canonicalSpec(requested, allDecks));
  }
  if (bad.length > 0) { console.error(['decks that cannot be played:', ...bad.map((line) => `  ${line}`)].join('\n')); process.exit(2); }
  if (warn.length > 0) console.error(['WARNING: start decks that are not legal for the user they are played with (played anyway):', ...warn.map((line) => `  ${line}`)].join('\n'));
  decks = [...new Set(specs)];
  users = Object.fromEntries(decks.map((spec) => [spec, userOf(spec, allDecks)]));
}
const env = await describeEnv({ gameDir, cpuSpecs: [cpuA, cpuB], limits, deckNames: decks, startIds: allDecks });

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
  ? { dir: path.resolve(args.record), text: Boolean(args['record-text']), header: oreHeader({ game: { commit: env.key.game.commit, variant: env.info.game?.variant ?? null }, rules: gameRules(gameDir), cpus: { a: cpuA, b: cpuB }, shadow: typeof args.shadow === 'string' ? args.shadow : null, ...(Object.values(users).some((u) => u !== 'doors_zx') ? { users: { default: 'doors_zx', byDeck: users } } : {}), envId: env.id }) }
  : null;

// The table. A job id is a stable name: it is also the match id the game sees.
const table = buildJobs({ cpuA, cpuB, swap, decks, seeds });
let wanted = shard ? table.filter((_, position) => inShard(position, shard)) : table;
if (typeof args.only === 'string') wanted = wanted.filter((job) => job.id.includes(args.only));
if (typeof args['jobs-file'] === 'string') {
  // exactly these matches (one job id a line; the ones that are not in this table are not played here: a pick can span two tables)
  const ids = new Set(readFileSync(path.resolve(args['jobs-file']), 'utf8').split('\n').map((x) => x.trim()).filter(Boolean));
  wanted = wanted.filter((job) => ids.has(job.id));
  console.log(`--jobs-file: ${wanted.length} of its ${ids.size} matches are in this table`);
}
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

// The size of the run is told before anything starts, and a large one needs --yes (or a higher --max-matches).
const maxMatches = Number(args['max-matches'] ?? 500);
console.log(`this run: ${queue.length} matches to play (seeds ${seeds.length > 6 ? `${seeds[0]}..${seeds.at(-1)}, ${seeds.length} of them` : seeds.join(',')}; ${decks.length} decks${swap ? ', both orders' : ''}), limit ${maxMatches} without --yes`);
if (queue.length > maxMatches && !args.yes) {
  console.error(`${queue.length} matches is more than --max-matches ${maxMatches}: not started. If that is meant, add --yes (or --max-matches ${queue.length}).`);
  process.exit(4);
}
if (typeof args['llm-config'] === 'string' && args.shadow === 'llm') {
  const config = JSON.parse(readFileSync(path.resolve(args['llm-config']), 'utf8'));
  if (config.transport !== 'dry' && config.transport !== 'replay') {
    const e = estimateLlmRun(config, queue.length);
    console.log(`LLM: about ${e.calls} calls to each of ${e.models.length} model(s) (${e.models.map((m) => m.model).join(', ')}); expected about $${e.expectedUsd.toFixed(2)}, at most about $${e.maxUsd.toFixed(2)}; the set may spend $${e.limitUsd} (spent $${e.spentUsd.toFixed(2)})`);
    if (e.expectedUsd > 0.5 * e.remainingUsd && !args.yes) {
      console.error(`the expected cost is more than half of what the set may still spend ($${e.remainingUsd.toFixed(2)}): not started. If that is meant, add --yes.`);
      process.exit(4);
    }
  }
}

const previous = existsSync(envFile) ? JSON.parse(readFileSync(path.join(outDir, 'config.json'), 'utf8')) : null;
writeFileSync(envFile, JSON.stringify(env, null, 2));
writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({
  cpuA, cpuB, swap, seeds, decks, ...(Object.values(users).some((u) => u !== 'doors_zx') ? { users } : {}), limits, shard, workers, game: { ...env.info.game, commit: env.key.game.commit, dirty: env.key.game.dirty }, node: process.version,
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
      child.send({ type: 'job', job: current, gameDir, limits, record: recordOut, workers });
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
