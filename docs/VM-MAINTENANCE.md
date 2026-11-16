# VN EDGE runtime and private data

Production services use Node 24.22.3 LTS, pinned in `.node-version`. The checksums
in `ops/node-lts-sha256.json` come from the official Node release directory.
Install the matching archive under `/opt/vnedge-runtime/`, owned by root. Do not
replace the host's global Node binary: other applications share this VM.

All three services (main, incubator and library sync) use the corresponding
`ops/systemd/*.runtime.conf.in` drop-in. Replace `@RUNTIME@` with the absolute
versioned runtime directory, install as `runtime.conf` under each service's
`/etc/systemd/system/<name>.service.d/`, then reload systemd. Their PATH uses the
same runtime for child processes. The library job invokes that runtime's npm.

`ops/service-entrypoint.sh` opens logs as the service user and execs Node. This
avoids root-owned files from systemd's `StandardOutput=append`. The wrapper and
units use umask 0077. Config replacement, database creation and database backup
also explicitly create private files when invoked outside systemd.

## Maintenance procedure

1. Verify official release checksums and test the full suite on the new runtime
   in a separate checkout with a scratch `VNEDGE_DATA_DIR`. Validate a database
   snapshot read-only with the new SQLite runtime. Never run tests on live data.
2. Record hashes of configuration and credential files without printing contents.
   Save the previous commit, service/drop-in/logrotate files, a permission
   manifest and a consistent SQLite backup in a private maintenance directory.
3. Run `sudo python3 ops/private-data.py` to preflight permissions. It rejects
   unexpected owners, external hard links, special files and mount crossings.
   Symlinks are skipped; internal hard links and owner-executable files survive.
4. Deploy the tested code and build the dashboard with the pinned Node. While
   the services are stopped, apply `sudo python3 ops/private-data.py --apply`.
   This changes only permissions/ownership, never configuration or journal data.
   Directories become 0700, regular files 0600, executables 0700. Only root-owned
   log files may be reassigned to the service account.
5. Install the runtime drop-ins and `ops/systemd/vnedge.logrotate` as
   `/etc/logrotate.d/vnedge`. Validate with `systemd-analyze verify` and
   `logrotate --debug /etc/logrotate.conf`. Restart once between close bursts.
6. Verify the running `/proc/<pid>/exe`, all three unit commands and umasks,
   authenticated health, fresh scans, private log ownership, unchanged config
   hashes and paper mode. Exercise log rotation and verify continued writes.
   The copytruncate rule retains seven rotations; `maxsize` supplements daily
   rotation rather than replacing it.

Rollback: restore previous code and runtime drop-ins, reload systemd and restart
once. Keep private permissions; if restoring the previous append logging unit,
existing log files must remain writable by ubuntu. Restore a permission manifest
only for a demonstrated compatibility issue. Do not restore a stale database or
config over new trades. Preserve the previous runtime until verification passes.

The maintenance does not change paper/live mode, margin, sizing, entry/exit
logic, risk caps, evidence rules or scheduled job timings. File permissions
protect against other Unix users, not applications running as the same user.

References: [Node release status](https://nodejs.org/en/about/previous-releases),
[release checksums](https://nodejs.org/dist/v24.22.3/SHASUMS256.txt).
