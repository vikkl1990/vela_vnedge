import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from author_review_records import load_records, write_catalog_atomic


class ReviewReceipts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'scripts/pine').mkdir(parents=True)
        self.source = self.root / 'scripts/pine/test.pine'
        self.source.write_bytes(b'indicator("x")\nplot(close)\r\n')
        self.page = self.root / 'page.json'
        self.page.write_text(json.dumps({'pageSha256': 'a'*64, 'script': {'version_maj': 1}, 'updated_at': '2026-01-01'}))
        (self.root / 'inventory.json').write_text(json.dumps([{'key': 'pub', 'url': 'https://www.tradingview.com/script/pub/', 'page': str(self.page), 'manifest': [{'file': 'test.pine'}]}]))
        self.record = {'key': 'pub', 'status': 'reviewed', 'reviewedAt': '2026-01-02T00:00:00Z', 'reviewVersion': 1,
            'reviewUpdatedAt': '2026-01-01', 'pageSha256': 'a'*64, 'role': 'context', 'summary': 'A context series.',
            'requirements': 'No autonomous entry.', 'sourceFiles': ['test.pine'], 'sourceChecked': True,
            'sourceHashes': {'test.pine': hashlib.sha256(self.source.read_bytes()).hexdigest()}, 'findings': []}

    def write(self, record):
        (self.root / 'reviews-1.jsonl').write_text(json.dumps(record)+'\n')

    def test_only_pinned_substantive_receipts_are_accepted(self):
        self.write(self.record)
        reviewed, blocked = load_records(self.root, self.root)
        self.assertEqual(list(reviewed), ['pub'])
        self.assertEqual(blocked, {})
        for field, value in [('pageSha256', 'b'*64), ('reviewVersion', 2), ('reviewUpdatedAt', None),
            ('sourceHashes', {}), ('sourceFiles', ['other.pine']), ('sourceChecked', False), ('summary', ''),
            ('reviewedAt', '2026-01-01'), ('status', 'retrieved')]:
            r = copy.deepcopy(self.record); r[field] = value; self.write(r)
            with self.subTest(field=field), self.assertRaises(ValueError):
                load_records(self.root, self.root)
        self.write(self.record)
        self.source.write_bytes(self.source.read_bytes().replace(b'\r\n', b'\n'))
        with self.assertRaisesRegex(ValueError, 'Source changed'):
            load_records(self.root, self.root)

    def test_blocked_and_duplicate_receipts_never_count_as_reviewed(self):
        r={'key': 'pub', 'status': 'blocked', 'blocker': 'Primary page unavailable', 'reviewedAt': '2026-01-02T00:00:00Z'}
        self.write(r)
        reviewed, blocked = load_records(self.root, self.root)
        self.assertEqual(reviewed, {}); self.assertIn('pub', blocked)
        self.assertEqual(blocked['pub']['checkedAt'], r['reviewedAt'])
        (self.root / 'reviews-2.jsonl').write_text(json.dumps(r)+'\n')
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            load_records(self.root, self.root)

    def test_blocked_check_time_is_retained_without_claiming_a_review(self):
        r = {'key': 'pub', 'status': 'blocked', 'blocker': 'Description contains only a title',
            'checkedAt': '2026-01-03T00:00:00Z'}
        self.write(r)
        reviewed, blocked = load_records(self.root, self.root)
        self.assertEqual(reviewed, {})
        self.assertEqual(blocked['pub']['checkedAt'], r['checkedAt'])
        for value in [None, '2026-01-03', '2999-01-03T00:00:00Z']:
            self.write({**r, 'checkedAt': value})
            with self.subTest(value=value), self.assertRaises(ValueError):
                load_records(self.root, self.root)


class AtomicCatalogue(unittest.TestCase):
    def test_replace_failure_keeps_old_catalogue_and_cleans_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'catalog.json'
            write_catalog_atomic(file, {'schema': 1, 'generation': 'old'})
            original = file.read_bytes()
            with patch('author_review_records.os.replace', side_effect=OSError('injected failure')):
                with self.assertRaises(OSError):
                    write_catalog_atomic(file, {'schema': 1, 'generation': 'new'})
            self.assertEqual(file.read_bytes(), original)
            self.assertEqual(list(Path(directory).iterdir()), [file])
            file.chmod(0o640)
            write_catalog_atomic(file, {'schema': 1, 'generation': 'new'})
            self.assertEqual(json.loads(file.read_text())['generation'], 'new')
            self.assertEqual(file.stat().st_mode & 0o777, 0o640)


if __name__ == '__main__':
    unittest.main()
