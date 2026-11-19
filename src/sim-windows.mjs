// The choice windows a move leaves open in a determinized state (src/sim-host.mjs, reads=full): a target to pick, a card to take, a place to put a card, whether to answer
// an attack. The engine applies a move up to the first window and waits for an answer; a state in that half-resolved shape is not what the move does, so the
// sim answers the windows itself, on its own copy, before it hands the state out.
//
//   settle(state, { me, weights, clone, budget }) -> the state with its windows answered (the same object when it answers in place, else a copy)
//
// How a window is answered (the same engine calls the runtime makes for an answer: src/game/runtime/required-input/apply.js), by `budget`:
//   budget 0 (the default): the way the game's own CPU answers (src/adapters/simple-ai-policy.js, the CPU every CPU of cpus/ hands its windows to): an optional window is declined, a window
//     that must be answered takes its first answer (the first candidates in the order the engine lists them). The state a move leads to is then the state the match reaches, so a CPU
//     that looks ahead reads what its move does when the game's CPU answers what the move opens. (Checked in probe/windows-settle.mjs and by the predicted and the realized gain of the moves played.)
//   budget > 0: every answer is tried on a copy, the windows that the answer opens in turn are answered the same way, and the answer whose final state is best for the one who owns the
//     window is kept: the highest evaluation for `me`, the lowest for the other side (cpus/lookahead/eval.mjs with the weights the CPU gave; the same assumption playout() makes
//     for moves). That reads what the move does when its windows are answered well, which no CPU of cpus/ does yet: a CPU that hands its windows to the game's CPU overrates such moves.
//   - Equal cards are one answer (a card is told by its card id). More than MAX_ANSWERS answers of a window are cut to the first ones, and the whole settling stops trying
//     after `budget` copies; what is left is answered by its first answer.
//   - A selection of several cards (exact / up_to) tries the sets of the sizes minimum..maximum, in the order of the candidates, up to MAX_ANSWERS of them.
//   - A window with no engine call here (an allocation, the security rest window) is left open, as before.
// It reads only the state it is given: nothing of the real match.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { evaluate, DEFAULT_WEIGHTS } from '../cpus/lookahead/eval.mjs';

export const MAX_ANSWERS = 10;
export const DEFAULT_BUDGET = 0;
const MAX_DEPTH = 12;

export async function loadWindows(gameDir) {
  const imp = (p) => import(pathToFileURL(path.join(gameDir, p)).href);
  const engine = await imp('src/game/engine.js');
  const model = await imp('src/game/selection-model.js');
  const drag = await imp('src/game/effects/generic/access-drag.js');

  // card id of a uid anywhere in the state (a value that is not a card is its own identity)
  const cardIds = (state) => {
    const ids = new Map();
    const walk = (card) => { ids.set(card.uid, card.id); for (const child of card.mounted ?? []) walk(child); };
    for (const holder of ['player', 'ai']) for (const zone of ['deck', 'hand', 'front', 'back', 'registry', 'trash', 'ban']) for (const card of state.players[holder][zone]) walk(card);
    return ids;
  };
  const dedupe = (state, values) => {
    const ids = cardIds(state); const seen = new Set(); const out = [];
    for (const value of values) { const key = typeof value === 'string' && ids.has(value) ? `card:${ids.get(value)}` : `value:${JSON.stringify(value)}`; if (!seen.has(key)) { seen.add(key); out.push(value); } }
    return out;
  };
  const safe = (fn) => { try { return fn() === true; } catch { return false; } };

  const answerSelection = (state, selected, scope) => {
    const request = state.pending?.request;
    if (!request) return false;
    const draft = structuredClone(request);
    if (request.mode === 'scope') draft.selectedScope = scope;
    else if (request.mode !== 'random') draft.selected = selected;
    if (!model.canConfirmSelection(draft)) return false;
    const result = model.confirmSelection(draft, state.rng);
    return result !== null && engine.resolveCardSelection(state, request.continuation, result);
  };

  const combos = (items, minimum, maximum, cap) => {
    const sets = [];
    const walk = (start, size, chosen) => {
      if (sets.length >= cap) return;
      if (chosen.length === size) { sets.push(chosen); return; }
      for (let i = start; i < items.length; i += 1) walk(i + 1, size, [...chosen, items[i]]);
    };
    for (let size = Math.max(0, minimum); size <= Math.min(maximum, items.length); size += 1) walk(0, size, []);
    return sets;
  };

  // The window the state is waiting at, as { owner: 'player' | 'ai', answers: [{ run(state) -> boolean }] }, or null (nothing is open, or the window has no engine call here)
  // prune = false keeps equal cards apart; settle passes it at budget 0, so the first answer is the first candidates as listed, as the game CPU takes them
  function windowOf(state, prune = true) {
    const pending = state.pending ?? null;
    if (pending?.type === 'selection') {
      const request = pending.request;
      const owner = request?.continuation?.playerId;
      if (!['player', 'ai'].includes(owner) || typeof request.mode !== 'string' || request.spec?.kind === 'allocation') return null;
      if (request.mode === 'scope') return { owner, answers: dedupe(state, request.scopeOptions ?? []).slice(0, MAX_ANSWERS).map((scope) => ({ run: (st) => answerSelection(st, [], scope) })) };
      if (request.mode === 'random') return { owner, answers: [{ run: (st) => answerSelection(st, [], null) }] };
      const maximum = Number(request.maximum ?? request.count ?? 1); const minimum = Number(request.minimum ?? 0);
      // every candidate set of the right size; equal cards are merged only to prune a search (prune), never with groups (a group is a different slot for an equal card)
      // without the merge, two copies of one card can both be taken, as the game CPU does
      const candidates = (request.groups?.length || !prune) ? [...request.candidates] : dedupe(state, request.candidates);
      const sets = combos(candidates, minimum, maximum, MAX_ANSWERS);
      return { owner, answers: sets.map((selected) => ({ run: (st) => answerSelection(st, selected, null) })) };
    }
    if (pending?.type === 'response-window') {
      const owner = pending.playerId;
      return { owner, answers: [{ run: (st) => engine.declineResponse(st, owner) },
        ...dedupe(state, pending.candidates).slice(0, MAX_ANSWERS - 1).map((uid) => ({ run: (st) => engine.activateResponse(st, owner, uid) }))] };
    }
    if (pending?.type === 'response-target') {
      const owner = pending.playerId;
      return { owner, answers: dedupe(state, pending.validTargets).slice(0, MAX_ANSWERS).map((target) => ({ run: (st) => engine.activateResponse(st, owner, st.pending.cardUid, target) })) };
    }
    if (pending?.type === 'trigger-order') {
      const owner = state.triggerThread?.currentControllerId;
      if (!['player', 'ai'].includes(owner)) return null;
      const items = state.triggerThread.items.filter((item) => item.status === 'pending' && item.controllerId === owner).map((item) => item.id);
      return { owner, answers: items.slice(0, MAX_ANSWERS).map((id) => ({ run: (st) => engine.resolveTriggerChoice(st, id) })) };
    }
    if (drag.PLACEMENT_CHOICE_TYPES.includes(pending?.type)) {
      const owner = pending.playerId;
      const { slots, hosts } = drag.placementChoices(state, pending);
      // the first free slot of an area is as good as any other free slot of it: one answer for each area and each Ob to go under
      const seenZones = new Set();
      const answers = [];
      for (const { zone, slot } of slots) { if (seenZones.has(zone)) continue; seenZones.add(zone); answers.push({ run: (st) => engine.resolveAccessDragPlacement(st, owner, zone, null, slot) }); }
      for (const { zone, underUid } of hosts) answers.push({ run: (st) => engine.resolveAccessDragPlacement(st, owner, zone, underUid, null) });
      return { owner, answers: answers.slice(0, MAX_ANSWERS) };
    }
    const prompt = state.prompt ?? null;
    if (pending === null && prompt?.type === 'script-activation' && ['player', 'ai'].includes(prompt.playerId)) {
      return { owner: prompt.playerId, answers: [{ run: (st) => engine.declinePrompt(st) }, { run: (st) => engine.activateScript(st, prompt.playerId, prompt.scriptUid) }] };
    }
    if (pending === null && prompt?.type === 'plugin-number' && ['player', 'ai'].includes(prompt.playerId)) {
      return { owner: prompt.playerId, answers: Array.from({ length: 8 }, (_, value) => ({ run: (st) => engine.configurePlugin(st, prompt.playerId, prompt.pluginUid, value) })) };
    }
    return null;
  }

  const open = (state) => (state.pending ?? null) !== null || (state.prompt ?? null) !== null;

  // returns the settled state (`state` itself when nothing had to be tried)
  function settle(state, context, depth = 0) {
    if (!open(state)) return state;
    const here = windowOf(state, context.budget > 0);
    if (!here || here.answers.length === 0 || depth > MAX_DEPTH) return state;
    if (here.answers.length > 1 && context.budget > 0) {
      let best = null;
      for (const answer of here.answers) {
        if (context.budget <= 0) break;
        context.budget -= 1;
        const trial = context.clone(state);
        if (!safe(() => answer.run(trial))) continue;
        const done = settle(trial, context, depth + 1);
        const value = evaluate(done, context.me, context.weights);
        const score = here.owner === context.me ? value : -value;
        if (best === null || score > best.score) best = { state: done, score };
      }
      if (best !== null) return best.state;
    }
    // one answer, or no budget left: the first answer the engine takes
    for (const answer of here.answers) {
      if (safe(() => answer.run(state))) return settle(state, context, depth + 1);
    }
    return state;
  }

  return {
    settle: (state, { me, weights = DEFAULT_WEIGHTS, clone, budget = DEFAULT_BUDGET }) => settle(state, { me, weights, clone, budget }),
    windowOf, open
  };
}
