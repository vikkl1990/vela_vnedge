"""Reconcile cached public descriptions and prior source study; never changes trading settings.

Usage: python3 ops/build-author-reviews.py --research PATH --study-repo PATH --willy-review PATH
Raw author prose stays in the research cache. Only metadata and analyst-written contracts are published.
"""
import argparse
import collections
import datetime
import hashlib
import json
import re
import subprocess
from pathlib import Path
from author_review_records import load_records


def build(args):
    repo = Path(__file__).resolve().parents[1]
    research = Path(args.research)
    manifest = json.loads((repo / 'scripts/manifest.json').read_text())
    study = [json.loads(s) for s in (research / 'prior-source-contracts.jsonl').read_text().splitlines()]
    revision = subprocess.check_output(['git', 'rev-parse', 'origin/script-study'], cwd=args.study_repo, text=True).strip()
    tree = subprocess.check_output(['git', 'ls-tree', '-r', revision, 'scripts/pine'], cwd=args.study_repo, text=True)
    blobs = {r.split('\t', 1)[1].removeprefix('scripts/pine/'): r.split()[2] for r in tree.splitlines()}
    sources = {}
    for c in study:
        file = c['file']
        if file in sources:
            raise ValueError('Duplicate source-study contract: ' + file)
        current = repo / 'scripts/pine' / file
        b = current.read_bytes() if current.exists() else b''
        git_hash = hashlib.sha1(b'blob ' + str(len(b)).encode() + b'\0' + b).hexdigest()
        if git_hash != blobs.get(file):
            b = subprocess.check_output(['git', 'show', f'{revision}:scripts/pine/{file}'], cwd=args.study_repo)
        sources[file] = dict(
            sha256=hashlib.sha256(b).hexdigest(), reviewedAt='2026-11-12',
            **{k: c[k] for k in ['type', 'idea', 'entries', 'notEntries', 'stop', 'targets', 'exit', 'timing']},
            claims=[dict(scannerId=x.get('id'), **{k: x.get(k) for k in ['marker', 'problem', 'line', 'evidence']}) for x in c.get('botMisreads', []) if x.get('check') == 'confirmed'])
    for record in json.loads((research / 'new-source-contracts.json').read_text()):
        record = dict(record)
        file = record.pop('file')
        if file in sources:
            raise ValueError('New review must not overwrite an earlier source contract: ' + file)
        if hashlib.sha256((repo / 'scripts/pine' / file).read_bytes()).hexdigest() != record['sha256']:
            raise ValueError('Source changed since the new review: ' + file)
        sources[file] = record
    reviews = {}
    for file in [Path(args.willy_review), repo / 'docs/research/bigbeluga-author-review-2026-11-13.json']:
        for r in json.loads(file.read_text())['scripts']:
            reviews[r['id']] = dict(reviewedAt=r['verifiedAt'], role=r['role'],
                summary=r.get('authorIntent') or r.get('entry'),
                requirements=r.get('botGapOrRequiredTreatment') or ' '.join([r.get('exits', ''), r.get('timing', ''), r.get('recommendation', '')]),
                reviewVersion=r.get('publicationVersion'), reviewUpdatedAt=r.get('latestPublication'))
    # Individually reconciled here, not inferred from page retrieval or a generated title classification.
    supplemental = json.loads((research / 'supplemental-reviews.json').read_text())
    for key, r in supplemental.items():
        if not r.get('reviewedAt') or 'reviewVersion' not in r or 'reviewUpdatedAt' not in r:
            raise ValueError('Manual review needs pinned publication revision and review time: ' + key)
        reviews[key] = dict(r)
    blocked = {}
    if args.review_receipts:
        completed, blocked = load_records(args.review_receipts, repo)
        if set(completed) & set(reviews):
            raise ValueError('A completion receipt would replace an existing author review')
        reviews.update(completed)
    publications = {}
    scripts = {}
    notes = json.loads((research / 'integration-notes.json').read_text())
    lux_pages = {p['url']: p for f in (research / 'lux-pages').glob('*.json') for p in [json.loads(f.read_text())]}
    for m in manifest:
        match = re.search(r'/script/([A-Za-z0-9]+)(?:-|/)', m.get('url') or '')
        key = match[1] if match else m.get('url') or None
        scripts[m['id']] = dict(file=m['file'], publication=key, integrationNotes=notes.get(m['id'], []))
        if not key or key in publications:
            continue
        p = research / 'pages' / (key + '.json') if match else research / 'lux-pages' / (m['id'] + '.json')
        page = (json.loads(p.read_text()) if p.exists() else {}) if match else lux_pages.get(key, {})
        publication = dict(url=page.get('url') or m.get('url'), author=page.get('author'),
            retrievedAt=page.get('verifiedAt'), updatedAt=page.get('updated_at') or page.get('created_at'),
            version=(page.get('script') or {}).get('version_maj'),
            reviewedAt=None, role=None, summary=None, requirements=None, reviewVersion=None, reviewUpdatedAt=None)
        if key in reviews:
            publication.update(reviews[key])
        if key in blocked:
            publication['reviewBlocker'] = blocked[key]
        publications[key] = publication
    catalog = dict(schema=1, generatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
        sourceStudy=dict(revision=revision, path='docs/research/script-study-2026-11-12/contracts.jsonl',
            limitation='Prior line-by-line study, not a fresh independent audit. Original verdicts and unchecked/refuted claims are not runtime approvals.'),
        scripts=scripts, sources=sources, publications=publications)
    (repo / 'scripts/author-reviews.json').write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')) + '\n')
    counts = collections.Counter()
    for m in manifest:
        c = sources.get(m['file'])
        file = repo / 'scripts/pine' / m['file']
        status = 'no_source_contract' if not c else 'source_matches' if file.exists() and hashlib.sha256(file.read_bytes()).hexdigest() == c['sha256'] else 'source_changed_or_missing'
        counts[status] += 1
    print(json.dumps(dict(manifestEntries=len(manifest), reviewedSourceFiles=len(sources),
        publicationPages=len(publications), retrieved=sum(bool(p['retrievedAt']) for p in publications.values()),
        authorDescriptionsReviewed=sum(bool(p['reviewedAt']) for p in publications.values()), counts=counts), indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--research', required=True)
    parser.add_argument('--study-repo', required=True)
    parser.add_argument('--willy-review', required=True)
    parser.add_argument('--review-receipts', help='Checkpointed, source-pinned author review directory')
    build(parser.parse_args())
