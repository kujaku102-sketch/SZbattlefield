// FROZEN COPY for controlZIG gen3 (cpus/release/gen3/controlZIG.mjs): cpus/learned/mlp.mjs at commit 0292aef. Do not edit and do not follow changes elsewhere: controlZIG gen3 must play the same for ever.
// The forward pass of the small network that forgehammer learns (packages/forge/src/mlp.mjs; the same arithmetic, kept in step by hand and checked by a test that compares them):
//
//   z(candidate, state) = base . phi + v . relu(W1 . phi + U1 . s + b1) + lin . phi      (base: a linear scorer held fixed, when the network is a correction of it)
//
// netFromWeights(weights) -> net;  baseOf(net, state) -> the part of the hidden layer that is the same for every candidate of the decision;  scoreCandidate(net, base, phi) -> z
export const netFromWeights = (w) => ({ F: w.F, S: w.S, H: w.H, baseW: w.base ? Float64Array.from(w.base) : null, W1: Float64Array.from(w.W1), U1: Float64Array.from(w.U1), b1: Float64Array.from(w.b1), v: Float64Array.from(w.v), lin: Float64Array.from(w.lin) });

export function baseOf(net, state) {
  const { S, H, U1, b1 } = net; const base = Float64Array.from(b1);
  for (let j = 0; j < S; j += 1) { const s = state[j]; if (s === 0) continue; for (let h = 0; h < H; h += 1) base[h] += s * U1[j * H + h]; }
  return base;
}

export function scoreCandidate(net, base, phi) {
  const { F, H, W1, v, lin, baseW } = net; let z = 0; const a = Float64Array.from(base);
  for (let f = 0; f < F; f += 1) { const x = phi[f]; if (x === 0) continue; z += lin[f] * x; if (baseW) z += baseW[f] * x; const row = f * H; for (let h = 0; h < H; h += 1) a[h] += x * W1[row + h]; }
  for (let h = 0; h < H; h += 1) if (a[h] > 0) z += v[h] * a[h];
  return z;
}
