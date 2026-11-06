/** The executable source carries its complete dependency identity into policies and replays. */
export type LibraryLock = Record<string, string | null>;
export const LIBRARY_PATH = /^[A-Za-z_][A-Za-z0-9_]*\/[A-Za-z_][A-Za-z0-9_]*\/[1-9][0-9]*$/;
export const LIBRARY_HASH = /^[a-f0-9]{64}$/;
export const LOCK_PREFIX = '// @vnedge-library-lock: ';

export function importPaths(source: string): string[] {
  return [...new Set([...source.matchAll(/^[\t ]*import[\t ]+([^\s]+)/gm)].map(m => m[1]))];
}

export function readLibraryLock(source: string): LibraryLock {
  const lines = source.split('\n').filter(line => line.startsWith(LOCK_PREFIX));
  if (!lines.length) {
    if (importPaths(source).length) throw new Error('Pine imports require a pinned library lock; reload the scanner source');
    return {};
  }
  if (lines.length !== 1 || lines[0].length > 16_384) throw new Error('Invalid Pine library lock');
  const lock: unknown = JSON.parse(lines[0].slice(LOCK_PREFIX.length));
  if (!lock || typeof lock !== 'object' || Array.isArray(lock) || Object.keys(lock).length > 64) throw new Error('Invalid Pine library lock');
  for (const [path, hash] of Object.entries(lock)) {
    if (!LIBRARY_PATH.test(path) || (hash !== null && (typeof hash !== 'string' || !LIBRARY_HASH.test(hash)))) throw new Error('Invalid Pine library lock entry');
  }
  return lock as LibraryLock;
}
