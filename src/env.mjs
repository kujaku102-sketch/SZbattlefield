// The environment a result was made in. Two results are mixed (resumed, merged) only when their `key` is the same.
//   key   : node version, game commit (and whether the checkout was clean), the version of every CPU in the table (hash of its files),
//           the bench code that plays a match (hash), and the limits that can cut a match off.
//   info  : machine, operating system, game subject: recorded, not compared (a match must not depend on them; see merge.mjs, which
//           reports when results of different platforms are joined, and compare.mjs, which checks that two platforms agree).
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cpuVersion, fileHash } from '../cpus/index.mjs';
import { describeGame } from './game-dir.mjs';
import { deckHashes } from './decks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BENCH_FILES = ['play.mjs', 'worker.mjs', 'sim.mjs', 'sim-host.mjs', 'candidates.mjs', 'moves.mjs', '../cpus/index.mjs'];

export const benchHash = () => {
  const hash = createHash('sha256');
  for (const file of BENCH_FILES) hash.update(`${file}:${fileHash(path.join(here, file))};`);
  return hash.digest('hex').slice(0, 16);
};

// deckNames: the decks of the table that are not start decks (decks/<name>.json): the hash of each file is part of the key, so a table made with another list is another table
export async function describeEnv({ gameDir, cpuSpecs, limits, deckNames = [], startIds = [] }) {
  const game = describeGame(gameDir);
  const cpus = {};
  for (const spec of [...new Set(cpuSpecs)]) cpus[spec] = await cpuVersion(spec, gameDir);
  const key = {
    node: process.version,
    game: { commit: game.commit, dirty: game.dirty, ...(game.variant ? { variant: game.variant } : {}) },
    cpus: Object.fromEntries(Object.entries(cpus).map(([spec, version]) => [spec, version.hash])),
    bench: benchHash(),
    ...(deckNames.some((name) => !startIds.includes(name)) ? { decks: deckHashes(deckNames, startIds) } : {}),
    limits: { maxCommands: limits.maxCommands, maxWallMs: limits.maxWallMs, idle: limits.idle, maxRepeat: limits.maxRepeat }
  };
  return {
    key,
    id: createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 12),
    info: {
      game: { subject: game.subject, dir: game.dir },
      cpuFiles: Object.fromEntries(Object.entries(cpus).map(([spec, version]) => [spec, version.files])),
      machine: { cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length, memoryGB: Math.round(os.totalmem() / 2 ** 30 * 10) / 10 },
      platform: `${os.platform()} ${os.arch()} ${os.release()}`,
      // set by GitHub-hosted runners: which image the results were made on
      runner: process.env.ImageOS ? { imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion ?? null } : null
    }
  };
}

// Which fields of two keys differ (empty = same environment).
export function keyDifferences(a, b) {
  const out = [];
  const walk = (x, y, prefix) => {
    if (x !== null && typeof x === 'object' && y !== null && typeof y === 'object') {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${prefix}${prefix ? '.' : ''}${k}`);
    } else if (x !== y) out.push({ field: prefix, a: x, b: y });
  };
  walk(a, b, '');
  return out;
}
