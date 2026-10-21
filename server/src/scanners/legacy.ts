import fs from 'node:fs';
import path from 'node:path';
import { SCRIPTS_DIR } from '../config.ts';

/**
 * Decision 164: the scanners whose record was earned under the older reading of their output. A reading rule added
 * later (condition titles with named arguments, the label and shape-geometry fallbacks of decision 172) is not applied
 * to them, so their signals stay those their record vouches for. Read once; a missing or broken file means none.
 */
let cached: Set<string> | null = null;
export function readingLegacy(): Set<string> {
  if (!cached) {
    try { cached = new Set(JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'condition-titles-legacy.json'), 'utf8')).ids ?? []); }
    catch { cached = new Set(); }
  }
  return cached;
}
