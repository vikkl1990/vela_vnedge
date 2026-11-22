import fs from 'node:fs';
import path from 'node:path';
import { SCRIPTS_DIR } from '../config.ts';

/** Base script id for a variant, or the id itself when it is not a variant. */
export function strategyFamily(id: string): string {
  return families().get(id) ?? id;
}

/** True when `other` should be the one that trades and `self` should stand down. The base id wins; otherwise the smaller id. */
export function variantSupersedes(self: string, other: string): boolean {
  if (self === other || strategyFamily(self) !== strategyFamily(other)) return false;
  const family = strategyFamily(self);
  if (other === family) return true;
  if (self === family) return false;
  return other < self;
}

let cached: Map<string, string> | null = null;
function families(): Map<string, string> {
  if (cached) return cached;
  cached = new Map();
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'variants.json'), 'utf8')) as Array<{ id?: string; base?: string }>;
    for (const row of rows) {
      if (row.id && row.base) cached.set(row.id, row.base);
    }
  } catch { /* a missing catalogue means every id is its own family */ }
  return cached;
}
