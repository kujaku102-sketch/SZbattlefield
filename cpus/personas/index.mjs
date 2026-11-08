// The named sets of weights for the evaluation of a state (cpus/lookahead/eval.mjs): a CPU that looks ahead (lookahead, deep) plays with the persona it is given:  lookahead?persona=control
// A persona is a file of this folder: { name, jp, note, weights: { str, ownStr, board, oppBoard, ready, hand, registry, back, memory, hp }, colorAdjust }.
// `weights` replaces the default ones it names (the others stay). `colorAdjust` is the shape of the small corrections by the colours a deck is built in, to be filled in for the persona that
// plays a specific tactic:   { "<colour>": { "<weight name>": <amount to add> } }   (empty for now; nothing reads it yet). A persona is not a deck: the same weights for every deck.
// All the personas are imported here, by name: a CPU that looks ahead may not import dynamically (cpus/index.mjs), and the file's hash is part of the CPU's version.
import beatdown from './beatdown.json' with { type: 'json' };
import control from './control.json' with { type: 'json' };

export const PERSONAS = Object.freeze({ beatdown, control });

export function weightsFor(name) {
  const persona = PERSONAS[name];
  if (!persona) throw new Error(`persona ${name}? one of ${Object.keys(PERSONAS).join(', ')}`);
  return persona.weights;
}
