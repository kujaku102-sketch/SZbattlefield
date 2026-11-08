// The trusted side of a CPU that looks ahead (see src/sim.mjs). The harness holds the real match; for one decision of one seat it
// opens a `decision` and gives the CPU only that:
//
//   decision.me          'player' | 'ai': the seat's side in the engine states below
//   decision.moves       the seat's moves: [{ id, type, uids, zone, targetKind }]  (src/moves.mjs; the real engine calls and actions stay on this side)
//   decision.unsupported the types of candidates that have no engine call yet (so nothing is silently dropped)
//   decision.samples     how many determinized states there are
//   decision.now(k)      determinized state k: what the seat cannot see is re-drawn (src/sim.mjs); read it, do not keep it
//   decision.after(id,k) a copy of determinized state k with move `id` applied, or null if the engine refuses it
//   decision.branch(state, who)  the moves of 'me' or 'opp' on any state this decision handed out (a result of after() or branch().after()): { moves, after(id) }. This is how a CPU
//                        reads further than one move; the states are all determinized ones, nothing of the real match is in them.
//   decision.intent(id)  the runtime intent for move `id`, to be returned from choose()
//   decision.elapsedMs() time since the decision was opened
//
// Nothing here gives a CPU the real engine state, the authority, the opponent's hidden cards or the means to reach them.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadSim } from './sim.mjs';
import { loadCandidates } from './candidates.mjs';
import { loadMoves } from './moves.mjs';

const now = () => process.hrtime.bigint();
const msSince = (t) => Number(now() - t) / 1e6;
const mulberry32 = (seed) => () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = Math.imul(seed ^ (seed >>> 15), seed | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hashOf = (text) => { let h = 2166136261; for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };

export async function loadSimHost(gameDir) {
  const sim = await loadSim(gameDir);
  const cand = await loadCandidates(gameDir);
  const mv = await loadMoves(gameDir);
  const planning = await import(pathToFileURL(path.join(gameDir, 'src/game/runtime/planning-context.js')).href);
  const { G } = sim;

  // authority: the real match (never handed out); seat: the deciding seat; samples: how many determinized states to offer
  function open({ authority, seat, samples = 4 }) {
    const started = now();
    const engine = authority.engineState;
    const metadata = authority.metadata;
    const seatIds = metadata.seatIds;
    const me = seat === seatIds[0] ? 'player' : 'ai';
    const options = metadata.startOptions;
    const deckIds = { player: options.playerDeckRecipe ? Object.fromEntries(options.playerDeckRecipe) : options.playerDeckId, ai: options.aiDeckRecipe ? Object.fromEntries(options.aiDeckRecipe) : options.aiDeckId };
    const rand = mulberry32(hashOf(`${metadata.matchId}|${authority.revision}|${seat}`));
    const states = [];
    const sample = (k) => states[k] ??= sim.determinize(engine, me, seatIds, deckIds, rand).state;
    // The engine's own checks (can this card be played here?) may write to the state they are given (a log line, a message), so moves are
    // found on a copy of the first determinized state (the set is the same as on the real state: probe/candidates.mjs), never on the real match.
    const planned = sim.shareClone(sample(0));
    const context = cand.engineContext(planned, metadata, seat);
    const catalog = context.allowed ? cand.catalog(planned, metadata, seat) : [];
    const expanded = mv.expand(context, catalog);
    // Moves that differ only in which free slot of a zone they take are the same move for a CPU that looks one move ahead: one of each is kept.
    const seen = new Set();
    const moves = expanded.moves.filter((move) => {
      const key = [move.type, [...move.uids].sort().join(','), move.action.destination?.zone ?? '', move.action.target?.kind ?? ''].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((move, id) => ({ ...move, id }));
    const unsupported = expanded.unsupported;

    // The runtime's names for cards (needed only to submit the chosen move), built once and only when a move is chosen.
    let rename = null;
    const renamer = () => {
      if (rename) return rename;
      const runtime = planning.createPlanningContext(authority, seat);
      const refs = new Map();
      for (const { card } of cand.entriesOf(engine, seatIds).values()) { const ref = runtime.refFor(card); if (ref) refs.set(card.uid, ref); }
      const walk = (value) => typeof value === 'string' ? (refs.get(value) ?? value)
        : Array.isArray(value) ? value.map(walk) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)])) : value;
      return (rename = walk);
    };

    return {
      me,
      // zone (where a card goes) and targetKind (what an attack goes for) are public parts of the move; the action itself stays on this side
      moves: moves.map(({ id, type, uids, action }) => ({ id, type, uids, zone: action.destination?.zone ?? null, targetKind: action.target?.kind ?? null })),
      unsupported,
      samples,
      now: (k) => sample(k),
      after(id, k) {
        const move = moves[id];
        if (!move) return null;
        const copy = sim.shareClone(sample(k));
        const result = G.actions.applyPreparedRuntimeAction(copy, move.adapter, { metadata, referenceState: authority.referenceState });
        return result.ok && ['applied-complete', 'applied-awaiting-input'].includes(result.value.kind) ? copy : null;
      },
      // the moves of one side on a state of this decision (a determinized one, or one reached from it by moves). Nothing is offered when it is not that side's turn or a choice is open.
      branch(state, who) {
        const seatFor = who === 'me' ? seat : seatIds[seatIds[0] === seat ? 1 : 0];
        // a card drawn from a determinized deck has no compiled effect yet (the deck cards are not hydrated): the cards in hand get it before their moves are looked for
        for (const holder of ['player', 'ai']) { const cards = state.players[holder].hand; cards.forEach((card, index) => { if (!card.compiled) cards[index] = G.prepare.hydrateCard(card); }); }
        const planned = sim.shareClone(state);
        const ctx = cand.engineContext(planned, metadata, seatFor);
        const entries = ctx.allowed ? cand.catalog(planned, metadata, seatFor) : [];
        const expandedHere = mv.expand(ctx, entries);
        const seenHere = new Set();
        const list = expandedHere.moves.filter((move) => {
          const key = [move.type, [...move.uids].sort().join(','), move.action.destination?.zone ?? '', move.action.target?.kind ?? ''].join('|');
          if (seenHere.has(key)) return false;
          seenHere.add(key);
          return true;
        }).map((move, id) => ({ ...move, id }));
        return {
          moves: list.map(({ id, type, uids, action }) => ({ id, type, uids, zone: action.destination?.zone ?? null, targetKind: action.target?.kind ?? null })),
          after(id) {
            const move = list[id];
            if (!move) return null;
            const copy = sim.shareClone(state);
            const result = G.actions.applyPreparedRuntimeAction(copy, move.adapter, { metadata, referenceState: authority.referenceState });
            return result.ok && ['applied-complete', 'applied-awaiting-input'].includes(result.value.kind) ? copy : null;
          }
        };
      },
      intent(id, { commandId, expectedRevision }) {
        const move = moves[id];
        if (!move) return null;
        return { commandId, expectedRevision, action: renamer()(move.action) };
      },
      elapsedMs: () => msSince(started)
    };
  }

  return { open, sim };
}
