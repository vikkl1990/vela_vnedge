import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SCRIPTS_DIR } from '../config.ts';
import { importPaths, readLibraryLock, LIBRARY_PATH, LIBRARY_HASH, LOCK_PREFIX, type LibraryLock } from '../../../shared/pineLibraries.ts';

interface LibraryEntry { path: string; sha256: string; file: string; url: string }
interface LibrarySource { path: string; sha256: string; source: string }

/** Reviewed local sources only. Runtime resolution never downloads or substitutes a newer version. */
export class PineLibraries {
  private entries = new Map<string, LibrarySource>();
  constructor(root: string) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as LibraryEntry[];
    for (const entry of manifest) {
      if (!LIBRARY_PATH.test(entry.path) || !LIBRARY_HASH.test(entry.sha256) || !/^[\w-]+\.pine$/.test(entry.file) || this.entries.has(entry.path)) throw new Error('Invalid Pine library manifest entry');
      const source = fs.readFileSync(path.join(root, entry.file), 'utf8');
      if (createHash('sha256').update(source).digest('hex') !== entry.sha256) throw new Error(`Pine library integrity failure: ${entry.path}`);
      this.entries.set(entry.path, { path: entry.path, sha256: entry.sha256, source });
    }
  }

  get(library: string, expectedHash: string): LibrarySource {
    if (!LIBRARY_PATH.test(library) || !LIBRARY_HASH.test(expectedHash)) throw new Error('Invalid Pine library path or hash');
    const entry = this.entries.get(library);
    if (!entry) throw new Error(`Pine library not installed: ${library}`);
    if (entry.sha256 !== expectedHash) throw new Error(`Pine library version mismatch: ${library}; refresh the scanner source`);
    return { ...entry };
  }

  pin(source: string): string {
    if (!importPaths(source).length) return source;
    // An archived source already has an identity; never rewrite it using today's dependencies.
    if (source.split('\n').some(line => line.startsWith(LOCK_PREFIX))) { readLibraryLock(source); return source; }
    const lock: LibraryLock = {};
    const visiting = new Set<string>();
    const visit = (library: string) => {
      if (!LIBRARY_PATH.test(library)) throw new Error(`Invalid Pine import: ${library}`);
      if (visiting.has(library)) throw new Error(`Circular Pine import: ${library}`);
      if (Object.hasOwn(lock, library)) return;
      if (Object.keys(lock).length >= 64) throw new Error('Too many Pine library dependencies');
      const entry = this.entries.get(library);
      lock[library] = entry?.sha256 ?? null;
      if (entry) {
        visiting.add(library);
        for (const dependency of importPaths(entry.source)) visit(dependency);
        visiting.delete(library);
      }
    };
    for (const library of importPaths(source)) visit(library);
    const ordered = Object.fromEntries(Object.entries(lock).sort(([a], [b]) => a.localeCompare(b)));
    return `${source}\n${LOCK_PREFIX}${JSON.stringify(ordered)}\n`;
  }

  resolver(source: string): (library: string) => string {
    const lock = readLibraryLock(source);
    const sources = new Map<string, string>();
    const visiting = new Set<string>();
    const visit = (library: string) => {
      if (visiting.has(library)) throw new Error(`Circular Pine import: ${library}`);
      if (sources.has(library)) return;
      const hash = lock[library];
      if (!hash) throw new Error(`Pine library not pinned or unavailable: ${library}`);
      const entry = this.get(library, hash);
      visiting.add(library);
      for (const dependency of importPaths(entry.source)) visit(dependency);
      visiting.delete(library);
      sources.set(library, entry.source);
    };
    for (const library of importPaths(source)) visit(library);
    return library => {
      const resolved = sources.get(library);
      if (!resolved) throw new Error(`Pine library outside pinned dependency closure: ${library}`);
      return resolved;
    };
  }
}

let installed: PineLibraries | undefined;
export function pineLibraries(): PineLibraries { return installed ??= new PineLibraries(path.join(SCRIPTS_DIR, 'libraries')); }
