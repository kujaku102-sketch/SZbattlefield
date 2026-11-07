// A safety a CPU carries against a loop between two seats: the same board with the same kind of window comes back and back in one turn, each seat giving its same
// answer (the game's own CPU always declines an optional window and takes the first option of a pick). When the same window has come back `threshold` times this turn,
// the CPU answers it differently: an optional window it would decline, it takes; one it would take, it declines; a pick among several options, another option each time.
// Nothing else changes: before the third return the answer is the CPU's own, and a window that cannot be answered differently (one option, nothing optional) is answered as usual.
//
// (cpus/lookahead.mjs and cpus/learned/policy.mjs use it. The game's own CPU, src/adapters/simple-ai-policy.js, is to get the same safety.)

// What the seat sees, without the revision, and the kind of window it is asked: the same string means the same board and the same question.
const windowKey = (query) => {
  const { revision, ...rest } = query.observation ?? {};
  const input = query.requiredInput;
  return `${JSON.stringify(rest)}|${input ? `${input.presentationKey}:${input.kind}:${input.optional}` : 'main'}`;
};

export function createLoopGuard({ threshold = 3 } = {}) {
  let turn = null;
  let seen = new Map();
  let lastRevision = -1; let lastCount = 0;     // asking again at the same revision (the answer was refused) is not another return
  let changedAt = -1;                          // the revision at which an answer was last changed: if it comes back unchanged, the changed answer was refused
  return {
    // call once per decision: how many times this window has been asked, this one included, in this turn
    see(query) {
      const now = query.observation?.turnNumber ?? null;
      if (now !== turn) { turn = now; seen = new Map(); }
      const revision = query.status?.revision ?? -1;
      if (revision === lastRevision) return lastCount;
      const key = windowKey(query);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      lastRevision = revision; lastCount = count;
      return count;
    },
    // the answer to a window: `result` (the CPU's usual answer, in the shape choose() returns) unless the window has come back `threshold` times
    change(query, count, result) {
      const input = query.requiredInput;
      if (count < threshold || !input?.canAnswer || !result?.ok) return result;
      const revision = query.status?.revision ?? -1;
      if (changedAt === revision) return result;                // the changed answer was refused here: the CPU's own answer, as before
      const plain = input.constraints?.kind === 'pick' && (input.constraints.groups ?? []).length === 0 && !input.constraints.aggregate;
      const base = result.value.action;
      const reply = (action) => ({ ok: true, value: { commandId: result.value.commandId, expectedRevision: result.value.expectedRevision, action } });
      const take = (option) => reply({ type: 'answerChoice', choiceId: input.choiceId, optionIds: [option.optionId], allocation: [] });
      if (input.optional) {
        if (base.type === 'declineChoice' && input.options?.length && (input.kind === 'confirmation' || plain)) { changedAt = revision; return take(input.options[(count - threshold) % input.options.length]); }
        if (base.type === 'answerChoice') { changedAt = revision; return reply({ type: 'declineChoice', choiceId: input.choiceId }); }
      } else if (plain && input.constraints.minimum === 1 && input.constraints.maximum === 1 && input.options?.length > 1) {
        changedAt = revision; return take(input.options[(count - threshold + 1) % input.options.length]);
      }
      return result;
    }
  };
}
