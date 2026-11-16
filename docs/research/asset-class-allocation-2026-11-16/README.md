# Asset-class allocation and paper eligibility — 16 November 2026

The screenshot's 34 is the number of direct account allocations; 33 additional cells passed paper-copy checks at the audit snapshot. These are different paths, not a 34-cell count limit.

## Measured bottleneck

Read-only evaluation used the deployed source, merged scanner specifications, current product fees and the same policy/evidence functions as the runtime. No positions, flags, restoration enrollments or configuration were modified by the audit.

| Current shadow copy decision | Cells |
|---|---:|
| Pass | 33 |
| Fewer than five qualifying closes | 921 |
| Enough closes, net R not positive | 65 |
| Prospective restoration test incomplete | 31 |
| Enough closes and positive net R, turnover below $2M | 31 |
| Total | 1,081 |

528 cells had zero **qualifying** trades; only 157 had zero raw closed shadow trades. Across these cells, 8,574 raw closes comprise 2,274 exact-policy matches, 1,602 changed-policy, 4,400 legacy, three quarantined and 295 otherwise excluded outcomes. These counts are not permission to reclassify incompatible history.

Of 1,446 passing screen candidates, 996 were outside/refused by the market stage, 301 lacked a shadow slot, 111 needed a fresh screen, 25 were in rotation cooldown, seven had unavailable scanners and six had expired screens. Shadow capacity was already full; no capacity increase is included.

## Implemented changes

1. **One turnover floor, with actual-size execution checks.** The user explicitly requested minimal turnover requirements. The guarded migration aligns shadow admission, paper copying and full promotion with the existing $50,000 execution discovery floor, from $1M/$2M/$5M. It requires paper mode, fresh depth, a positive execution cost ceiling and no depth exemptions. Only those three configuration fields change. Copy samples, positive net R, promotion statistics, restoration, capital, leverage, stops, risk caps and evidence identities remain unchanged.
2. **Use classes to choose research, not to gate entries.** Fresh, matching-policy training halves from other markets in the same group and timeframe rank scanner research. Markets get equal weight, outliers are bounded and sparse peer sets are shrunk. The target market and held-out results are excluded. Stocks, metals and energy are separate pools. A regular exploration turn and market rotation keep unknown or weak classes reachable.
3. **Research the requested cells only.** A batch previously expanded scanner IDs × symbols and could rescreen active/tested cells. Jobs now persist an exact cell set through the queue into the screener; unrelated combinations neither run nor receive retry timestamps.
4. **Complete the next evidence sample.** Shadow scheduling recognizes the existing five-close copy milestone before the larger promotion sample. It still prioritizes sample completion independently of positive/negative P&L and retains the bounded dispatch, deadlines and exploration turns. This changes order, not qualification.
5. **Correct planning and classification.** Screen frequency now divides all training-plus-holdout trades by the full history duration, instead of dividing training trades by the full duration. OIL is energy despite Delta's broad metal tag; explicit AI tags take precedence over old meme-name fallbacks. Non-crypto discovery respects an explicitly configured non-crypto universe. The VM's crypto-only setting is unchanged.
6. **Expose selection.** The existing Pair Agents panel shows each market's class and the next research candidates with their rationale. Research scores are explicitly not paper qualification or profit forecasts.

## Expected eligibility effect and depth measurements

At the same snapshot, aligning floors changes copy eligibility from **33 to 56**, recovering 23 cells across 15 markets. Eight turnover-only cells remain below the existing execution minimum. These are eligible sources of future signals, not orders or promised fills.

Three rounds of public Delta India order books on the 18 turnover-blocked markets yielded 54 requests: 53 readable books and one timeout. Using production `freshDepthGate`, real contract values, both sides of depth, exchange timestamps and full undiscounted commissions plus GST:

| Approximate notional | Passed / readable samples |
|---|---:|
| $250 (current base copy size) | 50 / 53 |
| $750 (base direct account size) | 50 / 53 |
| $1,500 (larger size stress) | 46 / 53 |

BTW failed the unchanged 0.25% cost ceiling in all three rounds, even at $250. WLD failed at $1,500 and SKYAI failed one $1,500 sample. Actual entry checks remain mandatory and can reject these newly eligible sources. A timeout is unavailable evidence, not a pass.

This is a same-snapshot eligibility comparison and a public depth observation. It is **not a P&L backtest**, proof of future liquidity, or a measured improvement in net profit. No historical fills were fabricated. Forward monitoring must compare new eligible signals, fills, costs, net R and stop rate by scanner/market/TF.

## Sources and reproducibility

- [Delta India public products](https://api.india.delta.exchange/v2/products): contract values, product commissions and tags.
- [Delta REST documentation](https://docs.delta.exchange/#get-l2-orderbook): public depth schema.
- Machine-readable counts, source URLs, verification timestamp and recovered cells: [assessment.json](assessment.json).
- Run `node ops/align-research-turnover.ts --dry-run --config=data/config.json` before the guarded migration.

Validation: server regression suite, separate actual-depth and alignment tests, server typecheck, dashboard build/lint, and desktop/mobile browser checks. The migration is dry-run safe, idempotent, private and backed up; tests verify unchanged trade-policy identities and risk settings.
