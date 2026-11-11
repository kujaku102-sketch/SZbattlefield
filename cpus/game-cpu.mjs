// CPU adapter: a CPU that the game ships (src/cpu/ of the game under test), called through the game's own entry, createCpu (src/cpu/index.js), as the game's UI calls it.
//   game-cpu?cpu=lightZIG       the CPU named in the game's catalog (src/cpu/catalog.js)
// What it is for: the CPU that is shipped is the CPU that was measured. The same table played with the released file of cpus/release/ and with this adapter must give the same matches
// (src/compare-shipped.mjs does the comparing; src/compare.mjs says the same for two runs of one file).
// The game's time guard is off here (the clock is stopped): a decision must not depend on how fast the machine is.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readdirSync } from 'node:fs';

const at = (gameDir, ...parts) => path.join(gameDir, ...parts);

export default {
  id: 'game-cpu',
  // the files of the game that decide how the shipped CPU plays: everything under src/cpu/ (its entry, catalog, frozen code, weights) and the simple CPU it falls back on
  versionFiles(gameDir) {
    const files = [at(gameDir, 'src/adapters/simple-ai-policy.js')];
    const walk = (dir) => {
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name)); } catch { return; }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file); else if (/[.](m?js|json)$/.test(entry.name)) files.push(file);
      }
    };
    walk(at(gameDir, 'src/cpu'));
    return files;
  },
  async create(gameDir, params = {}) {
    const cpuId = params.cpu ?? 'simple';
    const entry = await import(pathToFileURL(at(gameDir, 'src/cpu/index.js')).href);
    const loaded = await entry.preloadCpu(cpuId, { allowStale: true });
    if (!loaded.ok) throw new Error(`game-cpu: ${cpuId}: ${loaded.error?.code}`);
    let made = null;
    let deckLimit = null;
    return {
      // the bench hands the match to this adapter only (play.mjs), and the adapter hands it to the game's own lookahead host, as the game's session does (match-session-controller.js lookahead)
      needsAuthority: true,
      choose(view) {
        // one CPU for one seat of one match, made when it first has to decide
        made ??= entry.createCpu({ cpuId, seatId: view.seatId, allowStale: true, clock: () => 0 });
        if (!made.ok) return { ok: false, error: made.error };
        // how many cards the decks held at the start: the identity ledger of the match as the first decision finds it (the session reads it when the match is made; no token exists yet at the opening)
        deckLimit ??= view.authority.engineState.runtimeContext.identityState.nextSerial - 1;
        const lookahead = (host) => host.open({ authority: view.authority, seat: view.seatId, deckLimit });
        return made.value.policy(view.query, view.commandId, view.queryAction, lookahead);
      }
    };
  }
};
