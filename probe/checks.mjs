// Checks of a determinized state against the real one. They read the real hidden cards: they belong to the probes, never to a CPU
// or to the state building (src/sim.mjs), which must not read them.

const count = (list) => list.reduce((m, id) => ({ ...m, [id]: (m[id] ?? 0) + 1 }), {});

// det = what sim.determinize returned. Is the pool the multiset of the real hidden cards of that owner, and did no real hidden card
// object survive into the determinized state?
export function poolCheck(sim, engine, viewerPlayer, det) {
  const check = { poolMatches: true, mismatches: [], leaked: 0, slotCount: 0, poolCount: 0 };
  for (const { player, pool, slots } of det.plan) {
    const real = engine.players[player];
    const hiddenReal = sim.hiddenSlots(engine, viewerPlayer, player).map(({ zone, index }) => real[zone][index].id);
    check.slotCount += slots.length; check.poolCount += pool.length;
    if ([...pool].sort().join(',') !== [...hiddenReal].sort().join(',')) {
      check.poolMatches = false;
      const p = count(pool); const h = count(hiddenReal); const diff = {};
      for (const id of new Set([...Object.keys(p), ...Object.keys(h)])) if ((p[id] ?? 0) !== (h[id] ?? 0)) diff[id] = (p[id] ?? 0) - (h[id] ?? 0);
      check.mismatches.push({ player, pool: pool.length, hidden: hiddenReal.length, diff });
    }
    const realUids = new Set(sim.hiddenSlots(engine, viewerPlayer, player).map(({ zone, index }) => real[zone][index].uid));
    const copy = det.state.players[player];
    for (const { zone, index } of sim.hiddenSlots(det.state, viewerPlayer, player)) if (realUids.has(copy[zone][index].uid)) check.leaked += 1;
  }
  return check;
}
