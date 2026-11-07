// What an LLM run has spent: an append-only ledger (one JSON line per call) and the check that keeps a run under its limit.
//   const ledger = openLedger(file, { maxUsd, maxCalls })      the file is read when opened: a run that continues counts what is already spent
//   ledger.canSpend(estimateUsd)  -> { ok, reason }              asked before a call, with the most the call can cost
//   ledger.record({ id, usd, usage, model, latencyMs, error })   written after
//   ledger.stopped                                                "budget" once a call was refused for the limit
// Prices are not known here: they are given in the settings (pricePerMTok: { input, output, cacheRead, cacheWrite }, dollars per million tokens).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function priceOf(usage, price) {
  const per = (n, p) => (Number(n ?? 0) * Number(p ?? 0)) / 1e6;
  return per(usage?.input_tokens, price.input) + per(usage?.output_tokens, price.output) + per(usage?.cache_read_input_tokens, price.cacheRead ?? price.input) + per(usage?.cache_creation_input_tokens, price.cacheWrite ?? price.input);
}

// the most one call can cost: all of the input tokens estimated from the characters, and max_tokens of output
export function maxCostOf(promptChars, maxTokens, price, charsPerToken = 2) {
  return (promptChars / charsPerToken) * Number(price.input) / 1e6 + Number(maxTokens) * Number(price.output) / 1e6;
}

export function openLedger(file, { maxUsd = Infinity, maxCalls = Infinity } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  let usd = 0; let calls = 0;
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n')) { if (!line.trim()) continue; try { const r = JSON.parse(line); usd += Number(r.usd ?? 0); calls += 1; } catch { /* a cut line */ } }
  const ledger = {
    stopped: null,
    get usd() { return usd; }, get calls() { return calls; },
    canSpend(estimateUsd) {
      if (calls + 1 > maxCalls) { ledger.stopped = 'budget'; return { ok: false, reason: `calls ${calls} would pass the limit ${maxCalls}` }; }
      if (usd + estimateUsd > maxUsd) { ledger.stopped = 'budget'; return { ok: false, reason: `spent $${usd.toFixed(4)} + at most $${estimateUsd.toFixed(4)} would pass the limit $${maxUsd}` }; }
      return { ok: true };
    },
    record(row) { usd += Number(row.usd ?? 0); calls += 1; appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`); }
  };
  return ledger;
}
