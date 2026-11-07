// The table of matches and how it is split. Pure: no game, no clock, no machine. The same arguments give the same jobs in the
// same order on every machine, and a job's shard depends only on its place in the full table.
//
// A table is described by { cpuA, cpuB, swap, decks, seeds }. A CPU is a spec string: a name or path, optionally followed by
// `?key=value&key=value` (parameters handed to the CPU; stage 2 uses them for weights).

export function buildJobs({ cpuA, cpuB, swap = false, decks, seeds }) {
  const jobs = [];
  const cpuPairs = swap ? [[cpuA, cpuB], [cpuB, cpuA]] : [[cpuA, cpuB]];
  for (const [seatACpu, seatBCpu] of cpuPairs) {
    for (const deckA of decks) for (const deckB of decks) for (const seed of seeds) {
      jobs.push({ id: `${seatACpu}.${seatBCpu}/${deckA}/${deckB}/${seed}`, seed, deckA, deckB, cpus: { 'seat-a': seatACpu, 'seat-b': seatBCpu } });
    }
  }
  return jobs;
}

// "2/4" = the second of four shards (1-based). Match number k of the full table (0-based) belongs to shard (k mod n) + 1:
// every shard gets every n-th match, so the long and short matches spread evenly, and no match is in two shards.
export function parseShard(text) {
  const m = /^(\d+)\/(\d+)$/.exec(String(text));
  if (!m) throw new Error(`--shard wants i/n (for example 2/4), got ${text}`);
  const index = Number(m[1]); const count = Number(m[2]);
  if (count < 1 || index < 1 || index > count) throw new Error(`--shard ${text}: i must be 1..n`);
  return { index, count };
}

export function inShard(position, shard) { return position % shard.count === shard.index - 1; }

export function shardOfPosition(position, count) { return (position % count) + 1; }

// What makes two tables the same table (a merge refuses to join different tables).
export function tableKey({ cpuA, cpuB, swap, decks, seeds }) {
  return JSON.stringify({ cpuA, cpuB, swap: Boolean(swap), decks, seeds });
}
