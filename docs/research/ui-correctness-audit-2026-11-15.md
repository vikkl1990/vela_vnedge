# Dashboard correctness audit — 15 November 2026

Baseline: `111dbd4`. Scope: the deployed four-book redesign, its navigation, journal filters, ML displays and the overlapping Learn/Lab controls. This release changes dashboard presentation only. Server code, configuration, paper mode, capital, risk caps and evidence rules are unchanged.

## Confirmed corrections

| Finding | Correction and source of truth |
| --- | --- |
| Home treated `useAsScore` as Gate and ignored `minProb`; scanner Books hard-coded Off. | Shared `mlState` reads both independent switches. `ScannerEngine` only uses ML as a score fallback when the script has no score. Missing settings display Unknown. |
| Missing scanner model data displayed “no skill”; AUC tiers appeared to authorize advice, size or gating. | Missing data is labelled unavailable. AUC is a held-out ranking statistic, not a profitability or deployment approval. Removed the proposed tiers from operational controls and the “take every signal at full size” advice. |
| Learn duplicated Lab’s training button, without its permission-aware confirmation. | Training has one entry point in Lab; Learn links there and remains the detailed evaluation view. No training was run during this audit. |
| Tracking alone marked a screen passed, and old trades marked a scanner currently trading. | The display distinguishes tracked, current allocations and recorded history. Disabled or failed account scanners are not marked current. Incubator remains the eligibility source; library stages do not report every paper-copy allocation. |
| Home classified newly admitted cells with no fills as quiet for 30 days. | Quiet requires at least 30 days since admission and the latest recorded trade. Re-admission starts a new observation interval. |
| Screen R/trade gave every pair equal weight regardless of trade count. | The summary is weighted by valid trade counts. The different screen, shadow and account cohorts remain explicitly labelled. |
| Strategy Books mixed account statistics and library totals, while the list used library totals. | Headline counts, net and R consistently use the library cohort. Win rate is shown only when the account-stat trade count agrees. |
| The global book/lens controls appeared on pages that ignored them. | Book selection is shown on Home, Strategies and Trades; the ML lens is shown on Strategies and scanner detail. Other views retain their own labelled filters. |
| Live implied every confirmed signal fills, ML always changes size, and native exits do not run. | Describe admission and pricing, conditional score fallback, base exit defaults and scanner/timeframe/research-plan overrides separately. |
| Lab described all fills using a single account commission; navigation promised stress tests and live arming. | Cost wording follows the engine’s current-product fee scenario and data coverage. Live is explicitly read-only. Removed stale Operations/Research navigation labels. |

## Validation

72 dashboard tests, dashboard lint and the production build pass locally. Regression coverage includes independent ML switches, unknown state, AUC limitations, historical versus current book participation, thirty-day quiet windows, weighted R/trade, route-aware control visibility and book-history navigation. CI and post-deployment browser checks are recorded with the release artifacts.

The API and all trading behavior are unchanged. Distinct pages are retained for their separate purposes: Strategies summarizes participation, Scanners manages runtime settings, Library holds source reviews, Incubator judges cells, Lab runs research and training, and Learn explains model evaluations.
