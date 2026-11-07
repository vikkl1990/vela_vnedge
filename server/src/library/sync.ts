/** Upstream sources are evidence candidates, never in-place replacements (decision 224). */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface InstalledSource {
  id: string; file: string; directory: string; url?: string; pub?: string | null;
  status?: string; updated?: string | null;
}
export interface Publication {
  name: string; author: string; url: string; pub?: string | null; uuid?: string | null;
  slug?: string; updated?: string | null; version?: string | null;
}
export interface Candidate extends Publication {
  key: string; kind: 'new' | 'revision' | 'local-difference'; installedIds: string[];
  sha256: string; normalizedSha256: string; sourceFile: string; firstSeen: string; lastSeen: string;
}
export interface SyncIssue { key: string; url: string; reason: string; at: string }
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const sourceHash = (s: string) => hash(s.replace(/\r\n?/g, '\n').trim());
const uuidOf = (p: { url?: string; uuid?: string | null }) => p.uuid || p.url?.match(/\/script\/([a-zA-Z0-9]+)(?:-|\/)/)?.[1];
const slugOf = (p: { url?: string; slug?: string }) => p.slug || p.url?.match(/\/library\/indicator\/([^/]+)/)?.[1];
const keyOf = (p: Publication) => uuidOf(p) ? `tv:${uuidOf(p)}` : p.pub ? `pub:${p.pub}` : slugOf(p) ? `lux:${slugOf(p)}` : `url:${p.url}`;

/** A preview can be valid Pine and still omit the entire signal implementation. Fail closed. */
export function completeSource(code: unknown, preview?: unknown): string {
  if (preview != null) {
    const p = preview as { shownLines?: unknown; totalLines?: unknown };
    if (!Number.isInteger(p.shownLines) || !Number.isInteger(p.totalLines) ||
        Number(p.shownLines) <= 0 || Number(p.totalLines) <= 0 || Number(p.shownLines) !== Number(p.totalLines)) {
      throw new Error(`Incomplete source preview (${String(p.shownLines ?? '?')}/${String(p.totalLines ?? '?')} lines)`);
    }
    if (typeof code !== 'string' || code.trimEnd().split(/\r?\n/).length < Number(p.totalLines)) {
      throw new Error('Source is shorter than its completeness metadata');
    }
  }
  if (typeof code !== 'string' || code.trim().length < 100 ||
      !/^\s*\/\/@version=\d+/m.test(code) || !/^\s*(?:indicator|strategy)\s*\(/m.test(code)) {
    throw new Error('Full Pine indicator/strategy source is unavailable');
  }
  return code;
}

function atomicJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
}

export class SourceReview {
  readonly candidates = new Map<string, Candidate>();
  readonly issues = new Map<string, SyncIssue>();
  readonly counts = { current: 0, retired: 0, new: 0, revision: 0, localDifference: 0, blocked: 0, failed: 0 };
  private installed: InstalledSource[];
  private root: string;
  private dry: boolean;
  private now: string;
  constructor(installed: InstalledSource[], root: string, dry = false, now = new Date().toISOString()) {
    this.installed = installed; this.root = root; this.dry = dry; this.now = now;
    const file = path.join(root, 'review.json');
    if (fs.existsSync(file)) {
      const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (previous.schema !== 1 || !Array.isArray(previous.candidates) || !Array.isArray(previous.issues)) throw new Error('Invalid previous source review; refusing to discard it');
      for (const c of previous.candidates) this.candidates.set(c.key, c);
      for (const i of previous.issues) this.issues.set(i.key, i);
    }
  }
  matches(p: Publication) {
    return this.installed.filter(m => (p.pub && m.pub === p.pub) ||
      (uuidOf(p) && uuidOf(m) === uuidOf(p)) || (slugOf(p) && slugOf(m) === slugOf(p)));
  }
  retired(p: Publication) {
    const known = this.matches(p);
    if (!known.length || !known.every(m => m.status === 'removed')) return false;
    const key = keyOf(p); this.counts.retired++; this.candidates.delete(key); this.issues.delete(key);
    return true;
  }
  issue(p: Publication, reason: string, failed = false) {
    const key = keyOf(p); this.counts[failed ? 'failed' : 'blocked']++;
    this.issues.set(key, { key, url: p.url, reason, at: this.now });
    // A download failure must not erase a previously staged, complete source.
  }
  consider(p: Publication, source: string) {
    const key = keyOf(p), known = this.matches(p).filter(m => m.status !== 'removed');
    const normalizedSha256 = sourceHash(source);
    const matches = known.some(m => {
      const file = path.join(m.directory, m.file);
      return fs.existsSync(file) && sourceHash(fs.readFileSync(file, 'utf8')) === normalizedSha256;
    });
    this.issues.delete(key);
    if (matches) { this.counts.current++; this.candidates.delete(key); return; }
    // A different hash alone is not proof of a newer release: our own patches also differ.
    const newest = Math.max(0, ...known.map(m => Date.parse(m.updated ?? '') || 0));
    const upstream = Date.parse(p.updated ?? '') || 0;
    const kind = !known.length ? 'new' : newest > 0 && upstream > newest + 1000 ? 'revision' : 'local-difference';
    const sha256 = hash(source), sourceFile = `sources/${sha256}.pine`;
    const previous = this.candidates.get(key);
    const candidate: Candidate = { ...p, key, kind, installedIds: known.map(m => m.id), sha256,
      normalizedSha256, sourceFile, firstSeen: previous?.sha256 === sha256 ? previous.firstSeen : this.now, lastSeen: this.now };
    if (!this.dry) {
      const file = path.join(this.root, sourceFile);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Content addressed files remain immutable; repair an interrupted/corrupt write atomically.
      if (!fs.existsSync(file) || hash(fs.readFileSync(file, 'utf8')) !== sha256) {
        const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, source); fs.renameSync(temp, file);
      }
    }
    this.candidates.set(key, candidate);
    this.counts[kind === 'local-difference' ? 'localDifference' : kind]++;
  }
  save(complete: boolean) {
    const report = { schema: 1, checkedAt: this.now, complete, counts: this.counts,
      candidates: [...this.candidates.values()].sort((a, b) => a.key.localeCompare(b.key)),
      issues: [...this.issues.values()].sort((a, b) => a.key.localeCompare(b.key)) };
    if (!this.dry) atomicJson(path.join(this.root, 'review.json'), report);
    return report;
  }
}

export const AUTHORS = ['WillyAlgoTrader', 'Zeiierman', 'AlgoAlpha', 'BigBeluga', 'LuxAlgo', 'ChartPrime'];
const SITEMAP = 'https://www.luxalgo.com/server-sitemap.xml';
export interface SyncOptions {
  review: SourceReview;
  text: (url: string) => Promise<string>;
  authors?: string[]; luxalgo?: boolean; concurrency?: number;
  log?: (message: string) => void;
}
async function each<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(4, concurrency)) }, async () => {
    while (next < items.length) { const item = items[next++]; await fn(item); }
  }));
}
export async function syncSources(options: SyncOptions) {
  const { review, text } = options, log = options.log ?? (() => {}), concurrency = options.concurrency ?? 3;
  const inspectedTV = new Set<string>();
  const authors = options.authors ?? AUTHORS;
  // Primary TradingView source takes precedence over a library preview of the same publication.
  for (const author of authors) {
    const pub: Publication = { name: author, author, url: `https://www.tradingview.com/u/${author}/`, pub: `catalog:${author}` };
    try {
      const items: any[] = [];
      for (let page = 1; page <= 20; page++) {
        const data = JSON.parse(await text(`https://www.tradingview.com/api/v1/scripts/?page=${page}&per_page=50&by=${encodeURIComponent(author)}&q=`));
        if (!Array.isArray(data.results)) throw new Error('Invalid publication catalogue');
        items.push(...data.results);
        if (!data.next) break;
        if (page === 20) throw new Error('Publication catalogue exceeded pagination limit');
      }
      const seen = new Set<string>();
      await each(items.filter(r => r.script_access === 1), concurrency, async r => {
        const p: Publication = { name: String(r.name), author, url: String(r.chart_url ?? ''), pub: r.script_id_part, updated: r.updated_at ?? r.created_at };
        const key = keyOf(p);
        if (!uuidOf(p) || !p.pub) { review.issue(p, 'Publication identity is missing', true); return; }
        if (seen.has(key)) return; seen.add(key);
        if (review.retired(p)) { inspectedTV.add(uuidOf(p)!); return; }
        try {
          const src = JSON.parse(await text(`https://pine-facade.tradingview.com/pine-facade/get/${encodeURIComponent(p.pub)}/last?no_4xx=true`));
          if (src.scriptAccess !== 'open_no_auth') { review.issue(p, 'Full public TradingView source is unavailable'); return; }
          let code: string;
          try { code = completeSource(src.source, src.sourcePreview); } catch (e) { review.issue(p, (e as Error).message); return; }
          review.consider({ ...p, version: src.version == null ? null : String(src.version), updated: src.updated ?? p.updated }, code);
          inspectedTV.add(uuidOf(p)!);
        } catch (e) { review.issue(p, (e as Error).message, true); }
      });
      review.issues.delete(keyOf(pub)); log(`${author}: checked ${seen.size} public publications`);
    } catch (e) { review.issue(pub, (e as Error).message, true); log(`${author}: ${(e as Error).message}`); }
    review.save(false);
  }
  if (options.luxalgo !== false) {
    const catalogue: Publication = { name: 'LuxAlgo catalogue', author: 'LuxAlgo', url: SITEMAP, slug: 'catalogue' };
    try {
      const xml = await text(SITEMAP);
      const slugs = [...new Set([...xml.matchAll(/<loc>https:\/\/www\.luxalgo\.com\/library\/indicator\/([^/<]+)\/<\/loc>/g)].map(m => m[1]))];
      if (!slugs.length) throw new Error('LuxAlgo sitemap contains no indicator URLs');
      await each(slugs, concurrency, async slug => {
        let p: Publication = { name: slug, author: 'LuxAlgo', slug, url: `https://www.luxalgo.com/library/indicator/${slug}/` };
        try {
          const html = await text(p.url);
          const match = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>(.*?)<\/script>/s);
          if (!match) throw new Error('LuxAlgo page metadata is unavailable');
          const pp = JSON.parse(match[1])?.props?.pageProps;
          if (!pp?.indicator) throw new Error('LuxAlgo indicator metadata is unavailable');
          const ind = pp.indicator;
          review.issues.delete(keyOf(p));
          p = { ...p, name: ind.name || slug, uuid: ind.tradingviewUuid, updated: ind.updatedAt ?? ind.creationDateDisplayed };
          if (p.uuid && inspectedTV.has(p.uuid)) return;
          if (review.retired(p)) return;
          let code: string;
          try { code = completeSource(pp.pineScriptCode, pp.sourcePreview); } catch (e) { review.issue(p, (e as Error).message); return; }
          review.consider(p, code);
        } catch (e) { review.issue(p, (e as Error).message, true); }
      });
      review.issues.delete(keyOf(catalogue)); log(`LuxAlgo library: checked ${slugs.length} pages`);
    } catch (e) { review.issue(catalogue, (e as Error).message, true); log((e as Error).message); }
  }
  return review.save(review.counts.failed === 0);
}

/** Read-only public requests with a deadline, status checks and bounded transient retry. */
export async function publicText(url: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (VNEdge source review)', Accept: '*/*' }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) {
        if ((r.status === 429 || r.status >= 500) && attempt < 2) {
          await r.body?.cancel();
          const delay = Math.min(30_000, Math.max(1000, Number(r.headers.get('retry-after')) * 1000 || 1000 * (attempt + 1)));
          await new Promise(resolve => setTimeout(resolve, delay)); continue;
        }
        throw new Error(`HTTP ${r.status}: ${url}`);
      }
      const body = await r.text();
      await new Promise(resolve => setTimeout(resolve, 150)); return body;
    } catch (e) {
      if (attempt === 2 || /^HTTP 4\d\d:/.test((e as Error).message)) throw e;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw new Error('Public source fetch exhausted retries');
}

export function acquireSyncLock(root: string): () => void {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'sync.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx'); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
      return () => { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); };
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid source sync lock; inspect before removing it');
      try { process.kill(pid, 0); } catch (error: any) {
        if (error.code === 'ESRCH') { fs.unlinkSync(file); continue; }
        throw error;
      }
      throw new Error(`Source sync already running (PID ${pid})`);
    }
  }
  throw new Error('Could not acquire source sync lock');
}
