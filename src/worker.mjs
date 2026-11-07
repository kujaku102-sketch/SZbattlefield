// A worker process: plays the jobs the orchestrator sends it, one at a time, and answers with the result.
import { loadCpu } from '../cpus/index.mjs';
import { readFileSync } from 'node:fs';
import { playGame } from './play.mjs';

let llmTeacher = null;
async function makeLlmTeacher(limits, workers) {
  const { createLlmTeacher } = await import('./teachers/llm.mjs');
  const settings = JSON.parse(readFileSync(limits.llmConfig, 'utf8'));
  // each process keeps to its share of the limit
  if (Number.isFinite(settings.maxUsd)) settings.maxUsd /= Math.max(1, workers ?? 1);
  if (Number.isFinite(settings.maxCalls)) settings.maxCalls = Math.floor(settings.maxCalls / Math.max(1, workers ?? 1));
  if (settings.ledgerFile) settings.ledgerFile = settings.ledgerFile.replace(/(\.[^.]+)?$/, `-${process.pid}$1`);
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
    shadow = { kind: 'llm', create: () => llmTeacher.create(), compare: compareCpu ? { create: () => compareCpu.create(gameDir) } : null, teacher: llmTeacher };
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
