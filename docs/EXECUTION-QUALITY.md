# Execution quality and accounting coverage

GET /api/execution-quality (dashboard authentication required) returns funding, depth and account audit coverage. This does not change scanner selection, leverage or entry gates.

Funding now has a durable expected-settlement journal. Fresh pre-boundary funding observations (at most 120 seconds old) and marks within ten seconds of the boundary drive simulated charges. Rates are percentages. These are simulated settlements, not authenticated exchange cashflows. Missing observations remain unresolved. Historical FUNDING:/MARK: candles are staged as unverified candidates, never automatically charged. Coverage begins at the first persisted schedule, not before this deployment.

A late settlement reconstructs position quantity at its timestamp, including positions subsequently closed. Persisted funding fills prevent duplicates across retries/restarts. Corrections update accounting without repeating execution or trade-close events. Past equity snapshots are not restated; current balance includes the adjustment.

After independently verifying actual settlement rates and boundary marks, operators can import JSON records with symbol, at (epoch milliseconds), ratePct, markPrice and evidence using:

    node server/src/cli/funding-import.ts --apply /absolute/path/vnedge.db /absolute/path/verified-settlements.json

The import is atomic, rejects already-applied slots and queues corrections for the running scheduler. Do not use a candle close alone as settlement evidence. Exchange wallet entries must not be imported as percentage rates.

Authenticated non-dry-run executors retrieve individual fills and wallet transactions in paginated windows. The initial window starts approximately 65 minutes before activation, then catches up incrementally with a five-minute overlap. Only successful complete windows advance coverage. Host and record identity prevent duplicate/testnet-production mixing. Raw commissions retain their currency and maker/taker role. Terminal order quantities are compared only when the history window covers their lifetime. Taxes, promotions and currency conversions still require explicit reconciliation; this ledger never books cashflows into paper twice. Paper mode without an executor does not query private account history.

BTC/ETH/SOL depth and trades are recorded separately from fill simulation. Sequence, timestamp, checksum and crossed-book checks detect invalid data and request a fresh snapshot. Storage is bounded to 24 hours, 50,000 events and 32 MiB of payload; dropped observations and disconnects create gaps. Replay requires a retained snapshot and all subsequent sequence updates. This does not prove queue priority or automatically change maker fills.

Post-only payload support rejects market orders, invalid prices and non-GTC orders. Existing production market-only protection remains in force; this support does not enable production maker execution.

L1 quotes now drive executable pricing when healthy. The quality endpoint includes
`fillSource` and `quotes`: observed count, fresh L1/fallback counts, and rows with
source, bid/ask sizes, publication/receive timestamps, last book change and age.
An unchanged book's old change timestamp does not invalidate a fresh publication.
Ticker fallback is explicit; the quote-age policy is unchanged. These counts cover
observed quotes, not a guarantee that every subscribed market has delivered one.
The UI displays the configured fill mode separately; faster quotes do not silently
switch candle-based paper fills to tape mode.

For isolated execution comparisons, import `compareExecution` from
`server/src/paper/executionReplay.ts` with a config snapshot and receipt-ordered
`ExecutionObservation[]`. Supported observations are entry, quote, trade, candle,
disconnect and clock. The helper returns candle/tape decisions, fills, commissions,
realized net and remaining open/pending counts. Only supplied signals are replayed;
portfolio gates, exchange queue position, depth fills and actual funding cashflows
are outside this helper. Never interpret an unclosed position as a zero-return trade.

When an exchange executor is attached, every new account fill also writes an
`execution_commands` row inside the same SQLite transaction. The in-memory order
event only wakes dispatch; startup and periodic sweeps recover missed notifications.
Commands have a persisted client ID and are scoped by host and dry-run/live writer.
Plain paper, shadow and historical orders are not imported into this queue.

The order ledger takes over once an intent exists. Even a missing lookup result
does not authorize another order POST. Delta documents client IDs as unique among
open orders, not as permanent idempotency keys:
https://docs.delta.exchange/#get-order-by-client-oid

Unsent entry commands expire after `execution.entryCommandMaxAgeSec` (default 60,
valid range 1–300 seconds); expiry does not apply after a ledger intent exists.
Exits do not expire. A missing product catalog is retried; earlier uncertain
outcomes on the same position are reconciled before another exit is sent. A pending
exit only reduces confirmed exposure still missing from the paper book. Flattening
cancels unsent entry commands so they cannot reopen exposure afterward.

GET /api/execution exposes `outbox` counts and recent commands; the Exchange page
calls this Execution handoff. Delivered means reconciled or owned by the ledger,
not a confirmed fill. Rejected counts are historical handoff outcomes. A waiting
command older than one minute appears in attention with a link to Exchange.
Dry-run records written by older versions cannot be reliably distinguished from
live records on the same host; reconcile any legacy exchange database before
enabling a real writer. Current paper-only databases have no such exchange rows.

Validation includes transaction rollback, lost events, catalog outages, delayed
acceptance, flattening, TP recovery, and SIGKILL before/after the paper commit,
leverage call, ledger intent, exchange acceptance, fill acknowledgement and handoff.
These are process-crash tests against deterministic exchange fixtures. They do not
establish durability through host power loss, exchange queue priority, account-key
identity isolation, full partial-fill cash reconciliation, or native production
protection. Those remain separate work.
