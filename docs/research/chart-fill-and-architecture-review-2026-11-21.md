# Chart/fill verification and architecture review — 21 November 2026

Baseline: deployed main `025be3d`. The supplied architecture review describes its parent `fd7a63f`.
Checks used current source, read-only VM queries and a private snapshot of selected execution records.
No execution, capital, risk, evidence or promotion configuration was changed.

## Measured chart and fill results

- The snapshot contains 205 selected positions and 410 order fills. It includes the latest 200 closed account/shadow positions plus recent SOL maker research positions; it is not the entire journal.
- 285 fills have a reproducible saved depth price: 258 match exactly and 27 market entries differ. All 27 are conservatively worse than the saved depth VWAP; an entry reference-price floor, tick rounding and configured impact can cause this. They remain labelled differences, not automatically certified or counted as profitable improvements.
- No reproduced exit price differs from its saved depth. The remaining 125 fills lack an exact executable-depth benchmark, including passive makers and older candle/quote models. Unknown coverage is not a pass.
- SOL tick/depth, candle, filter-on and filter-off arms have one common closed signal in this snapshot. The six research positions are not six independent observations. Each filled 11 contracts at 67.2558 and exited on a trail: net +$4.9119704832, no SL. Tick/depth was observed 125 ms before the paired candle fill.
- Each of the three tick/depth arms retained the same 50-contract public print, fresh arrival depth and fresh fill depth supporting 11 contracts. These are independent research books, so the repeated print is not account liquidity reuse. Exchange queue priority remains unknown.
- The account maker entry was 13.552 seconds later at a different limit, 67.3698. Its +$6.1656745392 result is not a matched comparison with those research arms. No paper model change is justified from this event.
- Trend Impulse draws Bullish Step and Bearish Step twice. The runtime retains distinct output keys, but the original receipt reduced them to identical display titles and incorrectly marked the output set truncated. The correction keeps runtime keys for diagnostics and leaves reader titles untouched.
- Refetched SOL candles had the same latest OHLC but different volume: 28,844 versus the scanner receipt's 28,850 on 15m, and 131,423 versus 131,429 on 1h. Equal start times are insufficient to prove equal inputs.

## Tested corrections

1. Preserve runtime output keys in chart receipts, including same-title shapes. Ambiguous legacy data still cannot certify agreement.
2. Hash the complete primary closed OHLCV window on both sides using SHA-256. Different history windows or candles are reported before comparing outputs. Old receipts without a hash stay unverified until a new scan. Forming bars are excluded.
3. Validate passive maker report linkage, print timing/quantity, post-only arrival and full-size fresh depth before saying the recorded model is consistent. This never claims exchange queue proof.
4. Refuse an exit benchmark when retained depth covers less than the recorded executable quantity.

These changes only improve diagnostics. A chart disagreement never changes admission. Signal readers, scan allocations, policy identities and execution settings are unchanged. External requested series, alerts, labels and author ledgers still need their own parity coverage.

## Architecture review: verdict

The component map is useful and most boundary concerns are correct. It is not an execution certification or an explanation of recent losses: the supplied document explicitly did not re-derive exit formulas, trace all pool scheduling or promotion predicates, or inspect deployed services.

### Confirmed priorities

| Priority | Finding | Current evidence and next implementation |
| --- | --- | --- |
| 1 | Invalid config silently becomes defaults | `ConfigStore.read` catches JSON/read failures and merges an empty object over defaults. Distinguish missing first-run config from an unreadable existing file. Fail startup on invalid persisted config; keep the last valid in-memory config on a failed reload and alert. Test malformed, unreadable and truncated files without silently rewriting them. |
| 1 | Fatal errors can leave a healthy-looking process | `App` catches `uncaughtException`, records text and continues; `health()` still reports `ok`. Add a degraded/unready state, stop new admission, preserve diagnostic state, and use bounded shutdown/restart. Fault-inject before/after position commits and during exit settlement. Recovery must not create downtime fills. |
| 1 | Operational endpoints bypass secret/auth boundaries | Raw metrics return HTTP 200 without a session on the VM; JSON metrics and config return 401. Legacy Telegram config is returned to any authenticated reader if populated. Route metrics through explicit authentication and redact legacy secrets on both GET and PUT responses without overwriting stored secrets with redaction placeholders. |
| 2 | Research children inherit the parent environment | Both Pine workers and screen jobs spread `process.env`. Use a tested allow-list. This alone is not a sandbox: children running under the same OS user can still read secret files and the database. Separate credentials/filesystem access before treating arbitrary script execution as isolated. |
| 2 | Construction, startup and shutdown are mixed | Constructor-started audit/context work and realtime timers are confirmed. Move side effects into idempotent lifecycle methods with cleanup for partial startup. Test port conflicts, failed feed startup and repeated stop calls. |
| Before live | Paper and exchange execution have different capabilities | An attached executor disables resting account entries; production rejects non-market orders and requires reduce-only exits. `wireRealtime` currently disables causal exits for **both** books outside paper mode. An explicit backend/capability contract and execution-policy identity are needed; a new mode enum alone will not establish parity. |
| Before live | Non-paper inbox recovery requires reconciliation | A pending recovered receipt is refused outside paper mode. Define terminal/reconciled outcomes linked to existing outbox and venue records. Do not re-enter an old signal just to clear the pending row. Test every crash boundary with venue lookup and partial fills. |
| 3 | Session and response contracts need hardening | Sessions contain usable cookie values in SQLite and backups. Migrate to hashed session tokens with explicit expiry/revocation behavior. Expand shared response contracts or runtime validation for changed APIs. |

### Corrections to the supplied review

- **Random client IDs do not prove duplicate commands.** `execution_commands.source_order_id` and `client_order_id` are both UNIQUE, and the outbox insert shares the fill transaction. The source-order constraint was omitted from the criticism. Recovery of an ambiguous venue acknowledgement still needs testing, but deterministic IDs are not a substitute for these existing transactional guarantees.
- **There is no confirmed current legacy-token disclosure.** The VM's legacy `alerts.telegram.botToken` is empty and its protected Telegram secret file exists. The endpoint defect is real when legacy credentials are present; no secret values were printed in this verification.
- **Two fleet managers are not currently competing.** On the VM incubator is enabled and auto-tune is disabled. Code suppresses auto-tune when incubator is enabled. A single policy writer is a maintainability improvement, not a measured cause of the current signal decline.
- **Paper and shadow do not have identical size mechanics.** They share an engine but ordinary shadow uses research sizing and executable quantities derived from account sizing. Comparisons must match the frozen policy and executable quantity, not raw shadow dollars.
- **Scheduling already has controlled priorities.** The pool has live, mirror, shadow and background tiers, reserved account capacity and expiration handling. The 500-live-queue guard exists, but the review did not establish that it occurred or caused missing signals on this VM.
- **The latest exit work is newer than the review.** Main `025be3d` added causal partial-target/early/stale exit handling and chart/fill receipts after `fd7a63f`. Review those implementations and current tests rather than treating the older trace as complete.
- **The large chart bundles are lazy dependencies.** The current production entry chunk is about 460 KB raw / 146 KB gzip. The roughly 1.17 MB and 1.87 MB chunks exist, but their size is not the initial dashboard payload.
- **No microservice rewrite is established as necessary.** First measure event-loop delay, SQLite lock/write latency and scan deadlines under peak load. A single writer and isolated research scheduling remain practical; splitting services without durable handoff/recovery tests adds failure paths.

## Development order

1. Ship the tested chart/fill diagnostic corrections from this audit.
2. Implement config failure behavior, endpoint redaction/authentication and process health/failure handling as bounded changes with rollback tests.
3. Isolate child-process credentials and clean lifecycle ownership; measure peak load and database stalls.
4. Before live activation, build one capability-aware execution contract, reconcile every durable command state, and prove paper-versus-venue fill/partial/exit behavior.
5. Consolidate fleet policy ownership and API contracts after operational correctness is measured.

This ordering does not loosen gates, risk caps or evidence requirements. None of the architecture recommendations has been implemented merely by writing this review.

## Validation

- Full server suite: 1,784 passed.
- Browser suite: 66 application checks plus two isolated runs of the actual SOL maker source on desktop/phone, 68 passed. The SOL source run used identical captured candles in both runtimes and includes the author's duplicated step glyphs. It establishes output parity for that input window, not parity for later revised REST candles.
- Read-only journal audit: all three retained SOL tick/depth maker reports pass the stricter model checks; no reproduced exit price mismatch.
- Server/dashboard type checks, dashboard build/lint and pure-logic checks are required before release.
