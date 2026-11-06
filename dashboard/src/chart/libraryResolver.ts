import { readLibraryLock } from '../../../shared/pineLibraries.ts';

type LibraryResponse = { path: string; sha256: string; source: string };
/** A chart can contain several scanners; every one must agree on the exact bytes for an import. */
export function createLibraryResolver(sources: () => string[], fetchLibrary: (path: string, hash: string) => Promise<LibraryResponse>) {
  const cache = new Map<string, Promise<string>>();
  return async (path: string): Promise<string> => {
    const pins = sources().map(readLibraryLock).filter(lock => Object.hasOwn(lock, path)).map(lock => lock[path]);
    const hash = pins[0];
    if (!hash || pins.some(pin => pin !== hash)) throw new Error(`Pine library missing or conflicting pins: ${path}; reload the scanner source`);
    const key = `${path}:${hash}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = fetchLibrary(path, hash).then(result => {
        if (result.path !== path || result.sha256 !== hash) throw new Error(`Pine library response mismatch: ${path}`);
        return result.source;
      });
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    return pending;
  };
}
