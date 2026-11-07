// Rule variants for experiments. A variant is a few exact text edits (variants/<id>.json) applied to a COPY of the game made in the work folder;
// the game repository and its clone are never changed. The copy remembers which variant it is (.szb-variant.json) and every result records it
// (env.json: game.variant), so results of different rules are never mixed.
//
//   { id, description, edits: [{ file, find, replace }] }   each `find` must occur exactly once in its file
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const VARIANTS_DIR = path.join(here, '..', 'variants');
const MARK = '.szb-variant.json';

export function loadVariant(id) {
  const file = path.join(VARIANTS_DIR, `${id}.json`);
  if (!existsSync(file)) throw new Error(`no variant ${id} (variants/${id}.json)`);
  const variant = JSON.parse(readFileSync(file, 'utf8'));
  const hash = createHash('sha256').update(JSON.stringify(variant.edits)).digest('hex').slice(0, 12);
  return { ...variant, hash };
}

// A copy of the game checkout `baseDir` with the variant applied, at `targetDir` (made once). Only what the game needs to run is copied.
export function makeVariantCopy(baseDir, targetDir, id, base = {}) {
  const variant = loadVariant(id);
  if (existsSync(path.join(targetDir, MARK))) {
    const made = JSON.parse(readFileSync(path.join(targetDir, MARK), 'utf8'));
    if (made.hash === variant.hash) return targetDir;
    throw new Error(`${targetDir} was made with another version of variant ${id}`);
  }
  mkdirSync(targetDir, { recursive: true });
  for (const entry of ['src', 'packages', 'package.json']) if (existsSync(path.join(baseDir, entry))) cpSync(path.join(baseDir, entry), path.join(targetDir, entry), { recursive: true });
  for (const edit of variant.edits) {
    const file = path.join(targetDir, edit.file);
    let text = readFileSync(file, 'utf8');
    // a checkout on Windows may have CRLF line ends: the edit is written with LF
    const crlf = text.includes('\r\n');
    const find = crlf ? edit.find.replace(/\n/g, '\r\n') : edit.find;
    const replace = crlf ? edit.replace.replace(/\n/g, '\r\n') : edit.replace;
    const count = text.split(find).length - 1;
    if (count !== 1) throw new Error(`variant ${id}: the text to replace occurs ${count} times in ${edit.file} (must be exactly once)`);
    text = text.replace(find, () => replace);
    writeFileSync(file, text);
  }
  writeFileSync(path.join(targetDir, MARK), JSON.stringify({ id: variant.id, hash: variant.hash, description: variant.description, commit: base.commit ?? null, subject: base.subject ?? null }, null, 2));
  return targetDir;
}

export function variantOf(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, MARK), 'utf8')); } catch { return null; }
}
