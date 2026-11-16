import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('private_data', Path(__file__).with_name('private-data.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrivateDataTests(unittest.TestCase):
    def test_private_idempotent_and_preserves_contents_and_executable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'data'
            root.mkdir(mode=0o755)
            file = root / 'config.json'
            file.write_text('{"paper":"unchanged"}')
            file.chmod(0o644)
            executable = root / 'research.sh'
            executable.write_text('#!/bin/sh\nexit 0\n')
            executable.chmod(0o755)
            outside = Path(temp) / 'outside'
            outside.write_text('do not change')
            outside.chmod(0o644)
            (root / 'link').symlink_to(outside)
            rows, links = module.plan(root, os.getuid())
            self.assertEqual(links, 1)
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o644, 'planning is read-only')
            module.apply(rows, os.getuid(), os.getgid())
            self.assertEqual(file.read_text(), '{"paper":"unchanged"}')
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(executable.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o644)
            self.assertEqual(module.plan(root, os.getuid())[0], [])

    def test_internal_hardlinks_remain_usable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            file = root / 'binary'
            file.write_text('retained binary')
            file.chmod(0o755)
            os.link(file, root / 'second-name')
            rows, _ = module.plan(root, os.getuid())
            module.apply(rows, os.getuid(), os.getgid())
            self.assertEqual((root / 'second-name').read_text(), 'retained binary')
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o700)
            self.assertEqual(module.plan(root, os.getuid())[0], [])

    def test_hardlinks_and_replaced_paths_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'data'
            root.mkdir()
            file = root / 'config.json'
            file.write_text('original')
            file.chmod(0o644)
            rows, _ = module.plan(root, os.getuid())
            file.rename(root / 'original')
            file.write_text('replacement')
            with self.assertRaisesRegex(ValueError, 'changed'):
                module.apply(rows, os.getuid(), os.getgid())
            os.link(file, Path(temp) / 'hardlink-outside')
            with self.assertRaisesRegex(ValueError, 'hard link'):
                module.plan(root, os.getuid())


if __name__ == '__main__':
    unittest.main()
