// Plays one match between two CPUs through the same local runtime port the game's own AI match uses, and measures it.
import { createTrace } from './trace.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadSimHost } from './sim-host.mjs';
import { loadCpu } from '../cpus/index.mjs';
import { appendOreBlock, matchLine, recordDecision, textHeader } from './ore.mjs';
import { actionSignature } from '../cpus/learned/candidates.mjs';
import { judgeMoves } from './judge.mjs';

const SEATS = ['seat-a', 'seat-b'];
const OPENING = new Set(['keepOpeningHand', 'openingMulligan']);
// What the board looks like, for telling a loop: both sides' STR and memory, every card of every zone with its sleep, damage and side, and the kind of window that is open
// (not its ids: they change from one turn of the loop to the next). The same signature again and again in one turn is a loop.
function boardSignature(state, windows = true) {
  const parts = windows ? [state.turnNumber, state.active, state.pending?.type ?? '', state.pending?.request?.continuation?.type ?? '', state.prompt?.type ?? ''] : [state.turnNumber];
  for (const id of ['player', 'ai']) {
    const p = state.players[id];
    parts.push(p.fortressStr, p.memory, p.deck.length);
    for (const zone of ['hand', 'front', 'back', 'registry', 'trash', 'ban']) {
      parts.push(zone);
      for (const c of p[zone]) parts.push(`${c.uid}${c.sleep ? 's' : ''}${c.damage ? `d${c.damage}` : ''}${c.faceDown ? 'f' : ''}${(c.mounted ?? []).length}`);
    }
  }
  return createHash('md5').update(parts.join('|')).digest('hex');
}
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
    tx: await imp('src/game/runtime/transaction.js'),
    record: await imp('src/game/runtime/match-record.js'),
    contract: await imp('src/adapters/port-contract.js'),
    decks: await imp('src/data/start-decks.js')
  };
  return game;
}

let simHost = null;
async function simHostFor(gameDir) { if (simHost?.dir !== gameDir) simHost = { dir: gameDir, host: await loadSimHost(gameDir) }; return simHost.host; }

export async function startDeckIds(gameDir) { return (await loadGame(gameDir)).decks.START_DECKS.map((deck) => deck.id); }

// job: { id, cpus: { 'seat-a': name, 'seat-b': name }, deckA, deckB (start deck ids), seed }
//   seat-a plays deckA, seat-b plays deckB. Who moves first is decided by the game's own opening dice (the seed).
// cpus: { 'seat-a': <created cpu>, 'seat-b': <created cpu> }
// record: { dir, tag, header, check } to write what the CPUs with a sim decided (src/ore.mjs); null for no record
// shadow: { create() -> a CPU that looks ahead } to have a teacher look at the decisions of the other CPUs and write what it would have done (DAgger); needs record
export async function playGame({ gameDir, job, cpus, limits, record: oreOut = null, shadow = null }) {
  const g = await loadGame(gameDir);
  const matchId = `bench:${job.id}`;
  const anomalies = [];
  const oreLines = oreOut ? [] : null;
  const textLines = oreOut?.text ? [] : null;
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
    // The match is held here, as an authority, and advanced with every accepted command; it is never handed to a CPU. Each step makes a port
    // for each seat on the current authority (the same local runtime port the game's own AI match uses; making one costs nothing).
    // A CPU that looks ahead (needsSim) gets, besides its seat's query, a sim made from the real match (src/sim-host.mjs).
    // `baseline` is the current CPU, which such a CPU falls back on.
    let authority = created.value;
    const recorded = g.record.createMatchRecord(authority);
    if (!recorded.ok) { note('record_failed', { error: recorded.error }); return result; }
    const record = recorded.value;
    const needsSim = SEATS.some((seat) => cpus[seat].needsSim === true) || Boolean(shadow);
    const needsBaseline = needsSim || SEATS.some((seat) => cpus[seat].needsBaseline === true);   // a CPU that falls back on the current CPU
    const host = needsSim ? await simHostFor(gameDir) : null;
    const baseline = needsBaseline ? await (await loadCpu('simple')).create(gameDir) : null;
    let idle = 0;
    const shadowStats = { n: 0, agree: 0, byType: {} };
    const noop = { processes: 0, second: 0, third: 0, max: 0 };
    let noopTurn = null; let noopCounts = new Map();
    // what each seat has done earlier in its turn (its own accepted moves), for the features that need it
    const histories = { 'seat-a': { turn: null, moves: 0, used: new Map() }, 'seat-b': { turn: null, moves: 0, used: new Map() } };
    const historyOf = (seat, turnNumber) => { const h = histories[seat]; if (h.turn !== turnNumber) { h.turn = turnNumber; h.moves = 0; h.used = new Map(); } return h; };
    const trace = limits.trace ? createTrace() : null;
    let commandNumber = 0;
    // The same command in the same state, again and again, is a loop (a command can be accepted and change nothing). `maxRepeat` such commands in a
    // row end the match as capped (cap "repeat"). "The state" is what the two seats see (both queries' observations, without the revision).
    let repeat = { key: null, digest: null, count: 0 };
    // The same board with the same kind of window, again and again in one turn, whoever acts (two seats can answer each other for ever): `maxLoop` such returns end the match as capped (cap "loop").
    let loopTurn = null; let loopSeen = new Map();
    let finished = false;
    for (;;) {
      if (result.commands >= limits.maxCommands) { result.status = 'capped'; result.cap = `commands>=${limits.maxCommands}`; break; }
      if (ms(started) > limits.maxWallMs) { result.status = 'capped'; result.cap = `wall>${limits.maxWallMs}ms`; break; }
      // Who acts: a seat with a choice it can answer, else the active seat.
      const tq = process.hrtime.bigint();
      const co = g.port.createLocalRuntimeCoordinator({ authority, sessionGeneration: 1 }).value;
      const ports = Object.fromEntries(SEATS.map((seat) => [seat, co.bind({ seatId: seat }).value]));
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
      const digest = createHash('md5').update(JSON.stringify(SEATS.map((seat) => { const { revision, ...rest } = queries[seat].value.observation; return rest; }))).digest('hex');
      // The CPU gets this seat's query and a planner on this seat's port, nothing else.
      let planning = 0;
      const port = ports[actor];
      const queryAction = (input) => { const t = process.hrtime.bigint(); const r = port.queryAction(input); planning += ms(t); return r; };
      const t0 = process.hrtime.bigint();
      let intent;
      let view = null;
      try {
        view = { query, queryAction, commandId, seatId: actor };
        if (cpus[actor].needsSim === true || cpus[actor].needsBaseline === true) view.baseline = () => baseline.choose({ query, queryAction, commandId, seatId: actor });
        if (cpus[actor].needsSim === true && query.requiredInput === null) view.sim = host.open({ authority, seat: actor });
        intent = await cpus[actor].choose(view);   // a CPU may answer with a promise (a teacher that is asked over the network)
      }
      catch (error) {
        note('cpu_exception', { seat: actor, revision: status.revision, message: String(error?.message ?? error), stack: String(error?.stack ?? '').split('\n').slice(0, 4).join(' | ') });
        idle += 1; if (idle >= limits.idle) { result.status = 'stuck'; break; } continue;
      }
      const chooseMs = ms(t0);
      if (!intent?.ok) {
        note('cpu_no_move', { seat: actor, revision: status.revision, code: intent?.error?.code ?? null });
        idle += 1; if (idle >= limits.idle) { result.status = 'stuck'; break; } continue;
      }
      if (oreLines && shadow && cpus[actor].needsSim !== true && query.requiredInput === null) {
        // a teacher looks at the decision this CPU has just made, on the same state; its answer is recorded, the CPU's is played.
        // A language model (shadow.kind "llm") needs no sim; a looking-ahead teacher (shadow.compare, or the shadow itself) does.
        try {
          const raw = ports[actor].queryAction;
          const isLlm = shadow.kind === 'llm';
          const needSim = !isLlm || Boolean(shadow.compare);
          const simView = needSim ? host.open({ authority, seat: actor }) : null;
          const base = () => baseline.choose({ query, queryAction: raw, commandId: `${commandId}s`, seatId: actor });
          let compare = null;
          if (shadow.compare) {
            const other = shadow.compare.create();
            const otherIntent = await other.choose({ query, queryAction: raw, commandId: `${commandId}c`, seatId: actor, sim: simView, baseline: base });
            compare = { cpu: other, sim: simView, intent: otherIntent };
          }
          // the questions are kept to the decisions worth them (shadow.scope, from the settings of the model), judged on the looking-ahead teacher's answer
          let skipTeacher = false;
          if (isLlm && shadow.scope && compare) {
            const lt = compare.intent?.ok ? compare.intent.value.action.type : null;
            if (!shadow.inScope(shadow.scope, lt, compare.cpu.lastDecision?.why)) { shadowStats.outOfScope = (shadowStats.outOfScope ?? 0) + 1; skipTeacher = true; }
          }
          if (!skipTeacher) {
          const teacher = shadow.create();
          const hint = isLlm && compare?.intent?.ok ? { action: compare.intent.value.action, type: compare.intent.value.action.type, why: compare.cpu.lastDecision?.why ?? null } : null;
          const teacherIntent = await teacher.choose({ query, queryAction: raw, commandId: `${commandId}s`, seatId: actor, sim: isLlm ? undefined : simView, baseline: base, hint });
          const kind = teacher.lastDecision?.kind;
          const usable = teacherIntent?.ok && !(kind === 'baseline' && !['no-gain', 'no-supported-move'].includes(teacher.lastDecision.why));
          // the model and the looking-ahead teacher chose different moves: which is worth more, by playing both out (src/judge.mjs)
          let judge = null;
          if (isLlm && shadow.judge && simView && compare?.intent?.ok && teacherIntent?.ok && teacher.lastDecision?.kind === 'llm' && actionSignature(teacherIntent.value.action) !== actionSignature(compare.intent.value.action)) {
            try {
              const j = judgeMoves(simView, [teacherIntent.value.action, compare.intent.value.action], shadow.judge);
              judge = { winner: j.verdict === 0 ? 'llm' : j.verdict === 1 ? 'lookahead' : j.verdict, values: { llm: j.values[0], lookahead: j.values[1] }, samples: j.samples, spread: j.spread, ...(j.reason ? { reason: j.reason } : {}) };
            } catch (error) { judge = { winner: 'error', message: String(error?.message ?? error).slice(0, 200) }; }
            const tally = (shadowStats.judge ??= {}); tally[judge.winner] = (tally[judge.winner] ?? 0) + 1;
          }
          if (teacherIntent?.ok) {
            const line = recordDecision({ query, queryAction: raw, sim: isLlm ? null : simView, cpu: teacher, intent: teacherIntent, student: intent, compare,
              meta: { job: job.id, seed: job.seed, seat: actor, rev: status.revision, turn: query.observation?.turnNumber ?? null }, history: historyOf(actor, query.observation?.turnNumber ?? null), text: textLines, judge });
            if (line) oreLines.push(line);
          }
          if (usable) {
            const type = teacherIntent.value.action.type; const same = actionSignature(teacherIntent.value.action) === actionSignature(intent.value.action);
            shadowStats.n += 1; if (same) shadowStats.agree += 1;
            const t = (shadowStats.byType[type] ??= [0, 0]); t[0] += 1; if (same) t[1] += 1;
          }
          }
        } catch (error) { note('shadow_error', { rev: status.revision, message: String(error?.message ?? error), stack: String(error?.stack ?? '').split(String.fromCharCode(10)).slice(0, 3).join(' | ') }); }
      }
      if (oreLines && cpus[actor].needsSim === true) {
        try {
          const line = recordDecision({ query, queryAction: ports[actor].queryAction, sim: view.sim ?? null, cpu: cpus[actor], intent, meta: { job: job.id, seed: job.seed, seat: actor, rev: status.revision, turn: query.observation?.turnNumber ?? null }, history: historyOf(actor, query.observation?.turnNumber ?? null), text: textLines,
            timing: ({ planCalls, planMs, featureMs, candidates }) => { (result.featureTiming ??= []).push([candidates, Math.round(planMs * 1000) / 1000, Math.round(featureMs * 1000) / 1000, planCalls]); } });
          if (line) oreLines.push(line);
        } catch (error) { note('record_error', { rev: status.revision, message: String(error?.message ?? error), stack: String(error?.stack ?? '').split(String.fromCharCode(10)).slice(0, 3).join(' | ') }); }
      }
      result.choose.push(round(chooseMs)); result.planning.push(round(planning)); result.queryMs.push(round(queryMs));
      const ts = process.hrtime.bigint();
      trace?.before(authority.engineState);
      const sigBefore = limits.watchNoop ? boardSignature(authority.engineState, false) : null;
      let submitted;
      try {
        const bound = g.contract.makeBoundCommand({ contractVersion: 1, matchId, seatId: actor, seatIds: [...SEATS], sessionGeneration: 1 }, intent.value);
        submitted = bound.ok ? g.tx.submitRuntimeCommand(authority, { matchId, actorSeat: actor }, bound.value, { tutorialAuthorized: false }) : bound;
        if (submitted.ok && submitted.value?.kind === 'accepted') {
          // the match record, as the local runtime port writes it
          const encoded = g.record.encodeRecordedAction(authority, actor, bound.value.action);
          if (!encoded.ok) throw new Error(`record: ${encoded.error?.code}`);
          const card = g.record.recordedCardDefinition(authority.engineState, encoded.value);
          record.commands.push({ seat: actor, action: encoded.value, ...(card ? { card } : {}) });
          authority = submitted.value.authority;
          trace?.after(authority.engineState, SEATS.indexOf(actor));
        }
      }
      catch (error) {
        note('submit_exception', { seat: actor, revision: status.revision, message: String(error?.message ?? error) });
        idle += 1; if (idle >= limits.idle) { result.status = 'stuck'; break; } continue;
      }
      result.submitMs.push(round(ms(ts)));
      const kind = submitted.ok ? submitted.value?.kind : 'error';
      if (kind === 'accepted') {
        idle = 0; result.commands += 1;
        if (sigBefore !== null) {
          // a process that left the board as it was (windows left out of the board), counted per seat, board and action, in one turn
          const st = authority.engineState;
          if (st.turnNumber !== noopTurn) { noopTurn = st.turnNumber; noopCounts = new Map(); }
          if (boardSignature(st, false) === sigBefore) {
            const a = intent.value.action;
            const key = `${actor}|${sigBefore}|${a.type}|${JSON.stringify(a.optionIds ?? a.cardRef ?? a.attackerRef ?? null)}|${JSON.stringify(a.target ?? a.destination ?? null)}`;
            const n = (noopCounts.get(key) ?? 0) + 1; noopCounts.set(key, n);
            noop.processes += 1; if (n === 2) noop.second += 1; if (n === 3) { noop.third += 1; (noop.third_types ??= {})[a.type] = (noop.third_types[a.type] ?? 0) + 1; } if (n > noop.max) noop.max = n;
          }
        }
        if (!['answerChoice', 'declineChoice', 'keepOpeningHand', 'openingMulligan'].includes(intent.value.action.type)) {
          const h = historyOf(actor, query.observation?.turnNumber ?? null); const a = intent.value.action;
          const key = `${a.type}:${a.cardRef ?? a.attackerRef ?? ''}`; h.moves += 1; h.used.set(key, (h.used.get(key) ?? 0) + 1);
        }
        const key = `${actor}|${JSON.stringify(intent.value.action)}`;
        repeat = key === repeat.key && digest === repeat.digest ? { key, digest, count: repeat.count + 1 } : { key, digest, count: 1 };
        {
          const st = authority.engineState;
          if (st.turnNumber !== loopTurn) { loopTurn = st.turnNumber; loopSeen = new Map(); }
          const signature = boardSignature(st);
          const seen = (loopSeen.get(signature) ?? 0) + 1; loopSeen.set(signature, seen);
          if (limits.maxLoop && seen >= limits.maxLoop) { result.status = 'capped'; result.cap = `loop>=${limits.maxLoop}`; result.repeated = { seat: actor, action: intent.value.action?.type ?? null, turn: st.turnNumber }; break; }
        }
        if (repeat.count >= limits.maxRepeat) { result.status = 'capped'; result.cap = `repeat>=${limits.maxRepeat}`; result.repeated = { seat: actor, action: intent.value.action?.type ?? null }; break; }
        if (result.firstSeat === null && !OPENING.has(intent.value.action.type)) result.firstSeat = actor;
      } else {
        note('illegal_move', {
          seat: actor, revision: status.revision, action: intent.value.action?.type ?? null, kind,
          code: submitted.ok ? submitted.value?.receipt?.reasonCode ?? null : submitted.error?.code ?? null
        });
        idle += 1; if (idle >= limits.idle) { result.status = 'stuck'; break; }
      }
    }
    // the result, as the local runtime port summarizes it
    const locked = authority.engineState.victory?.lockedOutcome ?? null;
    const outcome = locked === null ? null : locked === 'draw' ? { kind: 'draw' } : { kind: 'win', winnerSeat: authority.metadata.seatIds[locked === 'player' ? 0 : 1] };
    result.turns = authority.engineState.turnNumber;
    result.outcome = outcome;
    result.hash = createHash('sha256').update(JSON.stringify([record.commands, outcome, result.turns])).digest('hex').slice(0, 16);
    if (finished) result.status = 'finished';
    if (limits.watchNoop) result.noop = noop;
    if (shadow) result.shadow = shadowStats;
    const counters = Object.fromEntries(SEATS.filter((seat) => cpus[seat].counters).map((seat) => [seat, cpus[seat].counters]));
    if (Object.keys(counters).length > 0) result.cpuStats = counters;
    if (trace) result.trace = trace.result(authority.engineState.firstPlayer === 'player' ? 0 : 1);
    if (limits.keepRecord) result.record = record;
  } catch (error) {
    note('game_exception', { message: String(error?.message ?? error), stack: String(error?.stack ?? '').split('\n').slice(0, 4).join(' | ') });
    result.status = 'error';
  }
  result.wallMs = Math.round(ms(started));
  if (oreOut && oreLines) appendOreBlock(oreOut.dir, oreOut.tag, oreOut.header, [...oreLines, matchLine(result, oreLines)]);
  if (oreOut && textLines) appendOreBlock(oreOut.dir, oreOut.tag, textHeader({ game: oreOut.header.game, rules: oreOut.header.rules, cpus: oreOut.header.cpus, shadow: oreOut.header.shadow ?? null }), [...textLines, matchLine(result, textLines)], 'text');
  return result;
}
