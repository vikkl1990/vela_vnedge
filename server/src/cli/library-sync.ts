/**
 * Review full sources from all seven publishers and LuxAlgo, including known publications.
 * OUT=data writes the VM's data/library/updates; otherwise scripts/updates.
 * DRY=1 performs the same checks without writing files or taking a writer lock.
 * New/revised sources are staged here, outside the scanner registry. After runtime,
 * signal and evidence review, import them under a separate reviewed identity.
 */
import {scanCatalogue,type CatalogueReport} from '../library/catalogue.ts';
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
  if(process.env.CATALOGUE_ONLY==='1'){
    const file=path.join(updates,'catalogue.json');
    const previous:CatalogueReport|undefined=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):undefined;
    const report=await scanCatalogue(known,publicText,previous);
    if(!dry){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(report,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);}
    console.log(JSON.stringify({at:report.at,complete:report.complete,publications:report.publications.length,changes:report.changes.length,issues:report.issues,note:'Metadata only; no scanner or account configuration changed. Weekly sync verifies sources.'}));
    if(!report.complete)process.exitCode=1;
  }else{
  const review = new SourceReview(known, updates, dry);
  const report = await syncSources({ review, text: publicText, log: console.log,
    authors: process.env.AUTHORS === undefined ? AUTHORS : process.env.AUTHORS.split(',').map(a => a.trim()).filter(Boolean) });
  console.log(`${dry ? 'Dry run' : 'Source review saved'}: ${JSON.stringify(report.counts)}`);
  console.log(`${report.candidates.length} candidates · ${report.issues.length} source issues · ${path.join(updates, 'review.json')}`);
  if (!report.complete) process.exitCode = 1;
  }
} finally { release(); }
