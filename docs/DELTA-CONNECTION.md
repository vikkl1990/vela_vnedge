# Delta India connection

The administrator can save and check a Delta India API key at **Settings → Delta India connection** (`/settings#delta-connection`). The Exchange page links to it. Select the environment where the key was created, enter its API key and secret, then choose **Save and check**. Use a key with Read Data permission and add the bot server's outbound IP to Delta's allowlist where required.

The check makes signed GET requests to wallet balances and margined positions on the selected official production or testnet host. Both must return the expected array payload. It reports authentication/read access, not trading permission or live readiness. No order, cancellation, leverage, wallet transfer or account-setting operation is sent. Saving does not modify paper configuration, executor environment credentials, or execution mode.

## Storage and access

- All connection routes, including metadata reads, require administrator access. Use HTTPS or the local SSH tunnel. The browser form is disabled on non-local HTTP; the server also enforces transport, same-origin and JSON request checks.
- Credentials are stored in `data/secrets/delta-connection.json`, with a 0700 directory and 0600 file owned by the service user. This is a private plaintext credential file, not an encrypted vault. Restrict server and disk-backup access accordingly. The path follows `VNEDGE_DATA_DIR` on deployments.
- Writes replace the file atomically. Symlinks, foreign ownership and group/world-readable files are refused. Secrets are excluded from Git, config responses, the application database and its SQLite backups. Whole-machine backups remain an operator responsibility.
- API responses return only configuration metadata and a sanitized check result. They never return the key, secret, balances, positions or raw exchange errors. HTTP redirects are rejected by the REST client. The dashboard clears inputs after submission and does not put credentials in query/mutation caches or browser storage.
- Replacement/removal invalidates an in-flight check. Checks coalesce for the same credential revision and are limited to one new check per five seconds. Last-check results are memory-only and reset after a server restart.
- **Remove saved credentials** deletes this connection's local file. Revoke the key separately in Delta if needed. Environment credentials used by a separately configured executor are unaffected.

## Related fixes in this release

Following the [Delta support study](research/delta-support-study-2026-11-07.md), maintenance completion now invalidates old product status and requests a fresh catalogue immediately. In-flight results from before recovery cannot reopen entry admission. Fee history preserves a whitelist of numeric credit/commission metadata, with missing values kept unknown; it does not automatically subtract promotional credits from trading costs.

## Validation — 7 November 2026

- 958 server tests passed, including persistence, permissions, error redaction, fixed-host signed GETs, replacement races, real HTTP authorization, unchanged paper configuration, and maintenance recovery during an in-flight catalogue request.
- 7 dashboard tests passed; dashboard lint and production build passed.
- Full server type checking retains the same 16 pre-existing diagnostics described in the rollout plan, with no diagnostics in the changed connection/recovery/account-audit modules. This remains a live-certification prerequisite.
- Real credential validity is established only after the operator enters a key and the authenticated check succeeds. Saving a key is not authorization to enable real trading.

The [phased rollout](GO-LIVE-ROLLOUT.md) remains the path to live execution. This connection panel supplies a read-only credential check, not lifecycle certification or an automatic launch.
