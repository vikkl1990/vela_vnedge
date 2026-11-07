# VN EDGE — phased rollout and evaluation

Plan ID: **GL-2026-11-08-v2** · Revised 8 November 2026 · Status: **production environment selected; real-money execution is not activated**.

This is the implementation and evaluation specification for the path from the current paper bot to a limited live pilot. Thresholds below are proposed project acceptance criteria, not proven profit guarantees or changes to running configuration. Freeze the evaluation specification before collecting its qualification sample. The existing `ROADMAP.md` remains untouched; historical items there must be checked against current code before implementation.

**Environment decision:** use Delta India production for market data, account observation and eventual order execution. Testnet is excluded from this rollout at the operator's request. Production-feed paper/shadow fills remain simulations; exchange fills and protection are verified only during a separately approved, budgeted production pilot. Local unit tests and fault replay remain necessary and never send their simulated faults to the production account.

**Immediate next delivery:** an independent production account observer while paper trading continues. Reuse the existing audit ledger; scope history by account identity and environment, handle credential changes, and reconcile balances, orders, positions, fees, tax, funding and confirmed offer credits. Show last sync, missing intervals and discrepancies. The saved-credential connection check currently supplies access verification only; the continuous audit timer depends on an executor and therefore does not run in paper mode. This work must not construct an order writer.

## 1. Starting evidence and constraints

| Item | Verified position as of this plan | What remains |
| --- | --- | --- |
| Running VM | Last verified at `15a93a4`, active, configuration hash unchanged; 129 open positions preserved on the final restart | Complete sustained runtime observation |
| Local release | `32022cc` execution boundary fixes and `15a93a4` pending-order warm-up repair deployed | Production observation and protection work remains |
| Tests | 987/987 server tests and 7/7 dashboard tests passed on the deployed release | Production observation, isolated fault replay and later real-order lifecycle evidence |
| Type checking | Full server type check and dashboard lint/build passed | Repeat relevant checks on subsequent implementation changes |
| Economic evidence | Seven-day matched paper net: −$44.00 recorded versus −$151.17 at saved closing quotes, 182 exits | Profitable performance under realistic execution has not been established |
| Coverage probe | 20 crypto pairs, three minutes, no detected sequence/checksum failures; all sampled quotes fresh | Full trade lifetimes, continuous retention and outage tests |
| Execution | Durable intent/ledger and reconciliation code already exist | Private account stream, production protective-order path, lifecycle proof |
| Protection | Production transport currently rejects resting stops/limits | Narrowly allow verified protective orders; retain production activation locks |
| Capital policy | $150 standard paper margin, variable leverage, 3% stop-risk ceiling, 6× risk-to-cost rule | Separate explicit capital and loss budget for a live pilot |

The 6× rule is a risk-to-cost ratio, not a fixed 6× leverage setting. Preserve the current paper configuration while establishing the baseline. Shadow synthetic dollars never count as account profit or proof of capital feasibility. Historical journal rows remain intact; new evidence is identified by source, simulation, execution and policy versions.

Evidence: [deployed repairs and validation](research/delta-execution-boundary-fix-2026-11-07.md), [execution validation](research/delta-execution-validation-2026-11-07.html), [machine-readable results](research/delta-execution-validation-2026-11-07.json), [realtime audit](research/delta-realtime-audit-2026-11-07.html). The earlier research measurements remain historical; the release status above supersedes the original plan's deployment status.

## 2. Phase sequence and dependencies

| Phase | Dependency | Deliverable | Current status |
| --- | --- | --- | --- |
| P0 — establish the release baseline | None | Repaired VM, verified rollback and stable operations | Repairs deployed; sustained observation not yet certified |
| P1 — record complete evidence | P0 | Multi-pair recording with continuity, retention and replay manifests | Short probe passed; recorder expansion not built |
| P2 — align paper with executable orders | P1 | Causal entries/exits, realistic quantities, fees and funding | Research pricer tested; production integration pending |
| P3 — prepare production execution | P0; P2 parity before pilot readiness | Production read-only reconciliation, isolated fault replay and protected execution implementation | Boundary fixes deployed; observer/protection work incomplete |
| P4 — qualify scalp and swing policies | P1 + P2 | Frozen policies evaluated on unseen forward data | Not started under the corrected execution model |
| P5 — limited production pilot | P0–P4 passed for the selected policy; operator approval | Small, budgeted real-order validation on production | Ineligible today |
| P6 — controlled expansion | Successful P5, production execution certificate and new capacity evidence | More exposure or pairs in separate increments | Not eligible |

P3 engineering can run alongside P1/P2. P4 data collection starts only after P2 is stable and the candidate is frozen. Scalp and swing qualify independently: one lane may advance while the other stays in paper. There is no calendar-based automatic launch.

## 3. Phase delivery and acceptance

### P0 — release baseline

Deliver an exact-SHA release of the tested fixes. Before restart, capture a consistent database backup, configuration hash, open/pending positions, enabled scanner set and deployment manifest. Restore the backup into an isolated database to verify it can be read. Preserve pending-order and bound-policy semantics across restart. Verify the UI asset version and authenticated service response after deploy.

Acceptance: server tests pass; changed dashboard code passes its tests/lint/build; database migration and restart preserve positions and pending intent; recovery/duplicate-decision drills pass. Observe at least **48 continuous hours** with zero unexplained duplicate entries, lost position state or unhandled reconnect faults. This observation is operational evidence, not profitability evidence. All full-project type diagnostics must be resolved before the P3 pre-pilot engineering review closes.

Rollback: stop new entries, retain journal/config backups and revert only to a compatible release. A database restore must never overwrite subsequent exchange fills. If a schema cannot safely roll back, use a forward repair. Do not cancel protective orders merely because the bot is being redeployed.

### P1 — complete multi-pair evidence

Record top-20 crypto research markets plus every held/pending symbol, including a symbol that drops out of the top 20. Keep the research universe membership and ranking timestamp. Freeze the qualification universe before its final test; do not remove a subsequently losing or delisted market from results.

Capture exchange time, receipt time, sequence/checksum status, quotes and their sizes, trades, depth updates/checkpoints, mark prices, funding schedules/settlements, product specifications, signal identities, decision times and order intent. Every entry-to-exit path must join to an immutable policy/source version and a deployment manifest. A publication time must not substitute for an unknown trade time.

Use compressed, bounded segments and full-book checkpoints at segment starts and after every repair. Record explicit gap manifests for disconnect, sequence failure, queue overflow, failed disk writes and missing intervals. Seal segments with checksums and atomic manifests; verify recovery after a truncated final segment. A priority queue retains held/pending markets first; drop lower-priority research recording with visible gap markers instead of stalling execution.

Capacity acceptance: replay a full 24-hour capture at **2× its observed peak input rate** while monitoring scanner lag, queue bounds, memory and disk. No silent drops, unbounded queues or execution-thread blocking. Set storage limits from measured compressed bytes and VM free space; reserve operating headroom. The three-minute raw probe extrapolates to roughly 9.1 GB/day before compression, so a 32 MiB ring is not a research archive. Retain the complete qualification dataset until its review is signed; provision capacity before starting that window.

Coverage target: fresh quotes (exchange and receipt age ≤1 second) in **≥99.5% of scheduled one-second samples per pilot pair** during its enabled trading hours over seven days. Track 1s/5s/10s depth age distributions separately. Low depth freshness is a recorder/route-design issue, not a reason to hide signals or forbid protective exits. All evaluated trades require known accounting; incomplete paths are shown in both the denominator and uncertainty analysis.

### P2 — align paper with executable orders

Use one order-intent and fill-accounting contract across research, paper and exchange execution. Keep scanner generation separate from allocation and execution. Implement and test:

- Closed-bar signals and causal tape triggers; no pre-entry candle or future snapshot can fill an order.
- Explicit market or post-only entry routes, deadlines and cancellation. Maker-to-market fallback is a separately evaluated policy, never silent.
- Long market exits sell bids; shorts buy asks. Walk actual contract quantities through timestamped depth and record partial coverage.
- Queue-aware or conservatively bounded maker simulation. A touched candle or print alone cannot guarantee a full maker fill. Do not infer queue priority that the exchange data does not expose.
- Explicit fresh-quote/model fallback when depth is unavailable. Record its lower confidence. Missing price evidence must not suppress a protective exit request.
- TP/SL reference parity: choose mark-price versus last-traded-price triggers deliberately and use that choice consistently. Preserve existing bound policies for held trades.
- Effective maker/taker commission, tax, funding and currency conversion. Promotions apply only with verified enrollment, eligibility and time limits. Credits/vouchers are not automatically cash P&L.
- Exact quantity conservation, reserved margin, fees and P&L through partial fill, expiry, reversal and restart. An exit cannot open an opposite position.

Acceptance: deterministic replay gives identical decisions from the same input ordering; future data mutations do not change prior results; long/short, partial-fill, zero-fee, adverse-gap and missing-book cases pass. All trades have source and fee provenance. At least **99% of qualification candidates have a complete causal path**, and the remainder must be included as adverse bounds or explicitly unresolved; deleting uncertain losers cannot make a policy eligible. Maintain an old-model comparison for diagnosis, but use corrected execution as the economic baseline.

Rollout: first record proposed fills beside the current engine. Then enable the corrected policy for a bounded paper cohort with new policy/simulation identity. Existing positions finish under their original bound rules. Increase coverage after reconciliation and replay invariants pass; account P&L may look worse as optimistic fills disappear.

### P3 — production observation and execution preparation

All network observation uses the production environment. Continuous account observation must work without an executor, preserve account/environment isolation, and survive restarts and credential rotation. Paginated or malformed responses cannot advance history completeness. Missing or delayed costs stay pending; cash, promotional credits and paper P&L remain distinguishable. Verify the observer invokes only read operations, even if the saved key has trading permission.

Extend the existing ledger/outbox/account-audit path. Add authenticated private order/fill/position events with REST backfill and reconciliation after reconnect. Use stable client-order IDs and reconcile uncertain acknowledgements before retrying. Private events are observations, not permission to send a second order.

Add a narrowly scoped production path for reduce-only protection and approved entry routes. Keep `allowProduction` and `DELTA_LIVE` activation locks. Bind the certificate to execution semantics and policy identity. Standard exits must remain available when readiness blocks new entries.

For each filled entry quantity, confirm an exchange-held stop for the actual residual exposure. Define a bounded protection deadline: if protection cannot be confirmed, cancel the unfilled entry, request a reduce-only close of filled exposure, keep reconciling until flat and raise an incident. A proposed initial deadline is **2 seconds**; validate against measured exchange response times before pilot approval. This is a recovery deadline, not a promise that market losses stop at the trigger price.

Pre-pilot acceptance: every critical fault case in section 6 passes in an isolated harness with captured production events and explicitly labelled synthetic boundary cases. Run at least seven continuous days of production read-only observation; an inactive account supplies connectivity evidence but cannot establish fill or settlement reconciliation. Record real account activity where available and mark absent lifecycle evidence as not observed. No duplicate accounting, mixed accounts, falsely complete history or unresolved reconciliation errors. Critical states reconcile immediately, with a periodic reconciliation backstop proposed at ≤5 seconds while exposure exists. Reconcile fees and funding to exchange accounting units and currency; late settlements are pending, not silently zero.

Production-feed paper evaluation supplies market/economic evidence; isolated replay supplies fault-handling evidence. Neither proves exchange acceptance, queue priority, actual fills or actual protective-stop behavior. Those claims remain pending until P5 observes the corresponding real production orders. Do not deliberately reject stops, kill an exposed production process or disrupt the real account to manufacture a fault case; inject these failures only into isolated local tests with exchange writes disabled.

Evidence package: exact build and execution version, permitted order types, policy hashes, dataset/test IDs, environment, timestamps, incidents and resolutions. P3 produces a **pre-pilot engineering review**, not an exchange execution certificate. P5 adds observed real-order lifecycle evidence before certification for P6. Major execution changes invalidate affected evidence; cosmetic UI changes do not. Reconfirm evidence and incident status before each activation; proposed certificate expiry is 30 days without recertification.

### P4 — economic qualification

Run the protocol in section 4. Freeze the scanner source, signal interpretation, timeframe, pair list, entry route, stop/target rules, holding period, risk sizing, fee assumptions, ML model and training cutoff. Auto-tuning and scanner updates may continue in separate research; they cannot modify the qualification cohort.

Acceptance: the selected policy passes all registered economic, coverage and capital constraints on its final forward window. A profitable pooled scanner family does not automatically qualify every constituent pair. Scalp and swing must each have their own result. If no policy passes, continue paper research with a specific new hypothesis and a fresh holdout; do not lower the threshold after seeing results.

### P5 — limited live pilot

Present the operator with the exact economically qualified policy/pair/timeframe allowlist, pre-pilot engineering evidence, outstanding exchange verification, pilot capital, permissions, maximum notional, risk, loss budget and stop procedure. Explicit approval is required for real-money activation. Selecting the production environment does not supply the missing pilot allocation or authorize arbitrary validation trades. Keep keys in the VM's approved secret store; use only needed trade permissions and no withdrawal permission, with IP restriction where supported.

Proposed pilot limits, to be approved separately: **one concurrent position**, $150 margin as an upper ceiling rather than a forced allocation, planned stop loss including costs ≤**0.25% of assigned pilot equity**, daily total-equity loss limit **1%**, and pilot peak-to-trough drawdown limit **3%**. Risk sizing uses the lower of current and initially assigned pilot equity. The daily loss denominator is equity at 00:00 UTC, adjusted for external cash transfers; transfers do not erase losses or reset the pilot drawdown. Use isolated margin where supported and verified. If the minimum contract breaches the budget, that pair cannot be used at that pilot capital. Limits trigger control actions; gaps, slippage and outages can cause losses beyond the planned amounts.

Pilot results use actual exchange fills, fees, funding and executable marking. Entry readiness is enforced server-side at startup and at every new entry. Live results must not be overwritten by paper assumptions. Hold standard $150 paper sizing and its 3% ceiling unchanged while the pilot uses its stricter, explicitly approved allocation.

Review after a fixed initial **14-day live window and at least 50 closed trades**; fewer trades means insufficient evidence, not automatic failure. No automatic size increase. The purpose is execution calibration and exposure control; 50 trades alone cannot establish a durable trading edge.

For execution certification before P6, propose at least **100 completed production order lifecycles across seven or more days**, including independently confirmed protection, amendments/cancellations when used, final exposure and settled costs. These are naturally occurring orders under the approved strategy and budget, never churn created to reach a quota. Keep the 14-day pilot review requirement as well. Distinguish actual production observations from fault replay; a route with no real observation remains unverified. Any uncovered required lifecycle keeps that route outside expansion, regardless of total trade count. Measure maker fill rates, slippage, stop confirmation latency and reconciliation lag against the production-feed paper predictions, then carry the measured differences into the next economic evaluation.

### P6 — controlled expansion

Change only one dimension per tranche: size, concurrent exposure, or pair/policy list. Re-evaluate liquidity at the proposed size and portfolio correlation at the proposed concurrency. New pairs require compatible forward evidence; returns from BTC do not qualify an altcoin. Define the next tranche's review date and loss budget before activation. Roll back to the last certified allocation on a safety incident or budget breach. A high daily trade count is an operating objective, not a reason to override cost, evidence or capital constraints.

## 4. Registered evaluation protocol

### Unit of evaluation and comparators

The atomic strategy identity is scanner source × interpretation × pair × timeframe × direction rules × entry route × exit policy × sizing/ML version. Independently record portfolio allocation and execution-model versions. Use the existing immutable trade-policy infrastructure rather than a new competing identity system. Maintain an execution certificate for the code that implements those semantics.

| Experiment | Change under test | Comparator and interpretation |
| --- | --- | --- |
| E0 — model reconciliation | Candle pricing versus causal/executable pricing | Same signals, intent, quantity and trigger times; measures accounting bias, not alpha |
| E1 — entry route | One post-only route/deadline versus market | Same opportunities and exits; include nonfills, queue uncertainty, cancellation and fallback |
| E2 — exit policy | One scanner-specific stop/TP/time-exit policy | Same entries and route; retain all partial exits, funding and freed-capital effects |
| E3 — scanner/ML contribution | Add/remove one family or frozen ML component | Compare marginal portfolio outcome and correlated exposure; do not count duplicated signals as independent evidence |

Run at most **three registered challengers per lane** in development. Select one finalist per lane before final forward evaluation; retain every tried variant in the experiment register. If more than one finalist is judged on the same final data, adjust for multiple testing or require a new untouched confirmation window. Do not select parameters on the final window and then call its results out of sample.

Perform both a paired signal-level comparison and a constrained portfolio replay. The paired test isolates a mechanism; the portfolio test includes margin reservations, order expiry, correlated positions, capital reuse, concurrency, drawdowns and halts. Each arm uses the same starting equity and risk budget. A nonfill is zero trading P&L but still counts as an opportunity and consumes any reserved capacity until cancellation. Compare daily return and fill rate as well as R per filled trade so selective nonfills cannot disguise a loss of useful opportunity.

### Time windows and sample sufficiency

| Lane | Initial diagnostic review | Locked final forward window | Minimum evidence at final review |
| --- | --- | --- | --- |
| Scalp | Day 14 and approximately 200 closes, if available; operational review only | **28 complete UTC days** after freeze | ≥200 closed portfolio trades, all 28 calendar-day blocks included, per-cell counts shown |
| Swing | Day 28, including funding exposures | **56 complete UTC days** after freeze | ≥60 closed portfolio trades, eight weekly blocks included, per-cell counts shown |

These are proposed minimum windows, not launch deadlines. A 15m scanner is not automatically a scalp: register the intended holding horizon and cost exposure. A candidate may have ample trades yet insufficient independent information. Do not force trades to reach a quota. Cells with fewer than **30 scalp / 20 swing closes** remain provisional and outside the live allowlist; even those counts are not proof without uncertainty and cost checks.

All positions opened before the cutoff remain in the cohort until their predeclared maximum holding horizon. Show interim open P&L at executable liquidation prices. Do not drop open losers or introduce an after-the-fact close rule. If the sample is too small or the result inconclusive, return `insufficient_evidence`; register the next evaluation window and sequential-testing treatment before extending it. Never stop early because profit turns positive. Safety monitoring continues throughout and can halt exposure at any time.

Use chronological development/validation windows with at least the maximum trade/label horizon purged across splits. Model fitting, feature normalization, pair selection and threshold selection use only information available before each test. ML predictions must be saved at entry; rescoring old trades with a newer model is diagnostic only. Scanner pivot confirmation and higher-timeframe alignment use the availability time, not a retrospectively moved label.

### Metrics and proposed pass criteria

| Dimension | Required measurement | Proposed criterion |
| --- | --- | --- |
| Accounting | Gross P&L, entry/exit fees and tax, funding, net P&L | 100% of qualification accounting settled or conservatively bounded; no unresolved amount treated as zero |
| Absolute edge | Net R/trade and net daily portfolio return | Positive net result; one-sided 95% block-bootstrap lower bound for mean daily net return >0 |
| Profit factor | Sum positive net trade P&L / absolute sum negative net trade P&L | ≥1.20 after costs; report numerator, denominator and sample, not infinity as proof |
| Claimed improvement | Paired daily candidate-minus-baseline return | One-sided 95% lower bound >0 to claim an improvement; positive individual arms alone do not prove lift |
| Cost robustness | Fees, spread/depth, delay and funding stresses | Positive net result under the registered moderate stress; severe stress has no solvency/protection violation |
| Drawdown | Mark-to-market portfolio drawdown, duration, worst day, MAE and adverse gaps | Within a dollar/% budget registered before the window; missing budget means not eligible |
| Opportunity | Signals → eligible → admitted → filled → closed, with reasons | Report count per covered day and per pair; investigate >20% executable-count reduction before choosing a challenger |
| Concentration | Leave-one-pair-out and leave-one-time-block-out results | If removing one pair/block reverses the edge, mark concentration dependence and require another confirmation window |
| Evidence quality | Full-population path coverage and fallback share | ≥99% complete paths; adverse bounds on the remainder must not overturn eligibility |

Define net R as realized trading P&L **excluding funding**, plus signed funding, minus all entry/exit charges, divided by the **initial** stop-risk amount. If a stored P&L field already includes funding, do not add it again. The denominator never shrinks when a stop trails. Report capital-weighted daily portfolio returns as primary alongside R, since $150 margin and variable leverage create varying dollar risk. Fee share of gross profit is descriptive and undefined when gross profit is nonpositive; always show absolute fees and cost in basis points.

Resample whole UTC-day blocks for scalp and whole weekly blocks for swing, retaining simultaneous cross-pair trades inside each block. Use at least 10,000 bootstrap resamples with a recorded seed and publish the distribution and effective block count. With only eight swing weeks, uncertainty may remain large; extend evidence rather than assert independence from hundreds of correlated trades. The confidence bound is an estimate, not a guarantee. Correct multiple final comparisons with a registered method such as Holm adjustment.

Drawdown is measured on time-ordered, executable-marked equity including unrealized P&L and charges. For simulations, apply the same daily/weekly halts in both arms and report the signals missed while halted. Daily count is measured on complete covered days; partial days are explicitly labeled. Report outlier-sensitive and leave-one-block-out results without deleting the outlier from the primary metric.

### Cost and failure stresses

| Scenario | Fixed assumptions before the final test | Use |
| --- | --- | --- |
| Base | Actual product fees/tax; verified offer eligibility only; observed size/quotes/depth; measured latency distribution; settled funding | Primary evaluation |
| Moderate | No optional fee promotion; +50% spread/depth execution cost; 2× measured p95 decision-to-order latency; reduce maker fill probability by 25% | Economic robustness requirement |
| Severe | 2× spread/depth cost, at least 1 second added order delay, a five-second feed outage during a move, and a funding-boundary outage | Tail-risk and recovery drill; no positive-profit requirement |

Costs are charged once: spread, impact, commission and tax are separate, avoiding a second spread charge after depth VWAP. A failed maker fill does not become a taker fill unless the frozen route explicitly permits it. Model funding at the product's actual schedule; do not assume every contract settles every eight hours. When historical event order or depth is missing, use valid bounds or mark the scenario unmeasurable. Never fill the gap with today's liquidity.

The old candle model cannot serve as the profitability hurdle for a corrected engine. E0 establishes the honest baseline. E1–E3 must beat that baseline under identical feasible capital and execution assumptions.

## 5. Scanner coverage and architecture ownership

| Existing component | Sole responsibility in the rollout | What it must not imply |
| --- | --- | --- |
| Library / scanner catalogue | Source provenance, compatibility, runtime safety and signal contract | Catalogue membership is not permission to trade |
| Scanners / radar / pair agents | Generate timestamped opportunities and expose missing coverage | A bullish plot is not necessarily a new executable entry |
| Incubator / shadow | Explore cells and collect versioned research evidence | Synthetic returns or a short paper pilot do not establish live readiness |
| Paper | Feasible capital allocation and corrected execution evaluation | Optimistic or incomplete fills cannot qualify a policy |
| Learn | Frozen, calibrated predictions with training cutoffs | A post-hoc score cannot be called an entry-time prediction |
| Performance / journal / trackers | Explain the same ledger, cohorts and signal funnel | Each page cannot calculate a different readiness answer |
| Decisions | Display one server-computed readiness decision and operator actions | A UI button cannot bypass backend entry prerequisites |
| Exchange executor | Own intent, acknowledgements, exposure, protection and reconciliation | Paper state alone is not proof that exchange exposure is flat |

For each major scanner family, register expected signal semantics, repaint/pivot behavior, minimum warmup, compatible timeframes, source hash, runtime budget and whether alerts actually represent entries. Track silence separately from no aligned setup, cost refusal, insufficient margin, pending capacity, route nonfill and runtime quarantine. This preserves broad research coverage without inventing signals or giving every scanner an allocation.

Reuse `tradePolicy`, `policyHealth`, the ledger/outbox, existing risk halt history and execution comparisons. Extend them with evidence/certificate IDs and shared status; do not introduce another independently sized paper book or duplicate promotion channel.

## 6. Required execution certification matrix

All critical cases must pass in isolated tests. Record whether evidence comes from unit fixtures, recorded production replay, production read-only observation or approved real production orders; one category does not silently substitute for another. Synthetic faults are local software tests, excluded from strategy-profitability samples. No fault injector may write to the production exchange. Actual production order behavior is observed during P5; unobserved behavior is explicitly unverified.

| Case | Required behavior / assertion |
| --- | --- |
| Signal duplication or replay after restart | One durable intent; at most one exchange entry |
| Timeout after exchange accepts entry | Query/reconcile by client ID before retry; no duplicated exposure |
| Partial entry fill | Protect only filled quantity; reserve/cancel remainder correctly |
| Post-only rejection or expiry | No fabricated maker fill; only the registered fallback can cross |
| Stop rejected or acknowledgement missing | Bounded recovery, cancel unfilled entry, reduce-only close; reconcile until protected or flat |
| Partial stop fill | Protect/close residual exposure without increasing size or resetting fill totals |
| TP and stop race | Aggregate exits never exceed exposure; no opposite position |
| Trailing-stop replacement fails | Keep confirmed old protection until replacement is confirmed or close exposure |
| Public stream fails while private stream works | Block affected new entries; existing exchange protection and reconciliation continue |
| Private stream fails or sends duplicates/out-of-order events | REST recovers authoritative state; fill application remains idempotent |
| Process killed between intent/send/ack/fill/persist | Each crash point resumes safely from durable intent and exchange truth |
| Authentication expires, 429 or 5xx occurs | Bounded retries; no retry of an ambiguous mutation without reconciliation |
| Clock drift, future timestamps or stale quote | No fresh-entry claim from invalid data; protective requests remain possible |
| Funding boundary during outage | Capture liability; reconcile settlement; no invented zero or double charge |
| Exchange minimum size/tick/margin/product change | Refresh specifications; reject invalid new size; continue managing held exposure |
| Manual/external order, position drift or unexpected liquidation | Detect and reconcile; pause new entries and expose the incident |
| Disk full, database error or corrupt final recording segment | No phantom commit; visible recording gap; execution safety remains active |
| Kill switch / deployment rollback | Cancel entries; verify residual exposure and retain stops until confirmed flat |
| Backup restore into isolated environment | Restore succeeds without sending orders; live exchange state is not overwritten |
| UI readiness or source-policy mismatch | Backend prevents unauthorized new entries even if UI is stale |

## 7. Rollback and incident policy

| Trigger | Immediate action | Resumption requirement |
| --- | --- | --- |
| Unprotected/unknown exchange exposure, duplicated order, sign flip | Stop new entries; reconcile and protect or reduce-only flatten; alert operator | Root cause fixed, relevant fault drills rerun, explicit incident resolution |
| Loss or drawdown budget reached | Stop new entries; execute the predeclared exposure-reduction policy | Budget review and new explicit pilot authorization; no automatic next-day reset of pilot drawdown |
| Capture gaps or stale market data | Mark affected evidence; pause affected new entries if execution freshness is unavailable | Fresh validated data and continuity recovered; missing history stays marked |
| Fee/funding/accounting mismatch | Mark economic evidence incomplete; reconcile with exchange records | Amounts resolved within documented currency rounding/settlement timing |
| New release degrades correctness or latency | Pause new entries; use certified compatible rollback/forward repair | Restore drill, reconciliation and affected certification pass |

A profitability disappointment is not the same as a safety failure. Keep monitoring without altering the frozen experiment, unless the registered risk budget requires a halt. A safety failure can stop the experiment immediately and must remain in its final report. Successful old tests do not excuse a newly observed production defect.

## 8. Readiness view and evidence package

Extend the existing Decisions page with five facets: **data coverage, execution realism, protection/reconciliation, economic evidence, operator allocation**. Each facet shows `pass`, `fail`, `insufficient_evidence`, `not_run` or `expired`, its measured value, criterion, policy/certificate ID, evidence link and next action. Missing evidence never renders green. Backend logic returns eligible pair/policy cells, not a blanket whole-fleet flag.

Paper admission, qualified-paper allocation and live authorization are distinct states. A general pause cannot prevent an exit or protection repair. Runtime feed/certificate/risk state is checked again on each new entry; a historical green report is not a perpetual permission.

Every evaluation produces a signed-off package containing: manifest and data hashes; registered hypothesis and all tried variants; source/policy/execution versions; start/end and training cutoff; opportunity funnel including nonfills; path-quality exclusions and bounds; scalp/swing and cell breakdowns; net accounting; portfolio replay; bootstrap outputs and seed; stress results; incidents; reviewer decision and rationale. Do not put credentials in this package.

Daily scorecards are **specified here, not scheduled**. They should show data gaps, scanner runtime faults, executable opportunities, orders/fills, fees/funding, net R/money, SL/trail outcomes, unrealized drawdown and reconciliation/protection state. Operational diagnostics run daily; formal economic qualification happens at its registered endpoint. An operator approval must specify scope, capital and expiry; it is not inferred from approval of this plan.

## 9. First implementation backlog and ownership

| Work ID | Task / primary source area | Acceptance owner | Evidence to produce |
| --- | --- | --- | --- |
| R0 | Observe deployed `15a93a4`; ops/deploy and backup path | Release owner | Exact SHA, config hash, backup/restore proof, restart reconciliation, 48h observation |
| D1 | Segmented capture, checkpoints, prioritization; depthRecorder/orderflow/wiring | Data/execution maintainer | Retention manifest, gap tests, 24h replay and load report |
| X1 | Integrate causal exit pricing and provenance; paper engine/logic/tradePolicy | Execution maintainer | Paired replay, invariant tests, old/new policy attribution |
| X2 | Route parity and partial/maker fills; entry/exit execution | Execution maintainer | Market/post-only/cancel/expiry/partial tests and matched opportunities |
| A1 | Independent production observer, private events and accounting; connections/delta, ledger/outbox/accountAudit | Execution maintainer | Works in paper mode; reads only; account isolation; reconnect/backfill/idempotence and fee/funding reconciliation |
| S1 | Native production protection and readiness enforcement; execution/client, execution/testnet, risk | Execution maintainer + operator | Isolated fault matrix, protective deadlines and pre-pilot review; actual production certificate after approved pilot |
| E1 | Frozen scalp/swing evaluation and statistics; research/analytics/incubator | Strategy reviewer | Registered protocol, final holdout/stress/portfolio results |
| U1 | Shared production readiness projection; Exchange/policyHealth/Decisions/Performance | Dashboard maintainer | Separate feed environment, simulation mode, read-only sync and real-order verification; remove mandatory testnet copy; server-enforced authorization tests |

Roles name responsibilities, not newly assigned people or autonomous agents. No new task, automation, deploy or trading permission is created by this document.

Suggested review cadence: a release review after P0; a data/realism review after P1/P2; pre-pilot engineering review after P3; registered economic endpoints for P4; explicit pilot approval before P5; production execution certification after P5 and before P6. Engineering duration depends on the implementation and tests. The observation windows start only when their prerequisites pass. The existing file name `execution/testnet.ts` denotes shared executor code and is not evidence that a testnet host is selected; validate the actual transport environment.

## 10. Exchange references and document maintenance

Use [Delta India API documentation](https://docs.delta.exchange/) for current private authentication, order lifecycle, protective-order trigger methods and product units. Use [Delta fees](https://www.delta.exchange/fees?tab=trading-fees) for notional-based charges and applicable tax; verify actual product/account terms and settlements before certification. These exchange facts do not set the project's statistical thresholds.

Canonical document: `docs/GO-LIVE-ROLLOUT.md`. The accompanying HTML is a rendered copy, and `docs/go-live-evaluation.json` contains the proposed evaluation defaults and current evidence status for future implementation. None is loaded as bot configuration. Update their version together after review; do not silently change criteria mid-experiment. Existing historical roadmap items describing fixed funding intervals or completed foundations should not override current measured evidence.
