// A teacher that is a language model: it is asked what to play in a decision and answers with a number and a reason.
//
//   createLlmTeacher(settings)  ->  { create() -> a CPU-like teacher (choose(view), lastDecision), stats }
//
// The decision is written out (src/teachers/prompt.mjs; from the seat's query alone, so nothing hidden is in it), sent through a transport, and the answer is read back:
//   direct   one call to the API for each decision, a few at a time (settings.concurrency)
//   replay   no call: the answer is the one recorded earlier for the same prompt (src/teachers/ cache folder `responses`); a prompt that was never answered is an error
//   dry      no call: counts the calls, the characters and the most they could cost (to see the price before paying it)
// An answer asked for once is kept in the responses folder under the hash of (model, parameters, prompt); asking again for the same prompt costs nothing and gives the same answer.
// The ledger (src/teachers/ledger.mjs) keeps a run under settings.maxUsd / maxCalls: when the next call could pass the limit it is not made (error kind "budget").
//
// settings: { transport: "direct"|"replay"|"dry", model, maxTokens, temperature, concurrency, maxUsd, maxCalls, pricePerMTok: { input, output, cacheRead?, cacheWrite? },
//             responsesDir, ledgerFile, timeoutMs, endpoint, version }      (the API key is not a setting: src/teachers/secrets.mjs)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildCandidates, completeCandidate } from '../../cpus/learned/candidates.mjs';
import { buildPrompt, PROMPT_VERSION } from './prompt.mjs';
import { maxCostOf, openLedger, priceOf } from './ledger.mjs';
import { readApiKey, redact } from './secrets.mjs';

const hashOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// the choice and the reason out of the text the model wrote: {"choice": n, "reason": "..."} (the first JSON object in the text)
export function parseAnswer(text, nCandidates) {
  const match = /\{[\s\S]*\}/.exec(String(text ?? ''));
  if (!match) return { choice: null, reason: '', error: { kind: 'parse', message: 'no JSON object in the answer' } };
  let data; try { data = JSON.parse(match[0]); } catch { return { choice: null, reason: '', error: { kind: 'parse', message: 'the JSON does not parse' } }; }
  const choice = Number(data.choice);
  if (!Number.isInteger(choice) || choice < 1 || choice > nCandidates) return { choice: null, reason: String(data.reason ?? ''), error: { kind: 'invalid-choice', message: `choice ${JSON.stringify(data.choice)} is not in 1..${nCandidates}` } };
  return { choice, reason: String(data.reason ?? '') };
}

export function createLlmTeacher(settings, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const s = { transport: 'dry', model: 'claude-haiku-5-5', maxTokens: 300, temperature: 0, concurrency: 4, maxUsd: Infinity, maxCalls: Infinity, pricePerMTok: { input: 0, output: 0 }, timeoutMs: 60000,
    endpoint: 'https://api.anthropic.com/v1/messages', version: '2023-06-01', ...settings };
  const params = { model: s.model, max_tokens: s.maxTokens, temperature: s.temperature };
  const stats = { decisions: 0, calls: 0, cached: 0, errors: {}, promptChars: 0, estimatedInputTokens: 0, maxUsd: 0, usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, stopped: null };
  const ledger = s.ledgerFile ? openLedger(s.ledgerFile, { maxUsd: s.maxUsd, maxCalls: s.maxCalls }) : null;
  if (s.responsesDir) mkdirSync(s.responsesDir, { recursive: true });
  let inFlight = 0; const waiting = [];
  const slot = async () => { if (inFlight >= s.concurrency) await new Promise((resolve) => waiting.push(resolve)); inFlight += 1; };
  const release = () => { inFlight -= 1; waiting.shift()?.(); };
  const cacheFile = (key) => (s.responsesDir ? path.join(s.responsesDir, `${key}.json`) : null);

  async function callApi(request) {
    const apiKey = readApiKey(env);
    if (!apiKey) return { error: { kind: 'no-key', message: 'no API key in the environment (FORGE_LLM_API_KEY / ANTHROPIC_API_KEY)' } };
    const started = Date.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), s.timeoutMs);
    try {
      const response = await fetchImpl(s.endpoint, { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': s.version },
        body: JSON.stringify({ ...params, system: request.prompt.system, messages: [{ role: 'user', content: request.prompt.user }] }) });
      const body = await response.text();
      if (!response.ok) return { error: { kind: 'http', message: redact(`HTTP ${response.status}: ${body.slice(0, 300)}`, env) }, latencyMs: Date.now() - started };
      const data = JSON.parse(body);
      const text = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      return { raw: text, usage: data.usage ?? {}, latencyMs: Date.now() - started, stopReason: data.stop_reason ?? null };
    } catch (error) {
      return { error: { kind: error?.name === 'AbortError' ? 'timeout' : 'http', message: redact(String(error?.message ?? error), env) }, latencyMs: Date.now() - started };
    } finally { clearTimeout(timer); }
  }

  // request -> DecisionAnswer: { id, choice, reason, raw, model, params, usage, usd, latencyMs, cached, error }
  async function ask(request) {
    const key = hashOf({ params, system: request.prompt.system, user: request.prompt.user });
    const file = cacheFile(key);
    stats.decisions += 1; stats.promptChars += request.prompt.system.length + request.prompt.user.length;
    const estimate = maxCostOf(request.prompt.system.length + request.prompt.user.length, s.maxTokens, s.pricePerMTok, 1.5);
    stats.estimatedInputTokens += Math.ceil((request.prompt.system.length + request.prompt.user.length) / 2); stats.maxUsd += estimate;
    const base = { id: request.id, model: s.model, params, promptHash: key };
    if (file && existsSync(file)) {
      stats.cached += 1; const saved = JSON.parse(readFileSync(file, 'utf8'));
      return { ...base, ...parseAnswer(saved.raw, request.candidates.length), raw: saved.raw, usage: saved.usage, usd: 0, latencyMs: saved.latencyMs, cached: true };
    }
    if (s.transport === 'replay') { stats.errors['replay-miss'] = (stats.errors['replay-miss'] ?? 0) + 1; return { ...base, choice: null, error: { kind: 'replay-miss', message: 'no recorded answer for this prompt' } }; }
    if (s.transport === 'dry') { stats.errors['dry-run'] = (stats.errors['dry-run'] ?? 0) + 1; return { ...base, choice: null, error: { kind: 'dry-run', message: 'no call is made' } }; }
    if (ledger) { const ok = ledger.canSpend(estimate); if (!ok.ok) { stats.stopped = 'budget'; stats.errors.budget = (stats.errors.budget ?? 0) + 1; return { ...base, choice: null, error: { kind: 'budget', message: ok.reason } }; } }
    await slot();
    let result; try { result = await callApi(request); } finally { release(); }
    stats.calls += 1;
    if (result.error) {
      stats.errors[result.error.kind] = (stats.errors[result.error.kind] ?? 0) + 1;
      ledger?.record({ id: request.id, usd: 0, model: s.model, error: result.error.kind, latencyMs: result.latencyMs });
      return { ...base, choice: null, error: result.error, latencyMs: result.latencyMs };
    }
    const usd = priceOf(result.usage, s.pricePerMTok);
    stats.usd += usd; stats.usage.input_tokens += result.usage.input_tokens ?? 0; stats.usage.output_tokens += result.usage.output_tokens ?? 0;
    ledger?.record({ id: request.id, usd, model: s.model, usage: result.usage, latencyMs: result.latencyMs });
    if (file) writeFileSync(file, JSON.stringify({ raw: result.raw, usage: result.usage, latencyMs: result.latencyMs, model: s.model, params, at: new Date().toISOString() }));
    const parsed = parseAnswer(result.raw, request.candidates.length);
    if (parsed.error) stats.errors[parsed.error.kind] = (stats.errors[parsed.error.kind] ?? 0) + 1;
    return { ...base, ...parsed, raw: result.raw, usage: result.usage, usd, latencyMs: result.latencyMs, cached: false };
  }

  // a CPU-like teacher for the harness (--shadow llm): the decision is asked, the chosen candidate is made into an action
  function create() {
    return {
      src: 'llm', lastDecision: null,
      async choose(view) {
        this.lastDecision = null;
        // before the first turn (keep the hand or draw again) is not a decision of play: the game's own CPU answers it, no call is made
        if (view.query.legalActions.some((e) => e.kind === 'fixed' && ['keepOpeningHand', 'openingMulligan'].includes(e.action?.type)) || view.query.legalActions.some((e) => e.actionType === 'openingMulligan')) { this.lastDecision = { kind: 'baseline', why: 'opening' }; return view.baseline(); }
        const built = buildCandidates(view.query, view.queryAction);
        if (built.cands.length < 2) { this.lastDecision = { kind: 'baseline', why: 'no-choice' }; return view.baseline(); }
        const prompt = buildPrompt(view.query, built.cands);
        const request = { id: `${view.seatId}|${view.query.status.revision}`, prompt: { system: prompt.system, user: prompt.user }, candidates: prompt.candidates, meta: { promptVersion: PROMPT_VERSION } };
        const answer = await ask(request);
        this.llm = { request, answer, built };
        if (answer.choice === null) { this.lastDecision = { kind: 'baseline', why: `llm-${answer.error?.kind ?? 'none'}`, llm: answer }; return view.baseline(); }
        const action = completeCandidate(view.query, built.cands[answer.choice - 1], view.queryAction);
        if (!action) { this.lastDecision = { kind: 'baseline', why: 'llm-plan-refused', llm: answer }; return view.baseline(); }
        this.lastDecision = { kind: 'llm', why: 'llm', moveId: null, gains: null, llm: answer };
        return { ok: true, value: { commandId: view.commandId, expectedRevision: view.query.status.revision, action } };
      }
    };
  }
  return { settings: s, ask, create, stats, ledger };
}

// the price of a run before paying it: from the stats of a dry run (settings.pricePerMTok given)
export function estimateRun(stats, pricePerMTok, outputTokensPerDecision = 100) {
  const input = stats.estimatedInputTokens; const output = stats.decisions * outputTokensPerDecision;
  return { decisions: stats.decisions, inputTokens: input, outputTokens: output, usd: (input * pricePerMTok.input + output * pricePerMTok.output) / 1e6, maxUsd: stats.maxUsd };
}
