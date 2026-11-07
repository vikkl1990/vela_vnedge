/**
 * Review full sources from all six publishers and LuxAlgo, including known publications.
 * OUT=data writes the VM's data/library/updates; otherwise scripts/updates.
 * DRY=1 performs the same checks without writing files or taking a writer lock.
 * New/revised sources are staged here, outside the scanner registry. After runtime,
 * signal and evidence review, import them under a separate reviewed identity.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, SCRIPTS_DIR } from '../config.ts';
import { SourceReview, syncSources, publicText, acquireSyncLock, AUTHORS } from '../library/sync.ts';

const root = process.env.OUT === 'data' ? path.join(DATA_DIR, 'library') : SCRIPTS_DIR;
const updates = path.join(root, 'updates'), dry = process.env.DRY === '1';
const release = dry ? () => {} : acquireSyncLock(updates);
try {
  const repo = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'manifest.json'), 'utf8'));
  const overlayFile = path.join(DATA_DIR, 'library', 'manifest.json');
  const overlay = fs.existsSync(overlayFile) ? JSON.parse(fs.readFileSync(overlayFile, 'utf8')) : [];
  const repoIds = new Set(repo.map((m: any) => m.id));
  const known = [...repo.map((m: any) => ({ ...m, directory: path.join(SCRIPTS_DIR, 'pine') })),
    ...overlay.filter((m: any) => !repoIds.has(m.id)).map((m: any) => ({ ...m, directory: path.join(DATA_DIR, 'library', 'pine') }))];
  const review = new SourceReview(known, updates, dry);
  const report = await syncSources({ review, text: publicText, log: console.log,
    authors: process.env.AUTHORS === undefined ? AUTHORS : process.env.AUTHORS.split(',').map(a => a.trim()).filter(Boolean) });
  console.log(`${dry ? 'Dry run' : 'Source review saved'}: ${JSON.stringify(report.counts)}`);
  console.log(`${report.candidates.length} candidates · ${report.issues.length} source issues · ${path.join(updates, 'review.json')}`);
  if (!report.complete) process.exitCode = 1;
} finally { release(); }
