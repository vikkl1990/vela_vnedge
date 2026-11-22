# Limit entry replay — 2026-11-22

7906 limit-path signals, 120h horizon. Read README.md for the question, the arms and the reading rule, which were fixed before this ran.

## Counts

```
{
 "total": 7906,
 "limit:closed": 7149,
 "market:closed": 7733,
 "limit:unfilled": 633,
 "limit:censored": 111,
 "market:censored": 112,
 "market:rejected": 58,
 "limit:rejected": 9,
 "market:unverified": 3,
 "limit:unverified": 4,
 "used": 7773
}
```

## Result (per signal, net R after fees; ± is a standard error clustered by day)

| group | signals | fill rate | limit R/signal | market R/signal | limit − market | verdict | unfilled − filled (market R) |
|---|---:|---:|---:|---:|---:|---|---:|
| all (both books) | 7773 | 91.8% | -0.050 ±0.023 | -0.068 ±0.029 | +0.018 ±0.010 | no difference detected | +0.490 ±0.037 |
| book: account | 290 | 87.2% | -0.007 ±0.051 | -0.008 ±0.056 | +0.001 ±0.015 | no difference detected | +0.397 ±0.078 |
| book: shadow | 7483 | 92% | -0.052 ±0.023 | -0.070 ±0.028 | +0.018 ±0.010 | no difference detected | +0.494 ±0.036 |
| timeframe: 1h | 6176 | 90.7% | -0.048 ±0.020 | -0.074 ±0.024 | +0.027 ±0.010 | limit adds R | +0.493 ±0.034 |
| timeframe: 4h | 1597 | 96.3% | -0.060 ±0.056 | -0.043 ±0.061 | -0.017 ±0.012 | no difference detected | +0.543 ±0.062 |
| side: long | 3831 | 93.8% | -0.144 ±0.029 | -0.170 ±0.032 | +0.026 ±0.008 | limit adds R | +0.561 ±0.046 |
| side: short | 3942 | 89.9% | +0.041 ±0.042 | +0.032 ±0.050 | +0.009 ±0.019 | no difference detected | +0.407 ±0.063 |

"all (both books)" counts a signal once per book it reached; the account and shadow rows are the independent readings.

## Does the rebuilt reference and ATR match what the engine used?

Recorded 1h limit price implies an ATR; the ratio is the candle ATR over that implied ATR (1.00 = identical).

```
{
 "1h": {
  "n": 6261,
  "p10": 0.41431970429280796,
  "median": 1.11318795842602,
  "p90": 3.9284550761752013,
  "within10pct": "26%"
 }
}
```

## Does the replay reproduce the account?

```
{
 "recordedFills": 7250,
 "replayAlsoFilled": 7121,
 "replayDidNotFill": 129,
 "sameFillTimeAndPricePct": 98.3,
 "actualMeanR": -0.04662849909961482,
 "replayMeanR": -0.05345741861044745,
 "correlation": 0.933902845401967,
 "pairs": 7107
}
```

