# Liquid-pair expansion for Stealth and Trend Continuation — 15 November 2026

Two additional 1h cells pass the research shortlist: native Stealth on ZECUSD and Trend Continuation on UNIUSD. Add them only as prospective experimental shadow plans. The six BTC/ETH/SOL import cells and every existing policy retain their identities; no account scanner is enabled by this change.

## Method

The first screen covered 20 current liquid crypto perpetuals × three timeframes (15m, 1h, 4h) × two scanners: 120 combinations, 110 with sufficient warmup. Use 60 days ending 15 November 00:00 UTC, split 40 development / 20 later days, plus 1,000 warmup bars. Only the existing Stealth ETH 15m cell passed the shortlist. It remains unchanged.

Because slower strategies had too few trades, extend **all 20 markets at both 1h and 4h** to 180 days (120 development / 60 later), with the same requirements: at least 25 closes overall, 15 development, 8 later, later PF >= 1.2, and positive development and later net in both base and stress cases. 68 of 80 combinations had sufficient warmup. No indicator inputs or gates were tuned. This extension is retrospective confirmation, not a fresh holdout: part of its later period was already examined in the first screen.

Universe selection used today's Delta India turnover >= $1M, spread <= 10 bps, operational status and complete bid/ask depth for $750 notional. It covers BTC, ETH, SOL, EVAA, XRP, ZEC, ARIA, UNI, INIT, AAVE, LINK, DOGE, PIEVERSE, BNB, LTC, AIN, AVAX, MUB, HYPE and BLESS. This is a current-universe study with survivorship bias, not a historical universe reconstruction.

Use the deployed native readers, native stops/targets, fixed $1,000 reference equity, $150 margin, existing 3% stop ceiling, current regime rules and 6x stop/fee gate. Charge full product maker/taker fees and 18% GST; no scalper waiver. Baseline crossing is at least 4 bps round trip, stress at least 10 bps. Both chosen products publish 0.02% maker and 0.05% taker before GST in the retrieved product metadata. Today's book is only a suitability check, not evidence of past executable depth.

Finalists were replayed on 259,200 one-minute bars each. The initial download had 26 missing minutes at chunk/outer boundaries; smaller overlapping requests recovered all of them from Delta. No interpolation or synthetic candle was used. Every closed trade's entry bar was rerun with the actual rolling 1,000-bar runtime history: 105 checks, zero side/stop/target mismatches within one tick.

## Minute-path results

These are historical **simulations**, after modeled trading fees/crossing, before actual historical funding. Dollar results belong to independent reference books, not the current account's realized profit.

| Cell | Development closes / net | Later closes / net | Later PF | Later full SL exits | Later net, paired crossing + funding sensitivity |
|---|---:|---:|---:|---:|---:|
| Stealth · ZECUSD 1h | 52 / +$414.98 | 25 / +$165.16 | 1.87 | 5 | +$154.23 |
| Trend Continuation · UNIUSD 1h | 16 / +$27.72 | 11 / +$144.65 | 2.20 | 5 | +$138.11 |

The paired stress charges extra crossing on the **same baseline trades**, plus an adverse 0.01% notional per started eight hours as a sensitivity. This is not Delta's historical funding schedule, a measured settlement cost or a worst-case bound. Paired development net remains +$384.34 for ZEC and +$15.13 for UNI; UNI's development margin is thin. Re-running admission under stressed costs also remains positive, but that changes which trades are admitted and is not reported as paired improvement.

Both have one unresolved trade at the end. None is counted as a win. Reserving another $30 stop budget leaves later paired totals positive; this is not a guarantee against gap losses or funding. Entry cohorts are split by setup time, and only trades closed within that period count in its table. These are low-frequency swing candidates (25 and 11 closes in 60 later days), not a promise of ten daily scalp trades.

## Rollout and limitations

Add `liquid-stealth-zecusd-1h-v1` and `liquid-trend-continuation-uniusd-1h-v1`, increasing only experimental-plan capacity from 79 to 81. The guarded installer supports dry run, backs up atomically, refuses edited plans/readers and preserves all other configuration. Existing account/shadow policies, risk controls, fees and evidence qualification are untouched. Experiments do not count for promotion/copying/sizing; ordinary prospective qualification remains required before any paper admission.

Minute OHLC still cannot prove exact tick path, queue priority or live profitability. Native market data, historical cost coverage and source hashes are saved in the companion JSON and local raw research directory. Forward scans and causal fills must confirm these hypotheses. If a candidate remains quiet, do not invent entries or weaken gates.

## Reproduction and sources

The companion JSON records every screened result, selection requirements, data coverage, hashes and local artifact directory. Run the saved `screen.ts` in that directory for the 60-day screen, its `swing-180d/screen.ts` counterpart for the extension, and `confirm.ts` for minute replay and rolling-history checks. Private VM config is stored locally with restrictive permissions and is not committed.

Public production data: [Delta India products](https://api.india.delta.exchange/v2/products), [tickers](https://api.india.delta.exchange/v2/tickers), [candle history](https://api.india.delta.exchange/v2/history/candles), [ZEC depth](https://api.india.delta.exchange/v2/l2orderbook/ZECUSD), [UNI depth](https://api.india.delta.exchange/v2/l2orderbook/UNIUSD). Retrieved 15 November 2026; exact verification time is in the companion JSON.
