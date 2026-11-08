// A worker process: plays the jobs the orchestrator sends it, one at a time, and answers with the result.
import { loadCpu } from '../cpus/index.mjs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { playGame } from './play.mjs';
import { inScope } from './teachers/llm.mjs';

// a panel: the limits of its set (all together and for each provider) are what the files of the set have not spent yet, shared out between the processes
async function makePanel(config, workers) {
  const { createPanel } = await import('./teachers/panel.mjs');
  const { priorSpend } = await import('./teachers/ledger.mjs');
  const share = Math.max(1, workers ?? 1);
  const budget = { ...(config.budget ?? {}) };
  if (config.ledgerDir) {
    const spent = priorSpend(config.ledgerDir, config.set ?? 'panel');
    if (Number.isFinite(budget.maxUsd)) budget.maxUsd = Math.max(0, budget.maxUsd - spent.usd);
    if (Number.isFinite(budget.maxCalls)) budget.maxCalls = Math.max(0, budget.maxCalls - spent.calls);
    if (budget.perProvider) budget.perProvider = Object.fromEntries(Object.entries(budget.perProvider).map(([k, v]) => [k, Math.max(0, v - (spent.usdBy[k] ?? 0))]));
    config.ledgerFile = path.join(config.ledgerDir, `${config.set ?? 'panel'}-${process.pid}.jsonl`);
  }
  if (Number.isFinite(budget.maxUsd)) budget.maxUsd /= share;
  if (Number.isFinite(budget.maxCalls)) budget.maxCalls = Math.floor(budget.maxCalls / share);
  if (budget.perProvider) budget.perProvider = Object.fromEntries(Object.entries(budget.perProvider).map(([k, v]) => [k, v / share]));
  return createPanel({ ...config, budget });
}

let llmTeacher = null;
async function makeLlmTeacher(limits, workers) {
  const { createLlmTeacher } = await import('./teachers/llm.mjs');
  const settings = JSON.parse(readFileSync(limits.llmConfig, 'utf8'));
  if (settings.kind === 'llm-panel' || settings.models) return makePanel(settings, workers);
  // a set of questions has a limit of its own: what the files of the set (ledgerDir/<set>*.jsonl, one for each process) already hold is spent
  if (settings.set && settings.ledgerDir) {
    let spentUsd = 0; let spentCalls = 0;
    if (existsSync(settings.ledgerDir)) for (const name of readdirSync(settings.ledgerDir)) {
      if (!(name === `${settings.set}.jsonl` || (name.startsWith(`${settings.set}-`) && name.endsWith('.jsonl')))) continue;
      for (const line of readFileSync(path.join(settings.ledgerDir, name), 'utf8').split('\n')) { if (!line.trim()) continue; try { spentUsd += Number(JSON.parse(line).usd ?? 0); spentCalls += 1; } catch { /* a cut line */ } }
    }
    if (Number.isFinite(settings.maxUsd)) settings.maxUsd = Math.max(0, settings.maxUsd - spentUsd);
    if (Number.isFinite(settings.maxCalls)) settings.maxCalls = Math.max(0, settings.maxCalls - spentCalls);
    settings.ledgerFile = path.join(settings.ledgerDir, `${settings.set}-${process.pid}.jsonl`);
  }
  // each process keeps to its share of the limit
  if (Number.isFinite(settings.maxUsd)) settings.maxUsd /= Math.max(1, workers ?? 1);
  if (Number.isFinite(settings.maxCalls)) settings.maxCalls = Math.floor(settings.maxCalls / Math.max(1, workers ?? 1));
  if (settings.ledgerFile && !settings.set) settings.ledgerFile = settings.ledgerFile.replace(/(\.[^.]+)?$/, `-${process.pid}$1`);
  return createLlmTeacher(settings);
}

process.on('message', async (message) => {
  if (message.type === 'exit') process.exit(0);
  if (message.type !== 'job') return;
  const { job, gameDir, limits, record, workers } = message;
  // One CPU object per game and seat: a CPU may keep state between its own moves, never between games.
  const cpus = {
    'seat-a': (await loadCpu(job.cpus['seat-a'])).create(gameDir),
    'seat-b': (await loadCpu(job.cpus['seat-b'])).create(gameDir)
  };
  for (const seat of Object.keys(cpus)) cpus[seat] = await cpus[seat];
  // a teacher that looks at the decisions of the other CPUs (--shadow <cpu>), a new one for every decision
  // (--shadow llm: a language model; one teacher object for all the jobs of this process, so the limit on the spend and the number of calls at once hold across them)
  let shadow = null;
  if (limits.shadow === 'llm') {
    llmTeacher ??= await makeLlmTeacher(limits, workers);
    const compareCpu = limits.compare ? await loadCpu(limits.compare) : null;
    shadow = { kind: 'llm', create: () => llmTeacher.create(), compare: compareCpu ? { create: () => compareCpu.create(gameDir) } : null, teacher: llmTeacher, scope: llmTeacher.settings.scope ?? null, inScope };
  } else if (limits.shadow) {
    const shadowCpu = await loadCpu(limits.shadow);
    shadow = { create: () => shadowCpu.create(gameDir) };
  }
  const result = await playGame({ gameDir, job, cpus, limits, record: record ? { ...record, tag: String(process.pid) } : null, shadow });
  if (shadow?.teacher) result.llm = { ...shadow.teacher.stats, ledgerUsd: shadow.teacher.ledger?.usd ?? 0 };
  process.send({ type: 'result', result });
});
process.on('disconnect', () => process.exit(0));
process.send({ type: 'ready' });
