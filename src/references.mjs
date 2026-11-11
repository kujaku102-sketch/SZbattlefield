// What a re-drawn state still says about the real cards it replaced.
//
// determinize (sim.js) puts a drawn card in the place of every card the seat cannot see. The engine keeps more than the zones: an activation window, a choice that is waiting, the last event,
// the queue of scripts, the turn a card came into play, all name the cards they are about by uid, and some hold a copy of the card, build their own id from the card's id and uid
// ("EV-21:STD-239:own-user-damaged:rt:i:79"), or carry its card id and its name beside the uid (an event: cardUid, cardId, cardName). Left as they are, they say what the real card was,
// and the engine, asked to try a move on the state, answers from the real card.
//
// So every reference to a replaced card is turned into a reference to the card drawn for it:
//   - a uid, in a string or as a key, becomes the drawn card's uid;
//   - a copy of the card becomes a copy of the drawn card;
//   - in an object that names a replaced card, a string of its own that is the card id or the name of the replaced card (an event's cardId and cardName), or an id built from the card id and
//     uid (the id of a window), becomes the drawn card's; so does the label of a replaced card in a map of labels by uid (the labels of a choice). A name is changed only when it is the
//     whole string: a card's name can be a part of another card's name. The sentences the engine writes for a person (a prompt's message) are not rewritten; a CPU is not handed them;
//   - an activation window whose source is a replaced card, and a script waiting to be activated for one, are dropped: what they hold is the real card's trigger (its conditions, its
//     actions), which a drawn card does not have, and the window is about a moment of the real match that the re-drawn state does not have.
//
// `replaced` is [{ uid, id, name, fresh }]: the real card's uid, card id and name, and the card drawn for it. A card that was mounted on a replaced card goes with it (the same entry, its own
// uid). `compiled` (the card's compiled effect) is shared with the real state and is read only: it is never entered.

const escapePattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isCard = (value) => typeof value.uid === 'string' && typeof value.id === 'string' && 'category' in value;

export function remapReferences(state, replaced) {
  if (replaced.length === 0) return;
  const byUid = new Map(replaced.map((entry) => [entry.uid, entry]));
  const byFreshUid = new Map(replaced.map((entry) => [entry.fresh.uid, entry]));
  // a uid inside a longer string ("...:rt:i:79"), where a longer uid is tried before a shorter one that starts the same ("rt:i:79" before "rt:i:7")
  const uidPattern = new RegExp(`(${[...byUid.keys()].sort((a, b) => b.length - a.length).map(escapePattern).join('|')})(?![0-9A-Za-z_])`, 'g');
  const mapUid = (text) => (byUid.has(text) ? byUid.get(text).fresh.uid : text.replace(uidPattern, (found) => byUid.get(found).fresh.uid));
  const namedIn = (text) => [...text.matchAll(uidPattern)].map((found) => byUid.get(found[0]));

  // what belongs to a moment of the real match
  if (Array.isArray(state.activationWindows)) state.activationWindows = state.activationWindows.filter((window) => !byUid.has(window?.source?.card?.uid));
  if (Array.isArray(state.scriptActivationQueue)) state.scriptActivationQueue = state.scriptActivationQueue.filter((entry) => !byUid.has(entry?.prompt?.scriptUid) && !byUid.has(entry?.scriptUid));

  // the card id and the name of the replaced cards an object names: the ones that are a whole string of its own, and the id inside a string that was built from the uid
  const swapIn = (object, named, builtFromUid) => {
    const exact = new Map();
    for (const entry of named) { exact.set(entry.id, entry.fresh.id); if (entry.name) exact.set(entry.name, entry.fresh.name); }
    for (const key of Object.keys(object)) {
      const text = object[key];
      if (typeof text !== 'string') continue;
      if (exact.has(text)) object[key] = exact.get(text);
      else if (builtFromUid.has(key)) for (const entry of named) object[key] = object[key].split(entry.id).join(entry.fresh.id);
    }
  };

  const visit = (value, seen) => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => { value[index] = mapValue(item, seen); });
      return value;
    }
    // which replaced cards this object names, by a string of its own, and which of its strings were built from a uid and more (an id of a window)
    const named = new Set();
    const builtFromUid = new Set();
    for (const key of Object.keys(value)) {
      if (typeof value[key] !== 'string') continue;
      const entries = namedIn(value[key]);
      for (const entry of entries) named.add(entry);
      if (entries.length > 0 && !byUid.has(value[key])) builtFromUid.add(key);
    }
    for (const key of Object.keys(value)) {
      if (key === 'compiled') continue;
      const mapped = mapValue(value[key], seen);
      const renamed = byUid.has(key) ? byUid.get(key).fresh.uid : key;
      if (renamed !== key) { delete value[key]; value[renamed] = mapped; } else value[key] = mapped;
    }
    if (isCard(value)) return value;
    // a map of labels by uid: the label of a replaced card is the drawn card's
    for (const key of Object.keys(value)) {
      const entry = byFreshUid.get(key);
      if (entry && entry.name && value[key] === entry.name) value[key] = entry.fresh.name;
    }
    if (named.size > 0) swapIn(value, named, builtFromUid);
    return value;
  };
  const mapValue = (item, seen) => {
    if (typeof item === 'string') return mapUid(item);
    // a copy of a replaced card: the drawn card in its place (its zones keep the original objects, which are the drawn cards already)
    if (item !== null && typeof item === 'object' && !Array.isArray(item) && typeof item.uid === 'string' && byUid.has(item.uid) && typeof item.id === 'string') return { ...byUid.get(item.uid).fresh };
    return visit(item, seen);
  };

  visit(state, new Set());
}
