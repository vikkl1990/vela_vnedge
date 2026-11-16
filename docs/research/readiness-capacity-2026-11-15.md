# Account readiness after removing global position ceilings

Verification snapshot: 15 November 2026, 14:40:57 UTC. Deployed baseline: `d20b460a05e687b76887d73983a570855dd633d6`.

The previous implementation required the full saved policy hash to equal today's policy hash. Removing the two global count ceilings changed that hash, although each recorded trade's execution and sizing rules were unchanged. Historical trades were excluded from readiness; no journal rows were deleted.

## Measured comparison

The audit copied account rows, policy snapshots, exclusions, source hashes and redacted configuration into an in-memory database. It used current public Delta India product fees and the current policy builder. Its exact-match count agreed with the live API before evaluating compatibility.

| Last 30 days | Count |
| --- | ---: |
| Closed account trades | 1,040 |
| Eligible provenance and scope before policy matching | 294 |
| Exact current-policy match | 1 |
| Additional count-only compatible trades | 13 |
| Proposed readiness total | 14 |
| Still excluded | 1,026 |

The 13 restored trades include ten winners and three losers. All 14 total $46.51 net and +3.059R as originally recorded. These figures describe the selected historical sample, not a profitability improvement or forecast. Older accepted-policy trades that closed after the earlier readiness check explain why 13 can be restored when that earlier check showed 11.

All 280 eligible-but-incompatible records differ in `risk.ddScale`; subsets also differ in execution version, maker pricing configuration or verified offer settings. They are not included by this correction. Other exclusions include unknown/adopted provenance, non-account evidence scope and quarantined fills.

## Compatibility boundary

- Only expansions of the two account-wide count ceilings qualify. Zero denotes no count limit. Tightening is excluded.
- All other policy fields must match, including all sizing and risk settings. Both policy hashes are verified against their saved contents.
- Existing trade-level evidence exclusions and the readiness window remain in force. Promotion, copying and leverage selection are untouched.
- Full policy identities and all journal values remain immutable. No trades are invented, repriced or promoted, and no higher trade frequency is assumed.
- The UI reports exact and capacity-compatible readiness counts separately. Historical returns cannot certify future portfolio behavior with more simultaneous positions.

## Validation and rollout

Regression coverage includes count-only expansions, tightening, malformed/tampered snapshots, source and reader changes, fees and tax, offer eligibility, latency, stops, margin/leverage/capital, risk caps, regime, cooldown and ML policy differences. Database tests retain both winners and losers, reject excluded evidence and prove the journal/configuration are unchanged. The learning-to-readiness test retains the 200-trade threshold and 30-day window. Desktop and phone checks cover the displayed compatibility explanation.

Deploy code and dashboard only after tests pass. Verify restored readiness counts against the deployed API and compare the configuration checksum before and after deployment. Paper mode, $150 margin, the 3% stop-risk cap, remaining risk controls and research/evidence settings require no configuration changes.
