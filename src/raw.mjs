// Reading and cleaning a raw.jsonl. A run that was killed can leave half a line at the end; every reader ignores lines it cannot
// parse (and says how many), and a run that resumes rewrites the file without them before it appends.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export function readRaw(file) {
  if (!existsSync(file)) return { rows: [], unreadable: 0 };
  const rows = []; let unreadable = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { unreadable += 1; }
  }
  return { rows, unreadable };
}

// Rewrites the file with the readable lines only (through a temporary file, so a stop in the middle loses nothing).
export function cleanRaw(file) {
  const { rows, unreadable } = readRaw(file);
  if (unreadable > 0) {
    const temp = `${file}.tmp`;
    writeFileSync(temp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
    renameSync(temp, file);
  }
  return { rows, unreadable };
}
