"""Validate human/agent-written review receipts; retrieval never implies review.

No raw author prose is copied into the catalogue. A receipt is accepted only for
the precise cached publication and inspected source bytes named by its queue.
"""
import datetime
import hashlib
import json
import re
from pathlib import Path


def load_records(directory, repo):
    directory, repo = Path(directory), Path(repo)
    inventory = json.loads((directory / 'inventory.json').read_text())
    queued = {x['key']: x for x in inventory}
    if len(queued) != len(inventory):
        raise ValueError('Duplicate publication in review inventory')
    reviewed, blocked = {}, {}
    for file in sorted(directory.glob('reviews-*.jsonl')):
        for line in file.read_text().splitlines():
            r = json.loads(line)
            key = r.get('key')
            if key not in queued or key in reviewed or key in blocked:
                raise ValueError(f'Unknown or duplicate review receipt: {key}')
            if r.get('status') == 'blocked':
                if not r.get('blocker'):
                    raise ValueError(f'Blocked review requires a reason: {key}')
                blocked[key] = {'blocker': r['blocker'], 'checkedAt': r.get('reviewedAt')}
                continue
            if r.get('status') != 'reviewed':
                raise ValueError(f'Unknown review status: {key}')
            timestamp = datetime.datetime.fromisoformat(r['reviewedAt'].replace('Z', '+00:00'))
            if timestamp.tzinfo is None or timestamp > datetime.datetime.now(datetime.timezone.utc):
                raise ValueError(f'Review requires an actual timezone-aware receipt: {key}')
            page_path = queued[key].get('page')
            snapshot = r.get('pageSnapshot')
            if snapshot:
                if page_path and Path(page_path).is_file():
                    raise ValueError(f'Cannot replace a pinned publication cache: {key}')
                page_path = Path(snapshot).resolve()
                if not page_path.is_relative_to(directory.resolve()):
                    raise ValueError(f'Page snapshot must belong to this review: {key}')
            if not page_path or not Path(page_path).is_file():
                raise ValueError(f'Unavailable publication cannot be marked reviewed: {key}')
            page = json.loads(Path(page_path).read_text())
            if snapshot and (page.get('url') != queued[key]['url'] or page.get('retrievalMethod') != 'web-primary-rendered-text'
                or not page.get('verifiedAt') or hashlib.sha256(page.get('rawText', page.get('description', '')).encode()).hexdigest() != page.get('pageSha256')):
                raise ValueError(f'Invalid primary-page snapshot: {key}')
            revision = (page.get('script') or {}).get('version_maj')
            updated = page.get('updated_at') or page.get('created_at')
            if not re.fullmatch('[a-f0-9]{64}', r.get('pageSha256', '')) or r['pageSha256'] != page.get('pageSha256') or r.get('reviewVersion') != revision or r.get('reviewUpdatedAt') != updated:
                raise ValueError(f'Publication changed since review: {key}')
            for field in ('role', 'summary', 'requirements'):
                if not isinstance(r.get(field), str) or not r[field].strip():
                    raise ValueError(f'Missing substantive {field}: {key}')
            if not isinstance(r.get('sourceChecked'), bool):
                raise ValueError(f'Missing source inspection status: {key}')
            hashes = r.get('sourceHashes', {})
            allowed = {m['file'] for m in queued[key]['manifest']}
            files = r.get('sourceFiles', [])
            if set(files) - allowed or set(hashes) - set(files):
                raise ValueError(f'Inspected source belongs to a different publication: {key}')
            if r['sourceChecked'] and (not files or set(hashes) != set(files)):
                raise ValueError(f'Inspected sources require pinned hashes: {key}')
            if not r['sourceChecked'] and hashes:
                raise ValueError(f'Uninspected sources cannot carry inspection hashes: {key}')
            for name, digest in hashes.items():
                if hashlib.sha256((repo / 'scripts/pine' / name).read_bytes()).hexdigest() != digest:
                    raise ValueError(f'Source changed since inspection: {key}/{name}')
            findings = r.get('findings')
            if not isinstance(findings, list):
                raise ValueError(f'Findings must be explicit, including an empty list: {key}')
            for f in findings:
                if any(not isinstance(f.get(k), str) or not f[k].strip() for k in ('kind', 'marker', 'evidence', 'action')):
                    raise ValueError(f'Finding lacks evidence or treatment: {key}')
                if f.get('sourceLine') is not None and (not isinstance(f['sourceLine'], int) or f['sourceLine'] < 1):
                    raise ValueError(f'Invalid source line: {key}')
            reviewed[key] = {k: r[k] for k in ('reviewedAt', 'reviewVersion', 'reviewUpdatedAt', 'role', 'summary', 'requirements')}
            if snapshot:
                reviewed[key].update(retrievedAt=page['verifiedAt'], author=page.get('author'), version=revision, updatedAt=updated)
            reviewed[key]['reconciliation'] = {
                'pageSha256': r['pageSha256'], 'sourceChecked': r['sourceChecked'],
                'sourceHashes': hashes, 'scope': r.get('sourceInspectionScope', 'Relevant conditions and lifecycle branches; prior full-source study remains separate.'),
                'findings': findings,
            }
    return reviewed, blocked
