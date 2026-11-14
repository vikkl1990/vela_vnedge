# Native scanner close-to-entry handoff — 14 November 2026

Two execution defects are corrected in six existing experimental shadow plans.
The current account readers, scanner allocation, entry gates and evidence rules
are unchanged. No plan or paper scanner is added.

| Native scanner | Author lifecycle | Correction |
| --- | --- | --- |
| Structure-Anchored VWAP 2.0 | Stop/target/leg-flip close, then qualified new entry | Wait for actual closure; retain a fresh same-side entry |
| Synapse Trail Pro | Batched old-position management before new entry; thirds at targets | Wait through every partial exit; retain a fresh entry |
| Liquidity Trail Matrix | Stop/BE/TP3 close or opposite-signal reversal | Wait for actual closure and reprice replacement |
| Reactive Trail System | Native stop/TP3 and qualified reversals | Also retain same-side entry after a requested full close |
| Reaction Level Matrix | Native stop/TP3 and qualified reversals | Also retain same-side entry after a requested full close |
| STRAT Trap & VWAP Engine | Native SL/BE/TP3 close, then a qualifying flat-state entry | Retain a fresh same-side entry while the old close settles |

The earlier causal-reversal wait was enabled only for Reactive Trail and Reaction
Level Matrix. The other native profiles could cancel an otherwise admitted
replacement because their exit was pending rather than filled. Separately, all
six could discard a valid same-bar, same-side entry as “already in position.”

The corrected entry carries the old position ID and an explicit wait state.
It never closes the old position a second time or releases its margin early.
TP1/TP2 reductions and BE amendments do not authorize pyramiding. Only an existing
full-close request, or the final-target close sequence, permits this handoff.
Original expiry, quotes, levels, fees, depth, exchange status, risk and exposure
checks remain binding. Pending market entries are cancelled on restart; durable
protective exits survive. A refused new entry does not withdraw the author's close.

Each corrected plan receives a new snapshot signature through
`nativeReentryVersion: 1`. Held positions keep their previous snapshot, receive
their original exits, and prevent a newer version opening on top of them.
The six plans still consume six of the existing 73 slots. Experimental trades
remain excluded from copying, promotion and sizing evidence.

## Validation against the deployed implementation

The baseline checkout is the exact tree merged as deployed commit `57cd4d3`.
The comparison imports that checkout's engine and plan builder independently.

- Fourteen new regression cases compare legacy and corrected behavior, including
  partial depth, same-side re-entry, reversal, TP3 thirds, non-pyramiding,
  restart, expiry, new risk vetoes, invalid levels, disabled plans and fees.
- A retained Delta India ETHUSD 15m dataset contains 1,254 closed candles.
  The six actual Pine outputs contain 165 entries and 19 same-bar close/entry
  sequences. Ten selected closed-bar prefix checks agree with full-run output.
- At unchanged 6× fees, 1,500ms latency, candle-entry mode, $150 margin and 3%
  stop ceiling, both implementations complete the same 15 simulated trades.
  The highest observed initial risk is $29.28 on the $1,000 reference purse.
  No simulated trade qualifies for promotion.
- Only the six expected plan signatures change. Ordinary scanner identities
  remain identical throughout the loaded registry. No config file is written.

**This establishes execution correctness, not higher profit.** The candle-derived
prints and depth are synthetic; historical queue, funding and market eligibility
were not reconstructed. The existing gates exclude many source signals, and
some source closes occur after the simulated position has already closed.
No improvement in fills or profitability is demonstrated by this historical
sample. The focused regression scenarios reproduce the actual failure mechanism.
Forward shadow observations must establish its frequency and financial effect.

[Machine-readable comparison](native-reentry-validation-2026-11-14.json) records
the dataset hash, baseline tree, implementation hash, counts and refusals.
The reproducible runner is `ops/validate-native-reentries.ts`; the regression
suite is `server/src/paper/nativeReentry.test.ts`.

The correction does not certify every scanner's native lifecycle. Unsupported
entry orders, external-series parity and other readiness gaps remain separate work.
