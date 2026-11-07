// CPU registry. A CPU spec is `<name or path>` optionally followed by `?key=value&key=value`.
//   a name is a file in this folder (`simple` = cpus/simple.mjs); a path (ends with .mjs, or has a slash) is loaded as it is.
//   the parameters reach the CPU as an object of strings: create(gameDir, params).
// A CPU module default-exports { id, create(gameDir, params) -> { choose(view) }, versionFiles?(gameDir) -> [paths], needsSim? }.
// `versionFiles` lists the files outside the module that decide how the CPU plays (for `simple`, the game's own policy file),
// so that the CPU's version (a hash of its files) changes whenever its behaviour can.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export function parseCpuSpec(spec) {
  const at = spec.indexOf('?');
  const name = at < 0 ? spec : spec.slice(0, at);
  const params = at < 0 ? {} : Object.fromEntries(new URLSearchParams(spec.slice(at + 1)));
  const file = name.includes('/') || name.includes('\\') || name.endsWith('.mjs') ? path.resolve(name) : path.join(here, `${name}.mjs`);
  return { name, params, file };
}

// A CPU that looks ahead (needsSim) is handed a state made for it by the harness, never the real match. To keep it from reaching the real
// match by itself, its files may import only other files of this folder: no node:fs, no game module, no dynamic import. Returns the files.
const COMMENTS = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm;
const DYNAMIC = /\bimport\s*\(|\brequire\s*\(/;
const STATIC = /^\s*(?:import|export)\b[^;()=]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
export function sealedFiles(file, seen = new Set()) {
  if (seen.has(file)) return [...seen];
  seen.add(file);
  const source = readFileSync(file, 'utf8').replace(COMMENTS, '');
  if (DYNAMIC.test(source)) throw new Error(`${file}: a CPU that needs the sim may not import dynamically`);
  for (const [, fromTarget, bareTarget] of source.matchAll(STATIC)) {
    const target = fromTarget ?? bareTarget;
    const resolved = path.resolve(path.dirname(file), target);
    if (!target.startsWith('.') || path.relative(here, resolved).startsWith('..')) throw new Error(`${file}: a CPU that needs the sim may import only files of cpus/ (found '${target}')`);
    sealedFiles(resolved, seen);
  }
  return [...seen];
}

export async function loadCpu(spec) {
  const { file, params } = parseCpuSpec(spec);
  const module = await import(pathToFileURL(file).href);
  const cpu = module.default;
  if (!cpu || typeof cpu.create !== 'function' || typeof cpu.id !== 'string') throw new Error(`not a CPU module: ${file}`);
  if (cpu.needsSim === true) sealedFiles(file);
  return { ...cpu, file, params, create: (gameDir) => cpu.create(gameDir, params) };
}

// Line endings are not part of a version: a checkout on Windows may turn LF into CRLF.
export const fileHash = (file) => createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);

export async function cpuVersion(spec, gameDir) {
  const cpu = await loadCpu(spec);
  const files = [...new Set([cpu.file, ...(cpu.needsSim === true ? sealedFiles(cpu.file) : []), ...(cpu.versionFiles ? cpu.versionFiles(gameDir) : [])])];
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${path.basename(file)}:${fileHash(file)};`);
  return { spec, id: cpu.id, files: files.map((file) => ({ file: path.basename(file), hash: fileHash(file) })), hash: hash.digest('hex').slice(0, 16) };
}
