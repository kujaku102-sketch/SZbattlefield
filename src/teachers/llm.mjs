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
// pricing: { label, rows: [{ from: "2026-11-08", input, output, note }, { from: "2026-12-01", ... }] } dollars per million tokens, the row in force on the day of the call (the output price
//          counts the model's thinking tokens too); every ledger line says which row it used (priceVersion). `pricePerMTok: { input, output }` is the same for all days.
// retries: how many times a call that was answered 429 (rate limit) or 5xx is made again, after waiting (the Retry-After of the answer, else 2, 4, 8, 16 s ...); such a call costs nothing and is not in the ledger
// thinkingBudget (gemini): thinking tokens the model may spend before it answers; they are part of maxTokens
// effort, thinking (anthropic): sent as output_config.effort and thinking. The Claude 5 models think by default and the thinking tokens come out of maxTokens: an answer cut off
//          before its text has the kind "parse" (and an empty text is not kept in the responses folder). Give maxTokens room, and lower the effort.
// provider: "anthropic" (default) or "gemini": the same prompt, the answer read the same; only the request and the reading of the reply differ (below). The key is FORGE_LLM_API_KEY for both.
// set: the name of one run of a set of questions; the ledger of the set is ledgerDir/<set>.jsonl, and maxUsd / maxCalls count that file only, so every set has its own limit
// scope: { types: ["install", "executeCard"], noGain: true } which decisions the harness asks about at all (see inScope)
//
// settings: { transport: "direct"|"replay"|"dry", model, maxTokens, temperature, concurrency, maxUsd, maxCalls, pricePerMTok: { input, output, cacheRead?, cacheWrite? },
//             responsesDir, ledgerFile, timeoutMs, endpoint, version }      (the API key is not a setting: src/teachers/secrets.mjs; FORGE_ANTHROPIC_API_KEY for anthropic, GEMINI_API_KEY for gemini, nothing else)
// The address to send to is `endpoint` of the settings (the official API by default) and nothing else: no SDK, no environment variable or profile is looked at for it, and
// every call written in the ledger carries the host it went to. An address that is not https is refused.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildCandidates, completeCandidate } from '../../cpus/learned/candidates.mjs';
import { buildPrompt, PROMPT_VERSION } from './prompt.mjs';
import { maxCostOf, openLedger, priceOf } from './ledger.mjs';
import { keyEnvOf, readApiKey, redact } from './secrets.mjs';
import { actionSignature } from '../../cpus/learned/candidates.mjs';

// the system text of an Anthropic request: the short system prompt, then the rules and the public card pool (and the seat's own list) when there are any; the blocks marked `cache` end a part the API keeps between calls
const systemBlocks = (prompt) => (prompt.context?.blocks?.length
  ? [{ type: 'text', text: prompt.system }, ...prompt.context.blocks.map((b) => ({ type: 'text', text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' } } : {}) }))]
  : prompt.system);
// the characters of a prompt, the context too
const charsOf = (prompt) => prompt.system.length + prompt.user.length + (prompt.context?.chars ?? 0);

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

// the decisions worth a question: those where the looking-ahead teacher chose one of `types`, or left the move to the game's own CPU (no gain found, no move it supports)
export function inScope(scope, teacherType, teacherWhy) {
  if (!scope) return true;
  if ((scope.types ?? []).includes(teacherType)) return true;
  return Boolean(scope.noGain) && ['no-gain', 'no-supported-move'].includes(String(teacherWhy ?? '').split(':')[0]);
}

// the row of `pricing` in force on `date` (ISO day)
export function priceAt(pricing, date = new Date()) {
  const day = (date instanceof Date ? date : new Date(date)).toISOString().slice(0, 10);
  const rows = [...pricing.rows].sort((a, b) => String(a.from).localeCompare(String(b.from)));
  let row = null; for (const r of rows) if (r.from <= day) row = r;
  if (!row) throw new Error(`no price in force on ${day} (first row from ${rows[0]?.from})`);
  return { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, version: `${pricing.label ?? 'pricing'} from ${row.from}` };
}

const ENDPOINTS = {
  anthropic: () => 'https://api.anthropic.com/v1/messages',
  gemini: (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
};

// each provider: how the request is made, how the reply is read -> { text, usage: { input_tokens, output_tokens }, stopReason }
const PROVIDERS = {
  anthropic: {
    request: (s, params, prompt, apiKey) => ({ headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': s.version }, body: { ...params, system: systemBlocks(prompt), messages: [{ role: 'user', content: prompt.user }], ...(s.effort ? { output_config: { effort: s.effort } } : {}), ...(s.thinking ? { thinking: s.thinking } : {}) } }),
    read: (data) => ({ text: (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''), usage: data.usage ?? {}, stopReason: data.stop_reason ?? null })
  },
  gemini: {
    request: (s, params, prompt, apiKey) => ({ headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: { systemInstruction: { parts: [{ text: prompt.system }, ...(prompt.context?.blocks ?? []).map((b) => ({ text: b.text }))] }, contents: [{ role: 'user', parts: [{ text: prompt.user }] }], generationConfig: { maxOutputTokens: params.max_tokens, temperature: params.temperature, responseMimeType: 'application/json', ...(s.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: s.thinkingBudget } } : {}) } } }),
    read: (data) => ({ text: (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''), stopReason: data.candidates?.[0]?.finishReason ?? null,
      usage: { input_tokens: data.usageMetadata?.promptTokenCount ?? 0, output_tokens: (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0) } })
  }
};

// `ledger`: a ledger the caller opened and shares between several models (src/teachers/panel.mjs); without it the settings' own ledgerFile is opened
export function createLlmTeacher(settings, { env = process.env, fetchImpl = globalThis.fetch, ledger: sharedLedger = null } = {}) {
  const s = { transport: 'dry', provider: 'anthropic', model: 'claude-haiku-5-5', maxTokens: 300, concurrency: 4, maxUsd: Infinity, maxCalls: Infinity, pricePerMTok: { input: 0, output: 0 }, timeoutMs: 60000, retries: 4,
    version: '2023-06-01', ...settings };
  if (!PROVIDERS[s.provider]) throw new Error(`provider ${s.provider}? one of ${Object.keys(PROVIDERS).join(', ')}`);
  keyEnvOf(s.provider, s.keyEnv);
  s.endpoint ??= ENDPOINTS[s.provider](s.model);
  if (s.set && s.ledgerDir && !s.ledgerFile) s.ledgerFile = path.join(s.ledgerDir, `${s.set}.jsonl`);
  const priceNow = () => (s.pricing ? priceAt(s.pricing) : { ...s.pricePerMTok, version: 'fixed' });
  let endpointHost = null; try { const u = new URL(s.endpoint); endpointHost = u.protocol === 'https:' ? u.host : null; } catch { /* refused below */ }
  const params = { ...(s.provider === 'anthropic' ? {} : { provider: s.provider }), model: s.model, max_tokens: s.maxTokens, temperature: s.temperature };
  const stats = { decisions: 0, calls: 0, cached: 0, errors: {}, promptChars: 0, estimatedInputTokens: 0, maxUsd: 0, usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, stopped: null };
  const ledger = sharedLedger ?? (s.ledgerFile ? openLedger(s.ledgerFile, { maxUsd: s.maxUsd, maxCalls: s.maxCalls }) : null);
  if (s.responsesDir) mkdirSync(s.responsesDir, { recursive: true });
  let inFlight = 0; const waiting = [];
  const slot = async () => { if (inFlight >= s.concurrency) await new Promise((resolve) => waiting.push(resolve)); inFlight += 1; };
  const release = () => { inFlight -= 1; waiting.shift()?.(); };
  const cacheFile = (key) => (s.responsesDir ? path.join(s.responsesDir, `${key}.json`) : null);

  const retryAfterOf = (response) => { const v = Number(response.headers?.get?.('retry-after')); return Number.isFinite(v) && v > 0 ? Math.min(v, 120) * 1000 : null; };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function callApi(request) {
    if (!endpointHost) return { error: { kind: 'endpoint', message: 'the endpoint of the settings is not an https address' } };
    const apiKey = readApiKey(env, s.provider);
    if (!apiKey) return { error: { kind: 'no-key', message: `no API key in the environment (${keyEnvOf(s.provider)})` } };
    const started = Date.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), s.timeoutMs);
    try {
      const made = PROVIDERS[s.provider].request(s, params, request.prompt, apiKey);
      const response = await fetchImpl(s.endpoint, { method: 'POST', signal: controller.signal, headers: made.headers, body: JSON.stringify(made.body) });
      const body = await response.text();
      if (!response.ok) return { error: { kind: response.status === 429 ? 'rate-limit' : 'http', status: response.status, message: redact(`HTTP ${response.status}: ${body.slice(0, 300)}`, env) }, retryAfterMs: retryAfterOf(response), latencyMs: Date.now() - started };
      const data = JSON.parse(body);
      const read = PROVIDERS[s.provider].read(data);
      return { raw: read.text, usage: read.usage, latencyMs: Date.now() - started, stopReason: read.stopReason };
    } catch (error) {
      return { error: { kind: error?.name === 'AbortError' ? 'timeout' : 'http', message: redact(String(error?.message ?? error), env) }, latencyMs: Date.now() - started };
    } finally { clearTimeout(timer); }
  }

  // request -> DecisionAnswer: { id, choice, reason, raw, model, params, usage, usd, latencyMs, cached, error }
  async function ask(request) {
    const key = hashOf({ params, ...(s.effort || s.thinking ? { extra: { effort: s.effort, thinking: s.thinking } } : {}), system: request.prompt.system, ...(request.prompt.context ? { context: request.prompt.context.sha256 } : {}), user: request.prompt.user });
    const file = cacheFile(key);
    stats.decisions += 1; stats.promptChars += charsOf(request.prompt);
    const price = priceNow();
    const estimate = maxCostOf(charsOf(request.prompt), s.maxTokens, price, 1.5);
    stats.estimatedInputTokens += Math.ceil(charsOf(request.prompt) / 2); stats.maxUsd += estimate;
    const base = { id: request.id, model: s.model, params, promptHash: key };
    if (file && existsSync(file)) {
      stats.cached += 1; const saved = JSON.parse(readFileSync(file, 'utf8'));
      return { ...base, ...parseAnswer(saved.raw, request.candidates.length), raw: saved.raw, usage: saved.usage, usd: 0, latencyMs: saved.latencyMs, cached: true };
    }
    if (s.transport === 'replay') { stats.errors['replay-miss'] = (stats.errors['replay-miss'] ?? 0) + 1; return { ...base, choice: null, error: { kind: 'replay-miss', message: 'no recorded answer for this prompt' } }; }
    if (s.transport === 'dry') { stats.errors['dry-run'] = (stats.errors['dry-run'] ?? 0) + 1; return { ...base, choice: null, error: { kind: 'dry-run', message: 'no call is made' } }; }
    if (ledger) { const ok = ledger.canSpend(estimate, s.provider); if (!ok.ok) { stats.stopped = 'budget'; stats.errors.budget = (stats.errors.budget ?? 0) + 1; return { ...base, choice: null, error: { kind: 'budget', message: ok.reason } }; } }
    await slot();
    let result;
    for (let attempt = 0; ; attempt += 1) {
      try { result = await callApi(request); } finally { release(); }
      const again = result.error && (result.error.kind === 'rate-limit' || (result.error.status >= 500 && result.error.status < 600)) && attempt < s.retries;
      if (!again) break;
      stats.retried = (stats.retried ?? 0) + 1;
      await sleep(result.retryAfterMs ?? 2000 * 2 ** attempt);
      await slot();
    }
    stats.calls += 1;
    if (result.error) {
      stats.errors[result.error.kind] = (stats.errors[result.error.kind] ?? 0) + 1;
      ledger?.record({ id: request.id, usd: 0, model: s.model, provider: s.provider, set: s.set ?? null, endpoint: endpointHost, priceVersion: price.version, ...(result.error.status ? { status: result.error.status } : {}), error: result.error.kind, latencyMs: result.latencyMs });
      return { ...base, choice: null, error: result.error, latencyMs: result.latencyMs };
    }
    const usd = priceOf(result.usage, price);
    stats.usd += usd; stats.usage.input_tokens += result.usage.input_tokens ?? 0; stats.usage.output_tokens += result.usage.output_tokens ?? 0;
    ledger?.record({ id: request.id, usd, model: s.model, provider: s.provider, set: s.set ?? null, endpoint: endpointHost, priceVersion: price.version, usage: result.usage, latencyMs: result.latencyMs });
    if (file && result.raw) writeFileSync(file, JSON.stringify({ raw: result.raw, usage: result.usage, latencyMs: result.latencyMs, model: s.model, params, at: new Date().toISOString() }));
    const parsed = parseAnswer(result.raw, request.candidates.length);
    if (parsed.error) stats.errors[parsed.error.kind] = (stats.errors[parsed.error.kind] ?? 0) + 1;
    return { ...base, ...parsed, raw: result.raw, usage: result.usage, usd, latencyMs: result.latencyMs, cached: false };
  }

  function create() { return chooser((request) => ask(request)); }
  return { settings: s, ask, create, stats, ledger, endpointHost };
}

// a CPU-like teacher for the harness (--shadow llm): the decision is asked, the chosen candidate is made into an action.
//   askDecision(request, hint) -> a DecisionAnswer ({ choice, reason, error, ... }); hint: what the looking-ahead teacher chose on the same decision ({ action, type, why, n }), when there is one
//   srcOf(answer) -> the `src` the record of the decision is given (hammer --sources weighs records by it)
export function chooser(askDecision, srcOf = () => 'llm') {
    return {
      get src() { return srcOf(this.lastDecision?.llm ?? null); },
      lastDecision: null,
      async choose(view) {
        this.lastDecision = null;
        // before the first turn (keep the hand or draw again) is not a decision of play: the game's own CPU answers it, no call is made
        if (view.query.legalActions.some((e) => e.kind === 'fixed' && ['keepOpeningHand', 'openingMulligan'].includes(e.action?.type)) || view.query.legalActions.some((e) => e.actionType === 'openingMulligan')) { this.lastDecision = { kind: 'baseline', why: 'opening' }; return view.baseline(); }
        const built = buildCandidates(view.query, view.queryAction);
        if (built.cands.length < 2) { this.lastDecision = { kind: 'baseline', why: 'no-choice' }; return view.baseline(); }
        const prompt = buildPrompt(view.query, built.cands, { context: view.context ?? null });
        const request = { id: `${view.seatId}|${view.query.status.revision}`, prompt: { system: prompt.system, context: prompt.context, user: prompt.user }, candidates: prompt.candidates, meta: { promptVersion: PROMPT_VERSION } };
        const hint = view.hint ? { ...view.hint, n: view.hint.action ? built.cands.findIndex((c) => c.sig === actionSignature(view.hint.action)) + 1 || null : null } : null;
        const answer = await askDecision(request, hint);
        this.llm = { request, answer, built };
        if (answer.choice === null) { this.lastDecision = { kind: 'baseline', why: `llm-${answer.error?.kind ?? 'none'}`, llm: answer }; return view.baseline(); }
        const action = completeCandidate(view.query, built.cands[answer.choice - 1], view.queryAction);
        if (!action) { this.lastDecision = { kind: 'baseline', why: 'llm-plan-refused', llm: answer }; return view.baseline(); }
        this.lastDecision = { kind: 'llm', why: 'llm', moveId: null, gains: null, llm: answer };
        return { ok: true, value: { commandId: view.commandId, expectedRevision: view.query.status.revision, action } };
      }
    };
}

// the price of a run before paying it: from the stats of a dry run (settings.pricePerMTok given)
// (the most a decision can cost is counted by the ledger from maxTokens, which holds the thinking tokens too: stats.maxUsd is for the price in force today)
export function estimateRun(stats, price, outputTokensPerDecision = 100) {
  const input = stats.estimatedInputTokens; const output = stats.decisions * outputTokensPerDecision;
  const rows = price?.rows ? price.rows.map((r) => ({ ...r })) : [{ from: 'fixed', ...price }];
  const cost = (r) => (input * r.input + output * r.output) / 1e6;
  return { decisions: stats.decisions, inputTokens: input, outputTokens: output, expectedUsdByPrice: rows.map((r) => ({ from: r.from, usd: cost(r) })), maxUsdToday: stats.maxUsd };
}
