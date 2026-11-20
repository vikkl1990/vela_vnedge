# Vela and Quant update assessment

Verified 20 November 2026 against the npm registry and official LuxAlgo sources.

| Component | Repository / VM pin | Latest published | Action in this task |
| --- | --- | --- | --- |
| @luxalgo/vela | 0.10.5 | 0.10.13 (17 November) | Reviewed; no upgrade bundled with exit experiment |
| @luxalgo/vela-pinets | 0.3.4 | 0.3.4 | Current |
| pinets | 0.13.1 | 0.13.1 | Current |

Sources: [Vela registry](https://registry.npmjs.org/@luxalgo%2fvela),
[bridge registry](https://registry.npmjs.org/@luxalgo%2fvela-pinets),
[PineTS registry](https://registry.npmjs.org/pinets),
[Vela changelog](https://github.com/LuxAlgo/Vela/blob/main/CHANGELOG.md),
[bridge changelog](https://github.com/LuxAlgo/Vela-pinets/blob/main/CHANGELOG.md).

Vela 0.10.6–13 primarily improves chart interaction: drawing persistence, settings width,
multi-select controls, extra built-in indicators, plot rendering, scroll-following menus,
and drawing actions. The line-rendering improvement and menu fixes are relevant to our dense
chart UI. They are not an upgrade to the server's pinned PineTS scanner/execution engine.
Upgrade and chart-test that dependency separately to avoid confounding exit comparisons.

## Quant 2.0 Backtest Loop

The user's [Quant page](https://www.luxalgo.com/features/quant/) describes a hosted strategy
generation/backtest workflow. The [official guide](https://docs.luxalgo.com/platform/quant/backtest-loop)
documents multi-market goals, hidden out-of-sample scoring, rejection of lookahead/repainting
and duplicate attempts, costs and money management, plus a full attempts report. It runs on
LuxAlgo's servers under Ultimate or Ultra; up to five markets, one to five found strategies,
and a 10-minute to four-hour budget. Its default capital is $100,000 unless overridden.

Useful for VN EDGE: propose alternative exit logic, compare across several markets, inspect
author-native trades, and retain every attempted version. It does not establish execution
parity with our Delta India account. We found no documented public Quant-loop API in the
reviewed package exports and official guide; upgrading the open-source chart package alone
does not activate the hosted Quant service. No subscription, account access, usage purchase,
strategy upload, hosted loop or outbound message was initiated.

## Suitable evaluation route

1. Use the existing reviewed scanner source and freeze entry rules. Request exit-only
   variants, explicitly name $1,000 research capital and actual per-entry sizing; avoid
   Quant's $100,000 default. Preserve current risk ceilings and realistic costs.
2. Keep development dates distinct from an untouched later period. Require every chosen
   market to pass; retain failed attempts and do not repeatedly tune to a failed holdout.
3. Export code and trade ledger, check source/reader parity locally, then replay the same
   entries using Delta India bid/ask, depth, latency, fees, tax, offer timing and funding.
4. Compare net profit, SLs, total losses and damage to actual winners, including adverse
   execution stress and missing-data coverage. Existing promotion evidence remains separate.
5. Only a later successful prospective comparison can justify paper-exit adoption. A good
   hosted backtest cannot replace this test or demonstrate improvements to current trades.

Recommendation: use Quant as a candidate research tool if the account already has access.
The immediate blocker found here is replay observability and failed profit protection, not
the chart package version. No runtime dependency was changed by this assessment.
