#!/usr/bin/env node
// The same decisions put to several language models, to read their answers next to the looking-ahead teacher's (and next to each other).
//
//   node src/llm-compare.mjs --text <dir of text logs> [--text <dir>] --n 100 --seed 1 --panel <panel.json> --out <dir> [--dry]
//   node src/llm-compare.mjs --text <dir> --n 100 --config <settings.json> [--config <settings.json> ...] --out <dir> [--dry]      (models given one by one, without a shared limit)
//
// --text    text logs of a run (--record-text, with --shadow llm --shadow-compare lookahead; a dry run is enough): the prompts and the looking-ahead teacher's answers are there
// --n       how many decisions (chosen the same way every time from --seed: the ones with an answer of the teacher, sorted by a hash of their id)
// --panel   the settings of a panel (src/teachers/panel.mjs): every model of it answers every decision, whatever its stages say; the limits of the set hold for all of them
// --out     writes text-compare.jsonl.gz here (the same format as the text logs, so `forge audit build <out>` shows it: the models side by side, the disagreements apart)
//           and compare.json (agreements, errors, what it cost, in all and for each provider)
// --dry     no call is made whatever the settings say: the number of calls and what they could cost are written
//
// The keys are read from the environment by src/teachers/secrets.mjs and nowhere else (FORGE_ANTHROPIC_API_KEY, GEMINI_API_KEY).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { constants, gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { createLlmTeacher, estimateRun } from './teachers/llm.mjs';
import { createPanel } from './teachers/panel.mjs';

const args = {}; const lists = { text: [], config: [] };
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const name = a.slice(2); const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[name] = true; else { if (lists[name]) lists[name].push(next); else args[name] = next; i += 1; }
}
if (lists.text.length === 0 || (lists.config.length === 0 && typeof args.panel !== 'string') || typeof args.out !== 'string') { console.error('usage: llm-compare.mjs --text <dir> --n 100 --seed 1 (--panel <panel.json> | --config <settings.json> ...) --out <dir> [--dry]'); process.exit(2); }

const gunzip = (buffer) => { try { return gunzipSync(buffer).toString('utf8'); } catch { return gunzipSync(buffer, { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8'); } };
const files = lists.text.flatMap((input) => (statSync(input).isDirectory() ? readdirSync(input).sort().filter((n) => /^text-.*\.jsonl\.gz$/.test(n)).map((n) => path.join(input, n)) : [input]));
let header = null; const matches = new Map();
for (const file of files) {
  let block = [];
  for (const line of gunzip(readFileSync(file)).split('\n')) {
    if (!line) continue;
    let row; try { row = JSON.parse(line); } catch { block = []; continue; }
    if (row.kind === 'forge-text') { header ??= row; continue; }
    if (row.match === true) { if (!matches.has(row.job)) matches.set(row.job, { match: row, decisions: block }); block = []; continue; }
    block.push(row);
  }
}
if (header === null) throw new Error('no forge-text header');
const pool = [];
for (const [job, { match, decisions }] of matches) for (const d of decisions) if (d.answers?.teacher?.n && d.candidates?.length >= 2) pool.push({ job, match, d });
const seed = String(args.seed ?? 1);
pool.sort((x, y) => createHash('sha256').update(`${seed}|${x.d.id}`).digest('hex').localeCompare(createHash('sha256').update(`${seed}|${y.d.id}`).digest('hex')));
const chosen = pool.slice(0, Number(args.n ?? 100));
console.log(`${files.length} files, ${matches.size} matches, ${pool.length} decisions with the teacher's answer; ${chosen.length} chosen (seed ${seed})`);

// the models: { label, ask(request, hint) -> { choice, reason, error, ... }, stats, settings }
let panel = null; let models;
if (typeof args.panel === 'string') {
  const config = JSON.parse(readFileSync(args.panel, 'utf8'));
  if (args.dry) config.transport = 'dry';
  panel = createPanel(config);
  models = panel.names.map((name) => ({ label: name, teacher: panel.models[name], settings: panel.models[name].settings }));
} else {
  models = lists.config.map((file) => {
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    if (args.dry) settings.transport = 'dry';
    const teacher = createLlmTeacher(settings);
    return { label: settings.label ?? settings.model, teacher, settings };
  });
}
const answers = new Map();   // decision id -> { label -> answer }
await Promise.all(chosen.map(async ({ d }) => {
  const request = { id: d.id, prompt: { system: header.system, user: d.prompt }, candidates: d.candidates };
  const result = {};
  if (panel) {
    const all = await panel.ask(request, { n: d.answers.teacher.n, type: null, why: d.answers.teacher.why ?? null }, { every: true });
    for (const [label, a] of Object.entries(all.answers)) result[label] = a;
  } else await Promise.all(models.map(async ({ label, teacher }) => { result[label] = await teacher.ask(request); }));
  answers.set(d.id, Object.fromEntries(Object.entries(result).map(([label, a]) => [label, { n: a.choice, reason: a.reason ?? '', error: a.error ?? null, model: a.model, usd: a.usd ?? 0, usage: a.usage ?? null, latencyMs: a.latencyMs ?? null, cached: Boolean(a.cached), promptHash: a.promptHash, ...(a.via ? { via: a.via } : {}) }])));
}));

// the text log of the chosen decisions, by match
mkdirSync(args.out, { recursive: true });
const byJob = new Map();
for (const { job, match, d } of chosen) { if (!byJob.has(job)) byJob.set(job, { match, rows: [] }); byJob.get(job).rows.push(d); }
const out = [JSON.stringify({ ...header, compare: true, models: models.map((m) => ({ label: m.label, provider: m.settings.provider ?? 'anthropic', model: m.settings.model, set: m.settings.set ?? null })) })];
for (const [job, { match, rows }] of byJob) {
  const lines = rows.map((d) => JSON.stringify({ ...d, answers: { teacher: d.answers.teacher, llms: answers.get(d.id) } }));
  out.push(...lines, JSON.stringify({ ...match, decisions: lines.length, sha256: createHash('sha256').update(lines.join('\n')).digest('hex') }));
}
writeFileSync(path.join(args.out, 'text-compare.jsonl.gz'), gzipSync(`${out.join('\n')}\n`));

// the report
const report = { decisions: chosen.length, seed, dry: Boolean(args.dry), models: {}, between: {}, agreement: { all: 0, majority: 0, split: 0, none: 0 }, byProvider: {} };
const typeOf = (d) => (d.candidates[(d.answers.teacher.n ?? 1) - 1]?.label ?? '').split(':')[0].trim() || 'other';
for (const { label, teacher, settings } of models) {
  const s = { provider: settings.provider ?? 'anthropic', model: settings.model, answered: 0, sameAsTeacher: 0, errors: {}, usd: teacher.stats.usd, calls: teacher.stats.calls, retried: teacher.stats.retried ?? 0, cached: teacher.stats.cached, stopped: teacher.stats.stopped, byType: {} };
  for (const { d } of chosen) {
    const a = answers.get(d.id)[label]; const t = typeOf(d);
    const row = (s.byType[t] ??= { n: 0, same: 0 }); row.n += 1;
    if (a.error) { s.errors[a.error.kind] = (s.errors[a.error.kind] ?? 0) + 1; continue; }
    s.answered += 1; if (a.n === d.answers.teacher.n) { s.sameAsTeacher += 1; row.same += 1; }
  }
  if (args.dry) s.estimate = estimateRun(teacher.stats, settings.pricing ?? settings.pricePerMTok ?? { input: 0, output: 0 }, settings.expectedOutputTokens ?? 100);
  report.models[label] = s;
  report.byProvider[s.provider] = (report.byProvider[s.provider] ?? 0) + s.usd;
}
for (let i = 0; i < models.length; i += 1) for (let j = i + 1; j < models.length; j += 1) {
  const x = models[i].label; const y = models[j].label; let both = 0; let same = 0;
  for (const { d } of chosen) { const a = answers.get(d.id)[x]; const b = answers.get(d.id)[y]; if (a.error || b.error) continue; both += 1; if (a.n === b.n) same += 1; }
  report.between[`${x} / ${y}`] = { both, same };
}
for (const { d } of chosen) {
  const ns = Object.values(answers.get(d.id)).filter((a) => !a.error && a.n).map((a) => a.n);
  if (ns.length === 0) { report.agreement.none += 1; continue; }
  const counts = new Map(); for (const n of ns) counts.set(n, (counts.get(n) ?? 0) + 1);
  const top = Math.max(...counts.values());
  if (counts.size === 1) report.agreement.all += 1; else if (top > ns.length / 2) report.agreement.majority += 1; else report.agreement.split += 1;
}
if (panel) report.ledger = { usd: panel.ledger?.usd ?? 0, calls: panel.ledger?.calls ?? 0, usdBy: panel.ledger?.usdBy ?? {} };
writeFileSync(path.join(args.out, 'compare.json'), `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(report, null, 1));
