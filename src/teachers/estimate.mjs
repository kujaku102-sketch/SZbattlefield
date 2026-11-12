// What a run of the language model teacher is expected to cost, before it starts (src/run.mjs prints this and asks for --yes when it is more than half of what the set may still spend).
//
//   estimateLlmRun(config, matches, { callsPerMatch }) -> { calls, expectedUsd, maxUsd, limitUsd, spentUsd, remainingUsd, models: [...] }
// config: a single model's settings, or a panel (src/teachers/panel.mjs). A call is counted for every model of the config (the worst case: every stage is asked);
// tokens: about 1800 in and `expectedOutputTokens` out (the thinking tokens too); the most is `maxTokens` out. `callsPerMatch` (config.callsPerMatch, else 26) is what a match with the
// scope of "install / executeCard / left to the game's CPU" asked for in the first real runs.
import { priceAt } from './llm.mjs';
import { priorSpend } from './ledger.mjs';

// The rules and the public card pool (src/teachers/context.mjs, about 62,000 characters, `contextTokens` here) are sent with every decision and kept by the API between calls: the expected cost counts them at the
// cache-read price (price.cacheRead, else the input price), the most at the cache-write price (price.cacheWrite, else the input price), as if no call found them kept.
export function estimateLlmRun(config, matches, { callsPerMatch = config.callsPerMatch ?? 26, inputTokens = 1800, contextTokens = config.contextTokens ?? 45000 } = {}) {
  const models = config.models ? Object.entries(config.models).map(([name, m]) => ({ name, ...m })) : [{ name: config.label ?? config.model, ...config }];
  const calls = Math.round(matches * callsPerMatch);
  let expected = 0; let most = 0; const rows = [];
  for (const m of models) {
    const price = m.pricing ? priceAt(m.pricing) : (m.pricePerMTok ?? { input: 0, output: 0 });
    const perCall = (inputTokens * price.input + contextTokens * (price.cacheRead ?? price.input) + (m.expectedOutputTokens ?? 100) * price.output) / 1e6;
    const perCallMax = (inputTokens * 1.5 * price.input + contextTokens * 1.5 * (price.cacheWrite ?? price.input) + (m.maxTokens ?? 300) * price.output) / 1e6;
    expected += perCall * calls; most += perCallMax * calls;
    rows.push({ model: m.model, provider: m.provider ?? 'anthropic', calls, expectedUsd: perCall * calls, maxUsd: perCallMax * calls });
  }
  const limit = config.budget?.maxUsd ?? config.maxUsd ?? Infinity;
  const ledgerDir = config.ledgerDir; const set = config.set;
  const spent = ledgerDir && set ? priorSpend(ledgerDir, set).usd : 0;
  return { calls, expectedUsd: expected, maxUsd: most, limitUsd: limit, spentUsd: spent, remainingUsd: limit - spent, models: rows };
}
