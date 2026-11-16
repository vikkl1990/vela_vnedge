#!/usr/bin/env python3
"""Remove group/other access inside the bot's data tree; no content changes.

Dry run is the default. Validate the whole tree before mutating. Symlinks are
never followed; external hard links, mount crossings and unexpected owners fail closed.
The only ownership repair allowed is root-owned files within data/logs.
"""
import argparse
import json
import os
import pwd
import stat
from pathlib import Path


def plan(root, owner):
    root = Path(root).absolute()
    first = root.lstat()
    if not stat.S_ISDIR(first.st_mode) or first.st_uid != owner:
        raise ValueError('Data root must be a real directory owned by the service user')
    rows, links, hardlinks = [], 0, {}
    paths = [root]
    for base, dirs, files in os.walk(root, followlinks=False):
        paths.extend(Path(base) / name for name in dirs + files)
    for p in paths:
        s = p.lstat()
        if stat.S_ISLNK(s.st_mode):
            links += 1
            continue
        if s.st_dev != first.st_dev:
            raise ValueError('Data tree crosses a filesystem boundary')
        directory = stat.S_ISDIR(s.st_mode)
        if not directory and not stat.S_ISREG(s.st_mode):
            raise ValueError('Data tree contains a special file')
        if not directory and s.st_nlink > 1:
            entry = hardlinks.setdefault((s.st_dev, s.st_ino), [s.st_nlink, 0])
            entry[1] += 1
        log_file = not directory and root / 'logs' in p.parents
        if s.st_uid != owner and not (s.st_uid == 0 and log_file):
            raise ValueError('Unexpected data owner; inspect before changing permissions')
        mode = 0o700 if directory or s.st_mode & 0o100 else 0o600
        if stat.S_IMODE(s.st_mode) != mode or s.st_uid != owner:
            rows.append((p, s, mode))
    if any(expected != found for expected, found in hardlinks.values()):
        raise ValueError('Data tree contains a hard link outside the protected tree')
    return rows, links


def apply(rows, owner, group):
    # Use no-follow descriptors and verify inode identity. A path replaced since the
    # preflight is rejected, never silently chmod an unrelated file.
    for p, original, mode in rows:
        flags = os.O_RDONLY | os.O_NOFOLLOW
        if stat.S_ISDIR(original.st_mode):
            flags |= os.O_DIRECTORY
        fd = os.open(p, flags)
        try:
            current = os.fstat(fd)
            if (current.st_dev, current.st_ino) != (original.st_dev, original.st_ino):
                raise ValueError('Data path changed during maintenance')
            if current.st_uid != owner:
                os.fchown(fd, owner, group)
            os.fchmod(fd, mode)
        finally:
            os.close(fd)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', default='/opt/vnedge/data')
    parser.add_argument('--owner', default='ubuntu')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    account = pwd.getpwnam(args.owner)
    rows, links = plan(args.data_dir, account.pw_uid)
    if args.apply:
        apply(rows, account.pw_uid, account.pw_gid)
    print(json.dumps({'applied': args.apply, 'changedPaths': len(rows),
                      'symlinksNotFollowed': links, 'fileMode': '0600 (0700 if executable)',
                      'directoryMode': '0700'}))
