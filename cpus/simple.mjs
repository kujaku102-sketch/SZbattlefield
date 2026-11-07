// CPU adapter: the game's current CPU (src/adapters/simple-ai-policy.js).
// A CPU is `{ id, create(gameDir, params) -> { choose(view) } }`. `view` is all it gets:
//   view.query        the seat's own query (what the UI of that seat sees: its hand, the public board, legal actions, required input)
//   view.queryAction  plans one action of that seat (a closure over the seat's port; no other seat, no authority, no engine state)
//   view.commandId    the id to put on the command
//   view.seatId       the seat it plays
// and returns `{ ok: true, value: { commandId, expectedRevision, action } }` or `{ ok: false, error: { code } }`.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const policyFile = (gameDir) => path.join(gameDir, 'src/adapters/simple-ai-policy.js');

export default {
  id: 'simple',
  // the file that decides how it plays lives in the game; its hash is part of this CPU's version
  versionFiles: (gameDir) => [policyFile(gameDir)],
  async create(gameDir) {
    const policy = await import(pathToFileURL(policyFile(gameDir)).href);
    return { choose: (view) => policy.chooseSimpleAiIntent(view.query, view.commandId, view.queryAction) };
  }
};
