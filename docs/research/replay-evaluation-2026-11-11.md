# Durable replay and evaluation integrity — 11 November 2026

Baseline: `e8513fb740a515c9004a7f10aaf9290136a64c0c`. This release improves measurement, not the trading policy. Paper mode, $150 margin, risk/capital caps, evidence thresholds and forward enrollment clocks stay unchanged. No maker timing rule, new ML gate or additional scanner allocation is enabled.

## Durable market observations

`data/replay/` captures selected paper allocations, both books' open/pending pairs, enabled execution-plan pairs and BTC/ETH/SOL/INIT/PARTI. It reuses advisory depth sockets and observes existing execution-feed trades, quotes, mark and funding messages. Execution book selection and fill calculations are unchanged.

The default research target is 14 days, bounded by 16 GiB of sealed compressed segments and a 2 GiB free-disk reserve. A 16 MiB queue bounds memory; open journals sync every five seconds, seal every minute or 8 MiB, and recover complete lines after a crash. A single-writer lock prevents a second process from recovering a running journal. Sealed segments carry SHA-256 manifests, ordinal continuity, timestamp bounds, symbols, checkpoint and gap counts. Age/byte retention removes the oldest complete segments. The target is not a coverage guarantee.

Validated depth checkpoints are captured every minute and after exchange snapshots, at the time they were observed. Disconnects, invalid books, process boundaries and lost capture are explicit gaps. Buffer overflow ends the retained prefix; subsequent observations cannot hide a gap behind an older checkpoint. Failed writes require recovery before continuing. Disk/capture failure cannot throw into execution decisions. Up to five seconds of an unflushed queue can be lost on a hard crash; restart is explicitly discontinuous.

Exchange timestamps remain in the payload, separately from receipt timestamps. Historical missing depth is not recreated. Capture selection is not proof that every channel delivered events: check the recorded checkpoints, channel observations, freshness and gaps. Public depth does not establish our maker queue priority. The diagnostic SQLite tape remains a bounded operational ring.

Authenticated Execution Quality and Trade health responses expose capture status; Execution Quality shows selected pairs, actual retained bounds, storage, queue, drops and errors.

Read-only sealed-segment export, with two minutes of checkpoint pre-roll:

```bash
node server/src/cli/replay-export.ts data/replay /tmp/init-replay.ndjson 2026-11-12T00:00:00Z 2026-11-12T01:00:00Z INITUSD,PARTIUSD
```

The reader rejects corrupt bytes, missing interior segments and invalid manifests. It never substitutes an empty interval for unreadable data. Export refuses overwrites and removes partial output on failure. Consumers must invalidate the relevant book across gaps and wait for a later verified snapshot/checkpoint.

## Scanner evaluation

The shared prefix check now compares entry time/direction, price, SL, every TP, score, and exit event/type/price. More unchanged exit events cannot dilute an entry-timing failure. Existing minimum five-entry and 10% thresholds are preserved. A short record is explicitly insufficient, not a full certification. Screen checks retain source/settings/runtime/data hashes and exact cutoffs in `scanner_prefix_checks` (latest 10,000 records).

`server/src/cli/certify-scanner.ts input.json result.json` adds research-only checks at four successive closed-bar cutoffs and two warm-up lengths. The input bundle contains the patched source, complete bars, worker parameters, scanner settings and optional variant identity; the result retains that bundle. Failed runs, sparse samples and unfrozen higher-frame/footprint dependencies return unknown. The checker does not change health quarantine, allocations or evidence rules. It does not certify the entire scanner library.

A production-data check of 1,199 closed 15m bars per market found **Trend Impulse prefix stability but warm-up sensitivity**:

| Market | Hidden-bar checks | Shorter warm-up comparisons |
| --- | --- | --- |
| INITUSD | Four checks; no changed plans, 62–67 entry keys per check | 29 and 20 changed plan keys |
| PARTIUSD | Four checks; no changed plans, 49–51 entry keys per check | 38 and 6 changed plan keys |

These are symmetric key differences, not counts of losing trades. Changing the warm-up changes the historical state; this finding is not proof of lookahead or an economic reason to deactivate these cells. Keep the runtime history and source pinned in subsequent strategy comparisons. Exact input/result bundles are retained in the local `work/replay-evaluation-20261111/checks/scanner-INITUSD.json` and `scanner-PARTIUSD.json` research artifacts.

## ML evaluation

Saved entry scores and current-model rescoring are separated. Later scores, missing scores and invalid probabilities cannot be discarded by a hypothetical historical gate. Both books use the existing executed-evidence exclusions, including quarantined, adopted, tracker/plan and provenance-less records.

New scoring receipts retain prediction time, decision start, model bundle/scope, training outcome cutoff, feature-code hash, exact feature vector and its hash. A separate immutable binding connects a filled or pending order to its policy and later position. Model payloads are versioned, survive restart, and cannot infer an old model's missing training cutoff. Training excludes outcomes resolved after training starts. Receipt failures are advisory and do not block entries.

The Learn page keeps older saved scores descriptive. A research candidate requires matching model/time/features/policy receipts on eligible closed positions. Every model cutoff must precede training, every prediction precede the decision, and the position must belong to that decision. The API always returns `call.minProb = null`; an exploratory threshold may be reported only as `candidateMinProb`. Threshold selection on a historical window is not an untouched test. No automatic enabling is implemented: a chosen candidate still needs a frozen, later evaluation before any separate activation decision.

This release does not retrain on shadow outcomes, introduce new features, certify old models or prove a profitability gain.

## Validation

- 1,253 server tests and 25 dashboard tests passed; dashboard lint and build passed.
- Regression coverage includes full-plan changes with stable arrows, disappearing exits, warm-up sensitivity, insufficient samples, hindsight-only scoring, future training labels, altered policy/features, metadata loss and restart.
- Archive tests cover checksums, order preservation, checkpoints, overflow boundary placement, disk pressure, retention, crash/torn-tail recovery, duplicate writers and safe CLI export.
- Offline playback of 25,000 real VM events retained 25,072 archive records, 69 checkpoints and 17 sealed segments (3,386,439 compressed bytes), with zero drops and identical reconstructed books with/without capture. This is observation-equivalence validation, not production p99 or profitability proof.
- Server `tsc` still reports pre-existing baseline errors; the final diagnostic comparison adds none. Required runtime tests and dashboard build pass.

Deployment requires a consistent readable SQLite backup, exact tested revision, unchanged whole-configuration hash, preserved existing position policies, authenticated health/quality/ML checks, and observed archive checkpoints after restart. Do not restore an old ledger over trades that occur after backup; roll code back while preserving current data if needed.
