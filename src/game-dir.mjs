// The game the bench plays. The game is not part of this repository: it is fetched from outside, at a named commit, and that
// commit is written into every result (env.json). Nothing is ever written to a game repository: only clone and checkout.
//
//   GAME_DIR=<dir>       use that checkout as it is (CI: the game repository checked out at the commit to test)
//   GAME_SOURCE=<path|url>  the game repository to clone from (default: the public Siege_Zeke_openbeta)
//   --commit <sha>       the commit to test (GAME_COMMIT in the environment does the same). With GAME_DIR it is checked against the checkout.
//   GAME_REF=<ref>       with no commit given: the branch to take the head of (default: main)
//   SZB_WORK=<dir>       where clones go (default: the system temp folder)
import { existsSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { makeVariantCopy, variantOf } from './variants.mjs';

export const GAME_SOURCE = process.env.GAME_SOURCE ?? 'https://github.com/kujaku102-sketch/Siege_Zeke_openbeta';
const GAME_REF = process.env.GAME_REF ?? 'main';
const WORK = process.env.SZB_WORK ?? os.tmpdir();
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// `variant`: the id of a rule variant (variants/<id>.json); the game is then a copy of the checkout with the variant's edits (src/variants.mjs).
export function resolveGameDir(commit = null, variant = null) {
  const base = resolveBaseGameDir(commit);
  if (!variant) return base;
  const info = describeGame(base);
  return makeVariantCopy(base, `${base}-${variant}`, variant, info);
}

function resolveBaseGameDir(commit) {
  commit ??= process.env.GAME_COMMIT ?? null;
  if (process.env.GAME_DIR) {
    const dir = path.resolve(process.env.GAME_DIR);
    const head = describeGame(dir).commit;
    if (commit && head && !head.startsWith(commit) && !commit.startsWith(head)) throw new Error(`GAME_DIR is at ${head}, but the commit asked for is ${commit}`);
    return dir;
  }
  const cloneTo = (dir) => execFileSync('git', ['clone', '-q', '--no-checkout', GAME_SOURCE, dir], { stdio: 'inherit' });
  if (commit) {
    const dir = path.join(WORK, `szbattlefield-game-${commit.slice(0, 7)}`);
    if (!existsSync(path.join(dir, 'package.json'))) { cloneTo(dir); git(dir, 'checkout', '-q', '--detach', commit); }
    return dir;
  }
  // No commit named: take the head of GAME_REF once, and keep the clone under that commit's name.
  const temp = path.join(WORK, `szbattlefield-game-tmp-${process.pid}`);
  cloneTo(temp);
  const sha = git(temp, 'rev-parse', `origin/${GAME_REF}`);
  const dir = path.join(WORK, `szbattlefield-game-${sha.slice(0, 7)}`);
  if (existsSync(dir)) rmSync(temp, { recursive: true, force: true });
  else { git(temp, 'checkout', '-q', '--detach', sha); renameSync(temp, dir); }
  return dir;
}

export function describeGame(dir) {
  const variant = variantOf(dir);
  if (variant) return { dir, commit: variant.commit, subject: `${variant.subject ?? ''} + variant ${variant.id}`, dirty: false, variant: { id: variant.id, hash: variant.hash } };
  try { return { dir, commit: git(dir, 'rev-parse', 'HEAD'), subject: git(dir, 'log', '-1', '--format=%s'), dirty: git(dir, 'status', '--porcelain') !== '' }; }
  catch { return { dir, commit: null, subject: null, dirty: null }; }
}
