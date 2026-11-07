// A worker process: plays the jobs the orchestrator sends it, one at a time, and answers with the result.
import { loadCpu } from '../cpus/index.mjs';
import { playGame } from './play.mjs';

process.on('message', async (message) => {
  if (message.type === 'exit') process.exit(0);
  if (message.type !== 'job') return;
  const { job, gameDir, limits } = message;
  // One CPU object per game and seat: a CPU may keep state between its own moves, never between games.
  const cpus = {
    'seat-a': (await loadCpu(job.cpus['seat-a'])).create(gameDir),
    'seat-b': (await loadCpu(job.cpus['seat-b'])).create(gameDir)
  };
  for (const seat of Object.keys(cpus)) cpus[seat] = await cpus[seat];
  const result = await playGame({ gameDir, job, cpus, limits });
  process.send({ type: 'result', result });
});
process.on('disconnect', () => process.exit(0));
process.send({ type: 'ready' });
