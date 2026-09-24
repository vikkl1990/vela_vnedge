# Pair-specific take-profits

Settings → Pair take-profits lets each exact Delta symbol use its own three target distances and contract allocation. Unlisted pairs retain the global policy. This feature does not select profitable targets automatically or change the VM configuration.

Targets are measured in price-R: `abs(entry reference - resolved stop)`. Long targets add the risk multiple; short targets subtract it. Fees, slippage and funding affect the net result. These settings do not change stop placement, position sizing, trailing protection, time limits or the scanner's exit mode.

- **Fallback:** use pair targets and allocation only when the script supplies no valid targets. Valid script targets keep the global allocation.
- **Override:** replace script target prices with the pair's R-based ladder and use its allocation. Script exit events can still close/reduce the trade according to the scanner's exit mode; choose `levels` separately if that is desired.
- Removing a pair restores global behaviour for future entries. The merge-based API uses `null` to remove a policy.
- Existing positions keep their stored targets and leg quantities. Pending tape entries keep the accepted target prices and allocation even if settings change before the fill. Their absolute targets are revalidated against the fill price.

Example configuration shape (illustrative, not calibrated recommendations):

```json
{
  "paper": {
    "takeProfitBySymbol": {
      "BTCUSD": { "mode": "override", "rr": [1, 2, 3], "split": [0.4, 0.3, 0.3] },
      "ETHUSD": { "mode": "fallback", "rr": [0.75, 1.25, 2], "split": [0.5, 0.3, 0.2] },
      "AKEUSD": null
    }
  }
}
```

Use `PUT /api/config` through the existing authenticated settings API. Values must be three finite positive strictly increasing risk multiples, and three nonnegative allocation fractions totalling one. Symbols must be uppercase alphanumeric exchange symbols. Unknown symbols have no effect until traded; the schema does not fetch an exchange product list during validation. Distances that collapse to fewer than three distinct prices after tick rounding are rejected at entry.

Pair allocations use whole contracts. One contract is assigned to the earliest nonzero target. For larger quantities, floor the desired amounts and assign the remaining contracts by largest fractional remainder, preferring earlier targets on ties. Zero-weight legs receive none. Small quantities may still leave a later target empty; the position displays actual leg quantities. Global allocations retain their previous rounding behaviour.

The shared level resolver applies these policies in live paper entries, delayed tape entries, main/incubator shadow trading, validation shadow books, backtests and entry-feature calculations. The settings are per symbol across all scanners/timeframes, not simultaneous scalp/intraday/runner profiles. Run fresh backtests after changing a policy; stored historical results and trades are not rewritten.

Tests cover long/short targets, pair isolation, script precedence, tick rounding, malformed settings, contract conservation, one-contract entries, candle/tape paths, pending configuration changes, backtests and deletion through config merge.
