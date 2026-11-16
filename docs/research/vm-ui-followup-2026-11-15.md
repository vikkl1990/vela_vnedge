# VM UI follow-up — 15 November 2026

## Scope and baseline

Reviewed the authenticated deployed Signals, Scanners and Incubator pages at commit
3d367bba2491bc9ad2e7bc2a33e362d256f472bf. Read-only database snapshot taken at
2026-11-15 04:16:37 UTC. No account credentials, session values or private configuration
were copied into this report.

The entire VM configuration is held unchanged, including paper execution, $150 margin,
risk limits, scanner allocations, evidence rules, fees and entry policies.
This release changes presentation, read queries and diagnostic/event metadata only.

## Confirmed fixes

- A resting order could fill or expire after its original signal, leaving the cached
  Signals action stale. Order, pending, position lifecycle and trade events now invalidate
  decision views. Pending events publish only their type, ID and reason. Mark-price updates
  do not cause decision refetches. Signals and Scanners also have a 60-second recovery poll.
- Side filtering previously ran after the latest-500 database limit, hiding older matching
  signals. The database now filters side before limiting results. The UI identifies the
  bounded all-date journal separately from the 24-hour activity cards and provides a refresh
  action, loaded interval and freshness timestamp. Cached read failures are visible.
- Exchange-status and depth freshness failures were described as late scanner signals.
  Both grouped signals and outcome totals now separate those from scan lateness, burst
  spacing, re-entry cooldown, chop, stop policy, unfilled orders and capacity.
- Disabled direct-paper scanners with shadow allocations were labelled “Paper disabled”
  despite qualifying copies entering paper. They now say “Shadow allocated” and explain
  that copying still requires evidence and entry checks. “Trading now” becomes “allocated
  or enabled”; neither allocation nor enablement promises a fresh entry.
- Shadow diagnostics retain at most 120 recent signals per cell. Their counts were shown
  as complete 14-day totals. API metadata and UI lower-bound/sample labels now expose the
  retention limit. Gate evidence and full trade records remain separate and unchanged.
- Same-name scanner records now show their IDs in Scanners and Incubator. Historical
  identities and evidence are not merged or removed. Three exact identity alias groups
  were observed: Amit ETH Strategy, Intraday Master Pro and PM Range Breakout Retest Fade.
- Incubator refreshes on demand and its filter explanation includes account allocations;
  headline totals and gate evidence do not change when a list filter is applied.

## Paper entry audit

All 34 currently copy-eligible shadow cells had successful latest scans. Latest bar-close
delays had median 28.1 seconds and maximum 40.8 seconds. The durable signal inbox had no
pending receipts at inspection.

The database rolling-window snapshot contained 154 entry decisions, including 37 opened.
The separately refreshed browser snapshot showed 155 admission events; rolling windows
and capture times differ. Major database refusal groups were:

| Recorded reason | Decisions |
| --- | ---: |
| Entry burst spacing | 33 |
| Choppy market | 29 |
| Budget below one contract | 8 |
| Per-symbol position cap | 8 |
| Re-entry cooldown | 7 |

Other reasons included four old exchange-status freshness refusals, two stale-depth
refusals, fee/depth-cost limits, own-stop policy and unfilled resting orders. The earlier
exchange recovery correction is already in the baseline. Fresh depth remains required
at a fill; no evidence here justifies treating stale books as executable.

The larger held-candidate number includes shadow cells that have not passed copying
evidence, rather than entries stuck in the account. No additional admission-rule bypass
was justified by this audit. This UI correction does not claim a profit or fill-count lift.

## Validation

- 1,466 server tests passed, including database side-filter ordering and diagnostic-cap bounds.
- 79 dashboard unit tests passed, including lifecycle invalidation, classification precedence,
  distinct scanner identity and shadow-copy presentation.
- 16 rendered desktop/mobile tests passed, including filled/cancelled order updates without
  a new scanner signal, populated Incubator sample/identity labels, refresh without mutations,
  disabled direct-paper shadow copying and all navigation destinations.
- Server typecheck, dashboard production build, lint and formatting passed.
- Deployment uses an isolated build, code/assets/database backup, automatic rollback and
  full-configuration equality verification. The deployed browser is checked afterwards.
