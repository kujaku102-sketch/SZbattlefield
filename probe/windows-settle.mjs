// Does the sim answer the windows a move opens (reads=full, src/sim-windows.mjs), and does it do it without touching anything else?
// For each position of the fixed set (probe/positions.mjs) and each move of the seat on the first determinized state (as a CPU sees them):
//   - the state `after(move)` hands out has no window left open, or one that the sim has no engine call for (an allocation, the security rest window): counted by kind;
//   - asking again gives the same state (a decision depends only on the state and the parameters: a match replays exactly);
//   - the determinized state the move was tried on is the same after the tries (the sim works on copies);
//   - the same move on the basic reads is the state the full reads started from (what the engine leaves open is the same).
// It is a probe of the trusted side: the states are determinized ones, nothing is read from the real hidden cards.
//
//   node probe/windows-settle.mjs --games 49 --out <dir> [--commit <sha>] [--cache <dir>]
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolveGameDir, describeGame } from '../src/game-dir.mjs';
import { loadSimHost } from '../src/sim-host.mjs';
import { positions } from './positions.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, index, all) => {
  if (token.startsWith('--')) pairs.push([token.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true]);
  return pairs;
}, []));
const outDir = path.resolve(args.out ?? 'cpu-bench-out/windows-settle');
const gameDir = resolveGameDir(typeof args.commit === 'string' ? args.commit : null);
const host = await loadSimHost(gameDir);

const card = (c) => [c.uid, c.id, c.faceDown === true, c.sleep === true, c.atk, c.str, c.damage ?? 0, c.tempAtk ?? 0, c.tempStr ?? 0, c.permanentAtk ?? 0, c.permanentStr ?? 0, (c.mounted ?? []).map(card)];
const signature = (state) => JSON.stringify({
  players: ['player', 'ai'].map((who) => { const p = state.players[who]; return { memory: p.memory, fortress: p.fortressStr, zones: ['deck', 'hand', 'front', 'back', 'registry', 'trash', 'ban'].map((z) => p[z].map(card)) }; }),
  active: state.active, turn: state.turnNumber, winner: state.winner ?? null,
  pending: state.pending ? [state.pending.type, state.pending.request?.label ?? null] : null, prompt: state.prompt ? state.prompt.type : null
});
const waiting = (state) => state.pending ? `pending:${state.pending.type}${state.pending.request?.spec?.kind === 'allocation' ? ':allocation' : ''}` : state.prompt ? `prompt:${state.prompt.type}` : state.securityRestWindow ? 'security-rest' : null;

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({ game: describeGame(gameDir), node: process.version }, null, 2));
const tally = { positions: 0, moves: 0, refused: 0, settled: 0, openedBasic: 0, stillOpen: {}, notRepeatable: 0, touched: 0, differentStart: 0 };
const bad = [];
for await (const position of positions({ sim: host.sim, gameDir, games: Number(args.games ?? 49), perGame: Number(args.positions ?? 12), cacheDir: typeof args.cache === 'string' ? args.cache : null })) {
  const { authority, seat } = position;
  const full = host.open({ authority, seat, reads: { mode: 'full' } });
  const basic = host.open({ authority, seat, reads: 'basic' });
  tally.positions += 1;
  const start = signature(full.now(0));
  for (const move of full.moves) {
    if (move.type === 'endTurn') continue;
    tally.moves += 1;
    const first = full.after(move.id, 0);
    if (first === null) { tally.refused += 1; continue; }
    const left = waiting(first);
    if (left === null) tally.settled += 1; else tally.stillOpen[left] = (tally.stillOpen[left] ?? 0) + 1;
    const second = full.after(move.id, 0);
    if (second === null || signature(first) !== signature(second)) { tally.notRepeatable += 1; if (bad.length < 20) bad.push({ position: position.game, index: position.index, type: move.type, why: 'not repeatable' }); }
    if (signature(full.now(0)) !== start) { tally.touched += 1; if (bad.length < 20) bad.push({ position: position.game, index: position.index, type: move.type, why: 'start state changed' }); }
  }
  // what the engine leaves open (before any answer) is the same on both reads, for the moves both have
  const basicStart = signature(basic.now(0));
  if (basicStart !== start) tally.differentStart += 1;
  for (const move of basic.moves) { const state = basic.after(move.id, 0); if (state !== null && waiting(state) !== null) tally.openedBasic += 1; }
}
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ tally, mismatches: bad }, null, 2));
console.log(JSON.stringify(tally, null, 1));
if (bad.length) { console.log(JSON.stringify(bad.slice(0, 5), null, 1)); process.exitCode = 1; }
