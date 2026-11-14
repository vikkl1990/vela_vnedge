/** Source-pinned research, deliberately outside admission, sizing and execution. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SCRIPTS_DIR, type ScannerConfig } from '../config.ts';
import type { LoadedScanner } from '../scanners/registry.ts';

export interface SourceContract {
  sha256: string; reviewedAt: string; type: string; idea: string;
  entries: Array<{ marker: string; channel: string; side: string; line: number; condition: string }>;
  notEntries: Array<{ marker: string; channel: string; role: string; line: number }>;
  stop: { has: boolean; how: string }; targets: { has: boolean; how: string }; exit: { has: boolean; how: string };
  timing: { knownAtClose: boolean; pivotLagBars: number; lookahead: string; repaints: boolean; note: string };
  claims: Array<{ scannerId: string | null; marker: string; problem: string; line: number; evidence: string }>;
}
export interface PublicationReview {
  url: string; author: string | null; retrievedAt: string | null; updatedAt: string | null; version: number | null;
  reviewedAt: string | null; role: string | null; summary: string | null; requirements: string | null;
  reviewVersion: number | null; reviewUpdatedAt: string | null;
  reviewBlocker?: { blocker: string; checkedAt: string | null };
  reconciliation?: {
    pageSha256: string; sourceChecked: boolean; sourceHashes: Record<string,string>; scope: string;
    findings: Array<{kind:string;marker:string;evidence:string;sourceLine:number|null;action:string}>;
  };
}
export interface AuthorReviewCatalog {
  schema: 1; generatedAt: string;
  scripts: Record<string, { file: string; publication: string | null; integrationNotes: string[] }>;
  sources: Record<string, SourceContract>;
  publications: Record<string, PublicationReview>;
}
let cached: AuthorReviewCatalog | undefined;
export function authorReviewCatalog(): AuthorReviewCatalog {
  if (!cached) {
    const file = path.join(SCRIPTS_DIR, 'author-reviews.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as AuthorReviewCatalog;
    if (data.schema !== 1 || !data.scripts || !data.sources || !data.publications) throw new Error('Unsupported author review catalogue');
    cached = data;
  }
  return cached;
}

export function authorReview(s: Pick<LoadedScanner, 'id' | 'variantOf' | 'file' | 'source' | 'patches'>,
  sc: Partial<ScannerConfig> = {}, catalog = authorReviewCatalog()) {
  const record = catalog.scripts[s.id] ?? (s.variantOf ? catalog.scripts[s.variantOf] : undefined);
  // The source filename alone is insufficient: a new import must be reconciled explicitly.
  const historical = record?.file === s.file ? catalog.sources[s.file] : undefined;
  const hash = createHash('sha256').update(s.source ?? '').digest('hex');
  const sourceStatus = !historical ? 'unreviewed' : historical.sha256 === hash ? 'matches' : 'changed';
  const contract = sourceStatus === 'matches' && historical ? { ...historical,
    claims: historical.claims.filter(c => c.scannerId === s.id || c.scannerId === s.variantOf) } : null;
  const publication = record?.publication ? catalog.publications[record.publication] ?? null : null;
  const publicationChanged = Boolean(publication?.reviewedAt && (
    publication.version !== publication.reviewVersion || publication.updatedAt !== publication.reviewUpdatedAt));
  const descriptionStatus = !publication?.retrievedAt ? 'unavailable' : !publication.reviewedAt ? 'retrieved' : publicationChanged ? 'changed' : 'reviewed';
  const reconciliation = publication?.reconciliation;
  // Author prose can remain current while the installed Pine has changed. Never
  // present a former source-specific finding as a checked fact about new bytes.
  const reconciliationStatus = !reconciliation ? 'unreviewed' : publicationChanged ? 'publication changed'
    : !reconciliation.sourceChecked ? 'description only'
    : reconciliation.sourceHashes[s.file] === hash ? 'matches' : 'source changed or not inspected';
  return {
    asOf: catalog.generatedAt, sourceStatus, sourceHash: hash, reviewedSourceHash: historical?.sha256 ?? null,
    sourceReviewedAt: historical?.reviewedAt ?? null, contract,
    publication, descriptionStatus,
    reconciliationStatus,
    reconciliation: reconciliationStatus === 'matches' || reconciliationStatus === 'description only' ? reconciliation : null,
    // These are historical research claims, not assertions that today's configured reader still has the fault.
    claimMeaning: 'Prior source-study claims marked confirmed for this scanner or its base; recheck against the current reading. Refuted and unchecked claims are excluded.',
    integrationNotes: record?.integrationNotes ?? [],
    patches: s.patches ?? [],
    reading: { reader: sc.reader ?? 1, sources: sc.sources ?? null, labels: sc.labels ?? null,
      sides: sc.sides ?? null, exitMode: sc.exitMode ?? 'both', entryProtection: sc.entryProtection ?? 'inherited' },
    admission: 'Research only. This record neither enables a scanner nor supplies promotion evidence.',
  };
}
