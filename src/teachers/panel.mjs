// Several language models used together: each decision is put to some of them, their answers are read against each other, and a model that fails is replaced by another.
//
//   createPanel(config, { env, fetchImpl }) -> { settings, ask(request, hint, { every }), create() -> a CPU-like teacher, stats, ledger, models }
//
// config (one JSON file, `--llm-config`):
//   { "kind": "llm-panel", "set": "compare-1", "ledgerDir": "...", "responsesDir": "...", "transport": "direct" | "replay" | "dry",
//     "budget": { "maxUsd": 5, "maxCalls": 2000, "perProvider": { "anthropic": 2.5, "gemini": 2.5 } },     the limits of the SET: all of the models together, and each provider
//     "primary": "haiku",                                                  the model whose reason is shown first, and whose answer is played when the answers are split and the lookahead teacher has none
//     "models": { "haiku": { provider, model, pricing, maxTokens, ... }, "sonnet": {...}, "flash": {...}, "argon": {...} },       (src/teachers/llm.mjs settings; a model may repeat
//                                                                           the settings of the panel it sits in, they are the default)
//     "stages": [ { "ask": ["haiku", "flash"] },                           1. the cheap models answer every decision in scope (at the same time)
//                 { "ask": ["sonnet", "argon"], "onlyIfSplit": true } ],   2. the strong ones only when the answers so far are split (or differ from the lookahead teacher's)
//                 a stage may also say "when": { "types": ["install"], "noGain": false } (the kind of move the lookahead teacher chose, as in `scope`)
//     "fallback": { "haiku": ["flash"], "flash": ["haiku"] },              a model that answers with an error of the rate-limit/http/timeout/budget/no-key kind is replaced by the first of these
//     "scope": { "types": ["install", "executeCard"], "noGain": true } }  which decisions are asked at all
//
// The agreement of a decision: "agree" (two or more answers, all the same), "single" (one answer), "split" (answers that differ), "none" (no answer).
// The answer played is the common one when they agree, the lookahead teacher's when they are split and it is among them, else the primary's. A record made from it carries
// src "llm-agree" / "llm-split" / "llm-single" so that `hammer --sources llm-agree:2,llm-split:0` can weigh them.
import { chooser, createLlmTeacher, inScope } from './llm.mjs';
import { openLedger } from './ledger.mjs';
import { keyEnvOf } from './secrets.mjs';
import path from 'node:path';

const REPLACEABLE = new Set(['rate-limit', 'http', 'timeout', 'budget', 'no-key', 'endpoint']);

export function createPanel(config, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!config.models || Object.keys(config.models).length === 0) throw new Error('a panel needs models');
  const set = config.set ?? 'panel';
  const budget = config.budget ?? {};
  let ledger = null;
  if (config.ledgerDir && config.transport !== 'dry' && config.transport !== 'replay') {
    ledger = openLedger(config.ledgerFile ?? path.join(config.ledgerDir, `${set}.jsonl`), { maxUsd: budget.maxUsd ?? Infinity, maxCalls: budget.maxCalls ?? Infinity, maxUsdBy: budget.perProvider ?? {} });
  }
  const defaults = { transport: config.transport, responsesDir: config.responsesDir, set, concurrency: config.concurrency, retries: config.retries };
  for (const key of Object.keys(defaults)) if (defaults[key] === undefined) delete defaults[key];
  const teachers = {};
  for (const [name, model] of Object.entries(config.models)) {
    const settings = { ...defaults, label: name, ...model, ledgerFile: undefined, maxUsd: Infinity, maxCalls: Infinity };
    keyEnvOf(settings.provider ?? 'anthropic', settings.keyEnv);
    teachers[name] = createLlmTeacher(settings, { env, fetchImpl, ledger });
  }
  const names = Object.keys(teachers);
  const primary = config.primary && teachers[config.primary] ? config.primary : names[0];
  const stages = config.stages ?? [{ ask: names }];
  for (const stage of stages) for (const name of stage.ask) if (!teachers[name]) throw new Error(`stage asks ${name}, not a model of the panel`);
  const fallback = config.fallback ?? {};
  const stats = { decisions: 0, byAgreement: { agree: 0, single: 0, split: 0, none: 0 }, replaced: 0, outOfScope: 0 };

  // the valid choices of an answers table, and how they agree
  const choicesOf = (answers) => Object.values(answers).filter((a) => a.choice).map((a) => a.choice);
  const agreementOf = (answers) => {
    const ns = choicesOf(answers);
    if (ns.length === 0) return 'none';
    if (new Set(ns).size > 1) return 'split';
    return ns.length >= 2 ? 'agree' : 'single';
  };

  // request -> { choice, reason, error, agreement, answers: { name: answer (+ via) }, usd, ... } in the shape of one model's answer, so the harness reads it the same way
  async function ask(request, hint = null, { every = false } = {}) {
    stats.decisions += 1;
    const answers = {}; const asked = new Set();
    const askModel = async (name) => {
      asked.add(name);
      let answer = await teachers[name].ask(request);
      if (answer.error && REPLACEABLE.has(answer.error.kind)) {
        for (const other of fallback[name] ?? []) {
          if (asked.has(other) || !teachers[other]) continue;
          asked.add(other);
          const second = await teachers[other].ask(request);
          if (!second.error) { stats.replaced += 1; answer = { ...second, via: other, replaced: { model: name, error: answer.error.kind } }; break; }
        }
      }
      answers[name] = answer;
    };
    const lt = hint?.type ?? null; const lw = hint?.why ?? null;
    for (const stage of every ? [{ ask: names }] : stages) {
      if (stage.when && !inScope(stage.when, lt, lw)) continue;
      if (stage.onlyIfSplit) {
        const ns = choicesOf(answers);
        const split = new Set(ns).size > 1 || (hint?.n && ns.some((n) => n !== hint.n));
        if (!split) continue;
      }
      await Promise.all(stage.ask.filter((name) => !asked.has(name)).map(askModel));
    }
    const agreement = agreementOf(answers);
    stats.byAgreement[agreement] += 1;
    const ns = choicesOf(answers);
    let choice = null;
    if (agreement === 'agree' || agreement === 'single') choice = ns[0];
    else if (agreement === 'split') choice = hint?.n && ns.includes(hint.n) ? hint.n : (answers[primary]?.choice ?? ns[0]);
    const lead = answers[primary]?.choice ? answers[primary] : Object.values(answers).find((a) => a.choice) ?? Object.values(answers)[0] ?? {};
    const failed = Object.values(answers).filter((a) => a.error);
    return {
      id: request.id, model: 'panel', choice, reason: lead.reason ?? '', agreement, answers,
      error: choice === null ? (failed[0]?.error ?? { kind: 'none', message: 'no model answered' }) : null,
      usd: Object.values(answers).reduce((s, a) => s + (a.usd ?? 0), 0), cached: Object.values(answers).length > 0 && Object.values(answers).every((a) => a.cached), promptHash: lead.promptHash,
      latencyMs: Math.max(0, ...Object.values(answers).map((a) => a.latencyMs ?? 0))
    };
  }

  const srcOf = (answer) => (answer?.agreement ? `llm-${answer.agreement}` : 'llm');
  const settings = { kind: 'llm-panel', set, scope: config.scope ?? null, transport: config.transport ?? 'dry', models: names, primary };
  return {
    settings, ask, models: teachers, ledger, panelStats: stats, names, primary,
    create() { return chooser((request, hint) => ask(request, hint), srcOf); },
    get stats() {
      const sum = (key) => Object.values(teachers).reduce((s, t) => s + (t.stats[key] ?? 0), 0);
      const errors = {}; for (const t of Object.values(teachers)) for (const [k, v] of Object.entries(t.stats.errors)) errors[k] = (errors[k] ?? 0) + v;
      return { ...stats, calls: sum('calls'), cached: sum('cached'), promptChars: sum('promptChars'), estimatedInputTokens: sum('estimatedInputTokens'), maxUsd: sum('maxUsd'), usd: sum('usd'), retried: sum('retried'), errors,
        stopped: Object.values(teachers).some((t) => t.stats.stopped) ? 'budget' : null,
        byModel: Object.fromEntries(Object.entries(teachers).map(([name, t]) => [name, { provider: t.settings.provider, model: t.settings.model, ...t.stats }])) };
    }
  };
}
