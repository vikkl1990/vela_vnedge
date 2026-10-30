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
