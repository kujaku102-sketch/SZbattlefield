#!/usr/bin/env node
// The same decisions put to several language models, to read their answers next to the looking-ahead teacher's (and next to each other).
//
//   node src/llm-compare.mjs --text <dir of text logs> [--text <dir>] --n 100 --seed 1 --config <settings.json> [--config <settings.json> ...] --out <dir> [--dry]
//
// --text    text logs of a run (--record-text, with --shadow llm --shadow-compare lookahead; a dry run is enough): the prompts and the looking-ahead teacher's answers are there
// --n       how many decisions (chosen the same way every time from --seed: the ones with an answer of the teacher, sorted by a hash of their id)
// --config  the settings of one model (src/teachers/llm.mjs; `label` names it in the report); every one answers the same decisions
// --out     writes text-compare.jsonl.gz here (the same format as the text logs, so `forge audit build <out>` shows it: the models side by side, the disagreements apart)
//           and compare.json (agreements, errors, what it cost)
// --dry     no call is made whatever the settings say: the number of calls and what they could cost are written
//
// The key is read from the environment (FORGE_LLM_API_KEY) by src/teachers/secrets.mjs and nowhere else.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { constants, gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { createLlmTeacher, estimateRun } from './teachers/llm.mjs';

const args = {}; const lists = { text: [], config: [] };
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const name = a.slice(2); const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[name] = true; else { if (lists[name]) lists[name].push(next); else args[name] = next; i += 1; }
}
if (lists.text.length === 0 || lists.config.length === 0 || typeof args.out !== 'string') { console.error('usage: llm-compare.mjs --text <dir> --n 100 --seed 1 --config <settings.json> [--config ...] --out <dir> [--dry]'); process.exit(2); }

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

const teachers = lists.config.map((file) => {
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  if (args.dry) settings.transport = 'dry';
  return { label: settings.label ?? settings.model, teacher: createLlmTeacher(settings), settings };
});
const answers = new Map();   // decision id -> { label -> answer }
await Promise.all(chosen.flatMap(({ d }) => teachers.map(async ({ label, teacher }) => {
  const answer = await teacher.ask({ id: d.id, prompt: { system: header.system, user: d.prompt }, candidates: d.candidates });
  if (!answers.has(d.id)) answers.set(d.id, {});
  answers.get(d.id)[label] = { n: answer.choice, reason: answer.reason ?? '', error: answer.error ?? null, model: answer.model, usd: answer.usd ?? 0, usage: answer.usage ?? null, latencyMs: answer.latencyMs ?? null, cached: Boolean(answer.cached), promptHash: answer.promptHash };
})));

// the text log of the chosen decisions, by match
mkdirSync(args.out, { recursive: true });
const byJob = new Map();
for (const { job, match, d } of chosen) { if (!byJob.has(job)) byJob.set(job, { match, rows: [] }); byJob.get(job).rows.push(d); }
const out = [JSON.stringify({ ...header, compare: true, models: teachers.map((t) => ({ label: t.label, provider: t.settings.provider ?? 'anthropic', model: t.settings.model, set: t.settings.set ?? null })) })];
for (const [job, { match, rows }] of byJob) {
  const lines = rows.map((d) => JSON.stringify({ ...d, answers: { teacher: d.answers.teacher, llms: answers.get(d.id) } }));
  out.push(...lines, JSON.stringify({ ...match, decisions: lines.length, sha256: createHash('sha256').update(lines.join('\n')).digest('hex') }));
}
writeFileSync(path.join(args.out, 'text-compare.jsonl.gz'), gzipSync(`${out.join('\n')}\n`));

// the report
const report = { decisions: chosen.length, seed, dry: Boolean(args.dry), models: {}, between: {} };
const typeOf = (d) => (d.candidates[(d.answers.teacher.n ?? 1) - 1]?.label ?? '').split(':')[0].trim() || 'other';
for (const { label, teacher, settings } of teachers) {
  const s = { answered: 0, sameAsTeacher: 0, errors: {}, usd: teacher.stats.usd, calls: teacher.stats.calls, cached: teacher.stats.cached, stopped: teacher.stats.stopped, byType: {} };
  for (const { d } of chosen) {
    const a = answers.get(d.id)[label]; const t = typeOf(d);
    const row = (s.byType[t] ??= { n: 0, same: 0 }); row.n += 1;
    if (a.error) { s.errors[a.error.kind] = (s.errors[a.error.kind] ?? 0) + 1; continue; }
    s.answered += 1; if (a.n === d.answers.teacher.n) { s.sameAsTeacher += 1; row.same += 1; }
  }
  if (args.dry) s.estimate = estimateRun(teacher.stats, settings.pricing ?? settings.pricePerMTok ?? { input: 0, output: 0 }, settings.expectedOutputTokens ?? 100);
  report.models[label] = s;
}
for (let i = 0; i < teachers.length; i += 1) for (let j = i + 1; j < teachers.length; j += 1) {
  const x = teachers[i].label; const y = teachers[j].label; let both = 0; let same = 0;
  for (const { d } of chosen) { const a = answers.get(d.id)[x]; const b = answers.get(d.id)[y]; if (a.error || b.error) continue; both += 1; if (a.n === b.n) same += 1; }
  report.between[`${x} / ${y}`] = { both, same };
}
writeFileSync(path.join(args.out, 'compare.json'), `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(report, null, 1));
