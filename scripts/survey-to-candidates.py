#!/usr/bin/env python3
"""Turn `npm run survey` rows into incubator candidates for `ADD=file npm run incubate`.

A pair passes on the same terms as the daily screen: enough trades, a profit factor above the
threshold, most windows positive and still profitable at the stress cost. Passing here only earns a
slot in the shadow book, where the promotion gate decides on trades taken after selection.
"""
import csv, json, sys

rows = list(csv.DictReader(open(sys.argv[1]), delimiter='\t'))
MIN_TRADES, MIN_PF, MIN_WINDOWS = 20, 1.2, 5
out = []
for r in rows:
    t, pf, w, stress = int(r['trades']), float(r['pf']), int(r['windowsUp']), float(r['netStress'])
    if not (t >= MIN_TRADES and pf >= MIN_PF and w >= MIN_WINDOWS and stress > 0 and float(r['net']) > 0):
        continue
    out.append({'scannerId': r['scanner'], 'symbol': r['symbol'], 'tf': r['tf'], 'result': {
        'pass': True, 'at': 0, 'trades': t, 'profitFactor': pf, 'netPnl': float(r['net']), 'netAtStress': stress,
        'windowsUp': w, 'winRatePct': 100 * int(r['wins']) / t, 'avgR': float(r['avgR']), 'bars': 0, 'days': float(r['days'])}})
# Cap markets per script×timeframe: one strategy's 25 markets are largely the same bet, and the
# shadow book has ~100 slots that should test different ideas. Keep the strongest by evidence.
PER_SCRIPT = int(sys.argv[3]) if len(sys.argv) > 3 else 5
score = lambda x: (min(x['result']['profitFactor'], 5) - 1) * (x['result']['trades'] ** 0.5) * x['result']['windowsUp'] / 8
kept, seen = [], {}
for x in sorted(out, key=score, reverse=True):
    k = (x['scannerId'], x['tf'])
    if seen.get(k, 0) >= PER_SCRIPT: continue
    seen[k] = seen.get(k, 0) + 1; kept.append(x)
out = kept
json.dump(out, open(sys.argv[2], 'w'), indent=1)
print(f'{len(out)} candidates (max {PER_SCRIPT} markets per script×timeframe) of {len(rows)} pairs tested ({MIN_TRADES}+ trades, PF ≥ {MIN_PF}, {MIN_WINDOWS}+/8 windows, profitable at the stress cost)')
by = {}
for x in out: by[(x['scannerId'], x['tf'])] = by.get((x['scannerId'], x['tf']), 0) + 1
for (s, tf), n in sorted(by.items(), key=lambda kv: -kv[1])[:20]: print(f'  {s[:46]:46} {tf:3} {n:2} markets')
