// FROZEN COPY for lightZIG gen3 (cpus/release/gen3/lightZIG.mjs): cpus/learned/loopguard.mjs at commit 91f6d4f. Do not edit and do not follow changes elsewhere: lightZIG gen3 must play the same for ever.
// What a CPU does not do: repeat a process that changes nothing, in the same turn on the same board. (The rule of the game allows it; a machine that repeats it for ever is
// the trouble. A person's moves are not restricted.) This file is the prohibition for the answers to windows; the moves of the main phase have their own (a move that was
// accepted and changed nothing is not chosen again in the same turn: cpus/lookahead.mjs, cpus/learned/policy.mjs).
//
// Counting (the same terms as stalemate/禁則案.md 1.3):
//   board      what the seat sees, without the revision: the observation of its query. The window that is open is not part of it.
//   process    the seat's answer to a window: the kind of answer and the options it picks (not the ids of the window, which change from one return to the next).
//   a process counts when it was accepted and the board was the same at the next decision. Counted per board and process, in one turn.
// Prohibition:
//   an answer is not given a third time on a board where it has already changed nothing twice (`threshold` 3). Another answer is given: a pick among several options takes
//   the next option; an optional window that would have been taken is declined.
//   Declining is the CPU's usual answer to an optional window and is let through longer: it is changed (to taking the first option, which for a Script is "activate")
//   only the sixth time (`declineThreshold` 6; in 196 ordinary matches a decline reached its fourth time at most).
// When there is no other answer (a mandatory pick with one option): the CPU gives its usual answer, as the game needs an answer, and counts it in `unavoidable` (the CPU's counters
// show it). The loop is then the game's to prevent (the cause is a fault of the game: stalemate/報告.md); the bench cuts such a match off (cap "loop").
// A changed answer that the game refuses comes back as the same decision: the CPU's usual answer is given then.
//
// (cpus/lookahead.mjs and cpus/learned/policy.mjs use it. The game's own CPU, src/adapters/simple-ai-policy.js, is to get the same.)

const boardKey = (query) => { const { revision, ...rest } = query.observation ?? {}; return JSON.stringify(rest); };

export function createLoopGuard({ threshold = 3, declineThreshold = 6 } = {}) {
  let turn = null;
  let counts = new Map();             // `${board}|${process}` -> times it was accepted and changed nothing
  let prev = null;                    // the answer given at the last decision: { board, key, revision }
  let changedAt = -1;                 // the revision at which an answer was last changed (if it comes back, the changed answer was refused)
  const stats = { changed: 0, unavoidable: 0 };
  const processKey = (action) => `${action.type}|${JSON.stringify(action.optionIds ?? null)}`;
  return {
    stats,
    // at the start of every decision: settles the previous answer (accepted and the board the same: counted) and returns the board's key
    begin(query) {
      const now = query.observation?.turnNumber ?? null;
      if (now !== turn) { turn = now; counts = new Map(); prev = null; }
      const board = boardKey(query);
      if (prev !== null && (query.status?.revision ?? -1) !== prev.revision && prev.board === board) counts.set(prev.key, (counts.get(prev.key) ?? 0) + 1);
      prev = null;
      return board;
    },
    // the answer to a window: `result` (the CPU's usual answer, in the shape choose() returns), or another one when the usual one is prohibited
    answer(query, board, result) {
      const input = query.requiredInput;
      if (!input?.canAnswer || !result?.ok) return result;
      const revision = query.status?.revision ?? -1;
      const usual = result.value.action;
      const reply = (action) => ({ ok: true, value: { commandId: result.value.commandId, expectedRevision: result.value.expectedRevision, action } });
      const take = (option) => reply({ type: 'answerChoice', choiceId: input.choiceId, optionIds: [option.optionId], allocation: [] });
      const done = (given) => { prev = { board, key: `${board}|${processKey(given.value.action)}`, revision }; return given; };
      const times = counts.get(`${board}|${processKey(usual)}`) ?? 0;                      // times it was accepted and changed nothing
      const limit = (usual.type === 'declineChoice' ? declineThreshold : threshold) - 1;
      if (times < limit) return done(result);
      if (changedAt === revision) return done(result);                                      // the other answer was refused here: the usual one
      const plain = input.constraints?.kind === 'pick' && (input.constraints.groups ?? []).length === 0 && !input.constraints.aggregate;
      let other = null;
      if (input.optional) {
        if (usual.type === 'declineChoice' && input.options?.length && (input.kind === 'confirmation' || plain)) other = take(input.options[(times - limit) % input.options.length]);
        else if (usual.type === 'answerChoice') other = reply({ type: 'declineChoice', choiceId: input.choiceId });
      } else if (plain && input.constraints.minimum === 1 && input.constraints.maximum === 1 && input.options?.length > 1) {
        other = take(input.options[(times - limit + 1) % input.options.length]);
      }
      if (other === null) { stats.unavoidable += 1; return done(result); }
      changedAt = revision; stats.changed += 1;
      return done(other);
    }
  };
}
