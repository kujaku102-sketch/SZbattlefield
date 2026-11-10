// Freeze a learned CPU as a release: cpus/release/gen<N>/<line>.mjs (the weights and the call), <line>/ (the frozen code it imports) and <line>.json (the record).
//
//   node scripts/freeze-release.mjs --gen 3 --line beatZIG --weights w.json --game <game dir> --topk k=2,reader=one,samples=2 [--evaluation e.json] [--timing t.json] [--records r.json] [--same-as lightZIG]
//   node scripts/freeze-release.mjs --gen 3 --line lightZIG --weights w.json --game <game dir>                       (no --topk: no reader, no sim)
//   node scripts/freeze-release.mjs --verify cpus/release/gen3/beatZIG.json                                           (read it back: every hash is what the record says)
//
// What it does, in the order the gen2 files were made by hand:
//   1. the module: forgehammer's smith (packages/forge/src/smith.mjs, --forgehammer <dir> or $FORGEHAMMER_DIR) writes it from the weights; the imports are pointed at the folder <line>/ and the id is <line>-gen<N>.
//   2. the frozen code: cpus/learned/{candidates,features,loopguard,mlp,policy}.mjs, and with --topk also cpus/topk-core.mjs and cpus/lookahead/{eval,playout}.mjs, copied into <line>/ with a "FROZEN COPY"
//      line on top and the imports made relative to that folder. The sources must be committed (the record says "commit <sha>"); --allow-dirty overrides, and the record then says so.
//   3. the record: sha256 of every file read with line endings as LF (all = sha256 of the hashes in the order listed), the weights, the rules the data was played under (read from the game dir), what it
//      was learned from (the weights file's own header), and the evaluation / timing / records files when they are given. Nothing is measured here: what is not given is not in the record.
// The release is written to a new place only: an existing <line>.mjs / <line>.json / <line>/ is not overwritten without --force.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => { const at = args.indexOf(`--${name}`); return at < 0 || args[at + 1] === undefined || args[at + 1].startsWith('--') ? null : args[at + 1]; };
const die = (message) => { console.error(`freeze-release: ${message}`); process.exit(2); };

const lf = (text) => text.replace(/\r\n/g, '\n');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const hashFile = (file) => sha(lf(readFileSync(file, 'utf8')));
const allOf = (files) => sha(Object.values(files).join(''));
const readJson = (file) => JSON.parse(readFileSync(path.resolve(file), 'utf8'));

// ---- --verify: read a release back
if (option('verify')) {
  const recordFile = path.resolve(option('verify'));
  const record = JSON.parse(readFileSync(recordFile, 'utf8'));
  const dir = path.dirname(recordFile);
  const folder = path.join(dir, record.line);
  const problems = [];
  const names = readdirSync(folder).filter((name) => name.endsWith('.mjs')).sort();
  const listed = Object.keys(record.frozenCode?.files ?? {});
  if (names.join() !== [...listed].sort().join()) problems.push(`${record.line}/: files ${names.join(',')} but the record lists ${listed.join(',')}`);
  for (const [name, hash] of Object.entries(record.frozenCode?.files ?? {})) if (!existsSync(path.join(folder, name)) || hashFile(path.join(folder, name)) !== hash) problems.push(`${record.line}/${name}: not what the record says`);
  if (allOf(record.frozenCode?.files ?? {}) !== record.frozenCode?.all) problems.push('frozenCode.all: not the hash of the listed hashes');
  const moduleFile = path.join(dir, `${record.line}.mjs`);
  if (!existsSync(moduleFile) || hashFile(moduleFile) !== record.module?.sha256) problems.push(`${record.line}.mjs: not what the record says`);
  // the module may import only its own folder
  for (const file of [moduleFile, ...names.map((name) => path.join(folder, name))]) {
    for (const match of readFileSync(file, 'utf8').matchAll(/from '(\.[^']*)'/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (!target.startsWith(folder + path.sep) && target !== folder) problems.push(`${path.basename(file)}: imports ${match[1]}, outside ${record.line}/`);
      else if (!existsSync(target)) problems.push(`${path.basename(file)}: imports ${match[1]}, which is not there`);
    }
  }
  if (problems.length > 0) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`${record.name}: ${names.length} frozen files + module, all as the record says`);
  process.exit(0);
}

// ---- freeze
const gen = option('gen'); const line = option('line'); const weightsFile = option('weights'); const gameDir = option('game');
if (!gen || !/^[0-9]+$/.test(gen)) die('--gen <number>');
if (!line || !/^[A-Za-z][A-Za-z0-9]*$/.test(line)) die('--line <name>, letters and digits (beatZIG, lightZIG, controlZIG)');
if (!weightsFile) die('--weights <weights.json> (the output of forge hammer)');
if (!gameDir) die('--game <the game checkout the data was played under>: its rule and card versions go into the record');
const forgehammer = option('forgehammer') ?? process.env.FORGEHAMMER_DIR ?? path.resolve(root, '..', 'forgehammer');
const smithFile = path.join(forgehammer, 'packages/forge/src/smith.mjs');
if (!existsSync(smithFile)) die(`${smithFile}: not found (--forgehammer <dir>)`);
const topkSpec = option('topk');
const topk = topkSpec ? Object.fromEntries(topkSpec.split(',').map((item) => { const [key, value] = item.split('='); return [key, Number.isFinite(Number(value)) ? Number(value) : value]; })) : null;
if (topkSpec && !(Number.isInteger(topk.k) && topk.reader)) die('--topk k=<n>,reader=one|deep,samples=<n>');

const outRoot = path.resolve(option('out') ?? path.join(root, 'cpus/release'));
const outDir = path.join(outRoot, `gen${gen}`);
const moduleOut = path.join(outDir, `${line}.mjs`); const jsonOut = path.join(outDir, `${line}.json`); const folderOut = path.join(outDir, line);
for (const target of [moduleOut, jsonOut, folderOut]) if (existsSync(target) && !flag('force')) die(`${path.relative(root, target)} exists (--force to overwrite)`);

// the commit the frozen code is taken at
const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' }).trim();
const sources = [['candidates.mjs', 'cpus/learned/candidates.mjs'], ['features.mjs', 'cpus/learned/features.mjs'], ['loopguard.mjs', 'cpus/learned/loopguard.mjs'], ['mlp.mjs', 'cpus/learned/mlp.mjs'], ['policy.mjs', 'cpus/learned/policy.mjs']];
if (topk) sources.push(['eval.mjs', 'cpus/lookahead/eval.mjs'], ['playout.mjs', 'cpus/lookahead/playout.mjs'], ['topk-core.mjs', 'cpus/topk-core.mjs']);
const dirty = git('status', '--porcelain', '--', ...sources.map(([, from]) => from));
if (dirty && !flag('allow-dirty')) die(`not committed, so "commit <sha>" would be a lie:\n${dirty}\n(commit them, or --allow-dirty)`);
const commit = git('rev-parse', '--short=7', 'HEAD');
const takenAt = dirty ? `commit ${commit} plus uncommitted changes of ${sources.length} listed files (--allow-dirty)` : `commit ${commit}`;

// the rules, read from the game dir as src/run.mjs reads them for a record's header
const readGame = (file) => { try { return readFileSync(path.join(gameDir, file), 'utf8'); } catch { return ''; } };
const versions = readGame('src/game/runtime/versions.js'); const turn = readGame('src/game/core/turn.js');
const ruleVersion = /RULE_VERSION = '([^']+)'/.exec(versions)?.[1] ?? null; const cardVersion = /CARD_VERSION = '([^']+)'/.exec(versions)?.[1] ?? null;
const firstLine = /playerId === state\.firstPlayer\) drawCount = (\d)/.exec(turn);
const secondLine = /playerId !== state\.firstPlayer\) drawCount = (\d)|else if \(player\.turnsTaken === 0\) drawCount = (\d)/.exec(turn);
const firstTurnDraw = secondLine ? { first: firstLine ? Number(firstLine[1]) : 1, second: Number(secondLine[1] ?? secondLine[2]) } : null;
if (!ruleVersion || !cardVersion) die(`${gameDir}: no rule / card version found in src/game/runtime/versions.js`);
let gameHead = null;
try { gameHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gameDir, encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }

const weights = readJson(weightsFile);
const dataGame = weights.meta?.dataset?.game ?? null;
if (dataGame && gameHead && dataGame !== gameHead) console.error(`freeze-release: WARNING: the data was played under game ${dataGame}, the --game dir is at ${gameHead}; the record says the data's commit`);

// 1. the module
const { forgeModule } = await import(pathToFileURL(smithFile).href);
const id = `${line}-gen${gen}`;
let moduleText = forgeModule(weights, { name: id, topk });
const swap = (from, to) => { const parts = moduleText.split(from); if (parts.length !== 2) die(`the smith's module has ${parts.length - 1} of ${from}, not 1`); moduleText = parts.join(to); };
swap(`from './learned/policy.mjs'`, `from './${line}/policy.mjs'`);
if (topk) swap(`from './topk-core.mjs'`, `from './${line}/topk-core.mjs'`);
swap(`id: 'forged:${id}'`, `id: '${id}'`);
const digest = /^\/\/ weights ([0-9a-f]+);/m.exec(moduleText)?.[1] ?? null;
const what = option('what') ?? (topk ? `a small network scores the moves; a reader ("${topk.reader}", k=${topk.k}) looks at the best ${topk.k} by score on re-drawn states and picks the better` : 'a small network scores the moves; no reader (fast and light)');
const learnedBy = `Learned for the game rules of ${(gameHead ?? dataGame ?? 'unknown').slice(0, 7)} (rule version ${ruleVersion}, cards ${cardVersion}): learn it again when the rules change.`;
moduleText = `// ${line} gen${gen}: ${what}. A finished release, kept in the repository on purpose; see ${line}.json for what it was learned from and how it was measured.\n// ${learnedBy}\n${moduleText}`;

// 2. the frozen code
const rewrites = { 'topk-core.mjs': [["'./learned/candidates.mjs'", "'./candidates.mjs'"], ["'./lookahead/eval.mjs'", "'./eval.mjs'"], ["'./lookahead/playout.mjs'", "'./playout.mjs'"]] };
const frozen = {};
for (const [name, from] of sources) {
  let text = lf(readFileSync(path.join(root, from), 'utf8'));
  for (const [before, after] of rewrites[name] ?? []) { const parts = text.split(before); if (parts.length !== 2) die(`${from}: has ${parts.length - 1} of ${before}, not 1`); text = parts.join(after); }
  frozen[name] = `// FROZEN COPY for ${line} gen${gen} (cpus/release/gen${gen}/${line}.mjs): ${from} at ${takenAt}. Do not edit and do not follow changes elsewhere: ${line} gen${gen} must play the same for ever.\n${text}`;
}
for (const [name, text] of Object.entries(frozen)) for (const match of text.matchAll(/from '(\.[^']*)'/g)) if (!frozen[path.basename(match[1])] || match[1] !== `./${path.basename(match[1])}`) die(`${name}: imports ${match[1]}, which is not one of the frozen files`);

// 3. the record
const fileHashes = Object.fromEntries(Object.keys(frozen).sort().map((name) => [name, sha(frozen[name])]));
const features = await import(pathToFileURL(path.join(root, 'cpus/learned/features.mjs')).href);
const optional = (name) => (option(name) ? readJson(option(name)) : undefined);
const record = {
  name: `${line} gen${gen}`, id, line, generation: Number(gen), file: `cpus/release/gen${gen}/${line}.mjs`,
  what,
  module: { sha256: sha(lf(moduleText)) },
  frozenCode: {
    note: 'The CPU module imports only the copies in its own folder; cpus/learned/ and the others may change without changing how it plays. sha256 of each file with line endings read as LF; all = sha256 of the hashes in the order listed.',
    files: fileHashes, all: allOf(fileHashes), takenAt
  },
  weights: {
    digest, featureVersion: weights.featureVersion,
    candidateFeatures: features.CAND_NAMES?.length ?? null, stateFeatures: features.STATE_NAMES?.length ?? null,
    network: { method: weights.meta?.method ?? null, hidden: weights.meta?.hidden ?? null },
    ...(option('same-as') ? { sameAs: option('same-as') } : {})
  },
  ...(topk ? { reader: { kind: topk.reader, k: topk.k, samples: topk.samples ?? null } } : {}),
  learnedFor: {
    note: 'The rules the data was played under. When the game\'s rules change (the first-turn draw, a card, a rule version), the data and this CPU are of the old rules: learn it again.',
    game: dataGame ?? gameHead, ruleVersion, cardVersion, firstTurnDraw
  },
  learnedFrom: {
    decisionsLearnedFrom: weights.meta?.dataset?.decisions ?? null, matches: weights.meta?.dataset?.matches ?? null, teacher: weights.meta?.dataset?.teacher ?? null,
    validation: weights.meta?.validation ?? null,
    method: Object.fromEntries(['method', 'hidden', 'why', 'advantage', 'beta', 'epochs', 'lr', 'l2', 'seed'].map((key) => [key, weights.meta?.[key] ?? null])),
    ...(optional('records') ? { records: optional('records') } : {})
  },
  ...(optional('evaluation') ? { evaluation: optional('evaluation') } : {}),
  ...(optional('timing') ? { timePerDecision: optional('timing') } : {}),
  playsOnly: topk
    ? 'what the seat can see (its own query) and the states the reader re-draws of what it cannot see; no hidden information of the other side.'
    : 'what the seat can see (its own query); no sim, no hidden information of the other side.',
  frozenAt: new Date().toISOString()
};

mkdirSync(folderOut, { recursive: true });
if (flag('force')) for (const stale of readdirSync(folderOut)) rmSync(path.join(folderOut, stale), { force: true });
for (const [name, text] of Object.entries(frozen)) writeFileSync(path.join(folderOut, name), text);
writeFileSync(moduleOut, moduleText);
writeFileSync(jsonOut, `${JSON.stringify(record, null, 2)}\n`);
console.log(`${record.name}: ${path.relative(root, moduleOut)} + ${Object.keys(frozen).length} frozen files + ${path.relative(root, jsonOut)} (weights ${digest}, ${takenAt})`);
console.log(`next: node scripts/freeze-release.mjs --verify ${path.relative(root, jsonOut)}; play it against the original (src/compare.mjs) before it is called finished`);
