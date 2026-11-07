// Plays one match between two CPUs through the same local runtime port the game's own AI match uses, and measures it.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const SEATS = ['seat-a', 'seat-b'];
const OPENING = new Set(['keepOpeningHand', 'openingMulligan']);
const ms = (from) => Number(process.hrtime.bigint() - from) / 1e6;
const round = (value) => Math.round(value * 100) / 100;

let game = null;
async function loadGame(gameDir) {
  if (game?.dir === gameDir) return game;
  const imp = (p) => import(pathToFileURL(path.join(gameDir, p)).href);
  game = {
    dir: gameDir,
    authority: await imp('src/game/runtime/authority.js'),
    port: await imp('src/adapters/local-runtime-port.js'),
    versions: await imp('src/game/runtime/versions.js'),
    decks: await imp('src/data/start-decks.js')
  };
  return game;
}

export async function startDeckIds(gameDir) { return (await loadGame(gameDir)).decks.START_DECKS.map((deck) => deck.id); }

// job: { id, cpus: { 'seat-a': name, 'seat-b': name }, deckA, deckB (start deck ids), seed }
//   seat-a plays deckA, seat-b plays deckB. Who moves first is decided by the game's own opening dice (the seed).
// cpus: { 'seat-a': <created cpu>, 'seat-b': <created cpu> }
export async function playGame({ gameDir, job, cpus, limits }) {
  const g = await loadGame(gameDir);
  const matchId = `bench:${job.id}`;
  const anomalies = [];
  const note = (type, detail) => { if (anomalies.length < 20) anomalies.push({ type, ...detail }); };
  const started = process.hrtime.bigint();
  const result = {
    job: job.id, seed: job.seed, decks: { 'seat-a': job.deckA, 'seat-b': job.deckB }, cpus: job.cpus,
    status: 'error', firstSeat: null, outcome: null, turns: null, commands: 0, anomalies, wallMs: 0, hash: null,
    choose: [], planning: [], queryMs: [], submitMs: []
  };
  try {
    const created = g.authority.createMatchAuthority({
      matchId, seatIds: SEATS, seed: job.seed, ruleVersion: g.versions.RULE_VERSION, cardVersion: g.versions.CARD_VERSION,
      gameOptions: { mode: 'ai', playerDeckId: job.deckA, aiDeckId: job.deckB, openingProtocol: 'v2.4' }
    });
    if (!created.ok) { note('create_failed', { error: created.error }); return result; }
    const coordinator = g.port.createLocalRuntimeCoordinator({ authority: created.value, sessionGeneration: 1 });
    if (!coordinator.ok) { note('coordinator_failed', { error: coordinator.error }); return result; }
    const co = coordinator.value;
    const ports = Object.fromEntries(SEATS.map((seat) => [seat, co.bind({ seatId: seat }).value]));
    let idle = 0;
    let commandNumber = 0;
    let finished = false;
    for (;;) {
      if (result.commands >= limits.maxCommands) { result.status = 'capped'; result.cap = `commands>=${limits.maxCommands}`; break; }
      if (ms(started) > limits.maxWallMs) { result.status = 'capped'; result.cap = `wall>${limits.maxWallMs}ms`; break; }
      // Who acts: a seat with a choice it can answer, else the active seat.
      const tq = process.hrtime.bigint();
      const queries = Object.fromEntries(SEATS.map((seat) => [seat, ports[seat].query()]));
      const queryMs = ms(tq) / SEATS.length;
      const bad = SEATS.find((seat) => !queries[seat].ok);
      if (bad) { note('query_failed', { seat: bad, error: queries[bad].error }); result.status = 'error'; break; }
      const status = queries['seat-a'].value.status;
      if (status.finished || status.progress === 'finished') { finished = true; break; }
      const actor = SEATS.find((seat) => queries[seat].value.requiredInput?.canAnswer) ?? status.activeSeat;
      const query = queries[actor].value;
      commandNumber += 1;
      const commandId = `c${commandNumber}`;
      // The CPU gets this seat's query and a planner on this seat's port, nothing else.
      let planning = 0;
      const port = ports[actor];
      const queryAction = (input) => { const t = process.hrtime.bigint(); const r = port.queryAction(input); planning += ms(t); return r; };
      const t0 = process.hrtime.bigint();
      let intent;
      try { intent = cpus[actor].choose({ query, queryAction, commandId, seatId: actor }); }
      catch (error) {
        note('cpu_exception', { seat: actor, revision: status.revision, message: String(error?.message ?? error), stack: String(error?.stack ?? '').split('\n').slice(0, 4).join(' | ') });
        idle += 1; if (idle >= limits.idle) { result.status = 'stuck'; break; } continue;
      }
      const chooseMs = ms(t0);
      if (!intent?.ok) {
        note('cpu_no_move', { seat: actor, revision: status.revision, code: intent?.error?.code ?? null });
        idle += 1; if (idle >= limits.idle) { result.status = 'stuck'; break; } continue;
      }
      result.choose.push(round(chooseMs)); result.planning.push(round(planning)); result.queryMs.push(round(queryMs));
      const ts = process.hrtime.bigint();
      let submitted;
      try { submitted = port.submit(intent.value); }
      catch (error) {
        note('submit_exception', { seat: actor, revision: status.revision, message: String(error?.message ?? error) });
        idle += 1; if (idle >= limits.idle) { result.status = 'stuck'; break; } continue;
      }
      result.submitMs.push(round(ms(ts)));
      const kind = submitted.ok ? submitted.value?.kind : 'error';
      if (kind === 'accepted') {
        idle = 0; result.commands += 1;
        if (result.firstSeat === null && !OPENING.has(intent.value.action.type)) result.firstSeat = actor;
      } else {
        note('illegal_move', {
          seat: actor, revision: status.revision, action: intent.value.action?.type ?? null, kind,
          code: submitted.ok ? submitted.value?.receipt?.reasonCode ?? null : submitted.error?.code ?? null
        });
        idle += 1; if (idle >= limits.idle) { result.status = 'stuck'; break; }
      }
    }
    const record = co.matchRecord();
    if (record.ok) {
      const summary = record.value.summary;
      result.turns = summary.turns;
      result.outcome = summary.outcome ?? null;
      result.hash = createHash('sha256').update(JSON.stringify([record.value.commands, summary.outcome, summary.turns])).digest('hex').slice(0, 16);
      if (finished) result.status = 'finished';
      if (limits.keepRecord) result.record = record.value;
    } else note('record_failed', { error: record.error });
    co.dispose();
  } catch (error) {
    note('game_exception', { message: String(error?.message ?? error), stack: String(error?.stack ?? '').split('\n').slice(0, 4).join(' | ') });
    result.status = 'error';
  }
  result.wallMs = Math.round(ms(started));
  return result;
}
