// A fixed set of positions from matches played by the current CPU: each position is the real authority of a match just before one
// command of it. The probes (probe.mjs, diagnose-pool.mjs, candidates.mjs) all use this one set, so their numbers are about the same positions.
//
//   match g (0-based) of the set: decks = the g-th ordered deck pair (cycling), seed = 1 + (g*7) mod 40, played by `simple` against `simple`
//   positions of a match: `perGame` commands spread over the match, picked with a generator seeded by g (so the set does not depend on
//   what the consumer does); the opening decisions are not positions.
//
// `for await (const p of positions({ sim, gameDir, games, perGame, cacheDir })) { ... }`
// p = { game, index, total, fraction, seat, authority, command }. The consumer must be done with p before asking for the next one.
// Played matches are kept in cacheDir (as match records), so a later run replays them instead of playing again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadCpu } from '../cpus/index.mjs';
import { playGame, startDeckIds } from '../src/play.mjs';

const round = (v) => Math.round(v * 1000) / 1000;
const mulberry32 = (seed) => () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = Math.imul(seed ^ (seed >>> 15), seed | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export async function* positions({ sim, gameDir, games = 49, perGame = 12, cacheDir = null }) {
  const { G } = sim;
  const ids = await startDeckIds(gameDir);
  const pairs = ids.flatMap((a) => ids.map((b) => [a, b]));
  const cpu = await (await loadCpu('simple')).create(gameDir);
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });
  for (let g = 0; g < games; g += 1) {
    const [deckA, deckB] = pairs[g % pairs.length];
    const seed = 1 + (g * 7) % 40;
    const id = `probe/${deckA}/${deckB}/${seed}`;
    const cacheFile = cacheDir ? path.join(cacheDir, `${id.replace(/\//g, '__')}.json`) : null;
    let record;
    if (cacheFile && existsSync(cacheFile)) record = JSON.parse(readFileSync(cacheFile, 'utf8'));
    else {
      const job = { id, seed, deckA, deckB, cpus: { 'seat-a': 'simple', 'seat-b': 'simple' } };
      const played = await playGame({ gameDir, job, cpus: { 'seat-a': cpu, 'seat-b': cpu }, limits: { maxCommands: 3000, maxWallMs: 900000, idle: 8, keepRecord: true } });
      if (played.status !== 'finished') { console.log(`${id}: ${played.status}, skipped`); continue; }
      record = played.record;
      if (cacheFile) writeFileSync(cacheFile, JSON.stringify(record));
    }
    const total = record.commands.length;
    const rand = mulberry32((g + 1) * 7919);
    const picks = new Set();
    for (let k = 0; k < perGame; k += 1) {
      const base = Math.floor(total * (k + 0.5) / perGame);
      const jitter = Math.floor((rand() - 0.5) * (total / perGame));
      picks.add(Math.max(0, Math.min(total - 1, base + jitter)));
    }
    let authority = G.authority.createMatchAuthority(structuredClone(record.game)).value;
    for (const [index, recorded] of record.commands.entries()) {
      const action = G.record.decodeRecordedAction(authority, recorded.seat, recorded.action);
      if (!action.ok) throw new Error(`decode ${id} ${index}`);
      const { matchId, seatIds } = authority.metadata;
      const command = G.contract.makeBoundCommand({ contractVersion: 1, matchId, seatId: recorded.seat, seatIds: [...seatIds], sessionGeneration: 1 },
        { commandId: `replay:${index}`, expectedRevision: authority.revision, action: action.value }).value;
      if (picks.has(index) && !['keepOpeningHand', 'openingMulligan'].includes(action.value.type)) {
        yield { game: id, index, total, fraction: round(index / total), seat: recorded.seat, authority, command };
      }
      const next = G.tx.submitRuntimeCommand(authority, { matchId, actorSeat: recorded.seat }, command, {});
      if (!next.ok || next.value.kind !== 'accepted') throw new Error(`replay ${id} ${index}`);
      authority = next.value.authority;
    }
  }
}
