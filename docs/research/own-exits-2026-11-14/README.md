# Own exits (14 Nov 2026)

How to grade a script by its own ledger and put its entry-plus-exit pair into the shadow book. Decision 266.

## 1. Grade scripts

```bash
printf 'norn-weave-thurisaz\ndema-atr-strategy\n' > ids.txt
IDS=ids.txt MARKETS=BTCUSD,ETHUSD TFS=1h,4h OUT=ownledger.json node --no-warnings server/src/cli/ownledger.ts
```

Read-only on the bot: it fetches public candles and runs each script in a worker process. On the VM wrap it in
`systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0 nice -n 19` with `CONCURRENCY=2`.

A row marked `*` passed every gate. Otherwise the row ends with the gates that failed:
`sample`, `open-trades`, `delay`, `halves`, `drift`, `significance`, `fills`, `sides`.

## 2. Propose shadow plans

```bash
CONFIG=config-copy.json OUT=own-exits-plans.json node --no-warnings server/src/cli/ownexitsplans.ts
```

Writes the plans to add and the ones that do not fit in the research capacity. Nothing is applied. Applying is a separate
step through the config route, and each plan is a shadow research cell.

## 3. Read the result

The shadow book already runs the same cell under the account's recipe. The own-exits plan is a different policy on the same
signals, so the comparison is the forward R of the plan against the recipe cell, per script. One quarter of forward data on
ten scripts will not separate a real +50 bps edge from noise; it can only reject the ones that do not hold.

## Not covered

- Funding on multi-day holds (shadow charges it; the grader does not).
- Stop-and-reverse reentry inside the shadow engine for scripts without a native reader: a reversal arrives as an entry on
  the other side while a position is open. Check each survivor's first plan trades against its own ledger before trusting R.
- Sizing: wide stops mean lower leverage than the bot uses now; the 3% ceiling still applies and will refuse some entries.
