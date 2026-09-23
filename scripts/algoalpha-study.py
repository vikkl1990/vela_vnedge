#!/usr/bin/env python3
"""Build the AlgoAlpha study: what each script claims, what it emits, and how it tested.

  scripts/algoalpha-study.py survey.tsv > docs/ALGOALPHA-STUDY.md

Sources: the published description (what the author says it does), the manifest (whether the source
runs here) and a fresh survey (whether it signals at all, and what those signals are worth after
costs). Nothing here is a recommendation: passing the survey only earns a shadow-book slot.
"""
import csv, json, re, sys, collections

survey = list(csv.DictReader(open(sys.argv[1]), delimiter='\t'))
man = {x['id']: x for x in json.load(open('scripts/manifest.json'))}
desc = json.load(open('data/imports/AlgoAlpha-descriptions.json'))
ids = [i for i, x in man.items() if x.get('author') == 'AlgoAlpha']
by_pub = {x['pub']: i for i, x in man.items() if x.get('author') == 'AlgoAlpha' and x.get('pub')}
meta = {by_pub[p]: d for p, d in desc.items() if p in by_pub}

def summarise(text: str) -> str:
    """One plain line: the first real sentence of the description, stripped of markup."""
    t = re.sub(r'!\[[^\]]*\]\([^)]*\)|\[[^\]]*\]\([^)]*\)', ' ', text)
    t = re.sub(r'[#*_`>🟠🔵🟢🔴⚡📈📉🚀✅⭐️→•]+', ' ', t)
    t = re.sub(r'\s+', ' ', t).strip()
    for sent in re.split(r'(?<=[.!?])\s+', t):
        s = sent.strip()
        if len(s) > 40 and not s.lower().startswith(('how to use', 'disclaimer')):
            return (s[:200] + '…') if len(s) > 200 else s
    return t[:160]

TF_ORDER = ['5m', '15m', '1h', '4h']
res = collections.defaultdict(lambda: collections.defaultdict(lambda: dict(t=0, net=0.0, st=0.0, w=0, n=0, mk=0)))
for r in survey:
    a = res[r['scanner']][r['tf']]
    a['t'] += int(r['trades']); a['net'] += float(r['net']); a['st'] += float(r['netStress'])
    a['w'] += int(r['windowsUp']); a['n'] += 1; a['mk'] += float(r['net']) > 0

def passes(a):
    return a['t'] >= 30 and a['st'] > 0 and a['net'] > 0 and a['mk'] >= 3 and a['w'] / a['n'] >= 4

def verdict(rows):
    """A script passes if ANY timeframe qualifies; otherwise it is judged at its best one."""
    if not rows: return 'no signals', ''
    winners = {tf: a for tf, a in rows.items() if passes(a)}
    if winners:
        tf = max(winners, key=lambda t: winners[t]['st'])
        return 'PASSES', tf
    best_tf, b = max(rows.items(), key=lambda kv: kv[1]['st'])
    if b['t'] < 30: return f'too few trades ({b["t"]})', best_tf
    if b['net'] <= 0: return 'loses', best_tf
    if b['st'] <= 0: return 'loses at 10 bps', best_tf
    if b['mk'] < 3: return f'works on {b["mk"]}/{b["n"]} markets only', best_tf
    return f'{b["w"] / b["n"]:.1f}/8 windows', best_tf

print('# AlgoAlpha: every published script, studied and tested\n')
print(f'{len(ids)} scripts by AlgoAlpha are in the library. Each was run fresh on 5m, 15m, 1h and 4h across five markets '
      '(BTC, ETH, SOL, XRP, DOGE) with the live exit rules, exits resolved on 1m (5m/15m) or 15m (1h/4h) candles, '
      'fees including GST, the Scalper Offer, and a 10 bps cost stress. A script "passes" only with 30+ trades, a profit '
      'that survives the stress, at least three of five markets profitable and half the time windows positive — and passing '
      'earns a shadow-book slot, not live trading.\n')
rows = []
for i in ids:
    m, d = man[i], meta.get(i, {})
    tfs = res.get(i, {})
    v, tf = verdict(tfs)
    best = tfs.get(tf, {}) if tf else {}
    rows.append(dict(id=i, name=d.get('name') or m['name'], type=d.get('type', '?'), likes=d.get('likes', 0),
                     status=m['status'], what=summarise(d.get('description', '')), verdict=v, tf=tf or '',
                     trades=best.get('t', 0), net=best.get('net', 0.0), stress=best.get('st', 0.0),
                     mk=f"{best.get('mk', 0)}/{best.get('n', 0)}" if best else '', win=f"{best['w']/best['n']:.1f}" if best else ''))
order = {'PASSES': 0}
rows.sort(key=lambda r: (order.get(r['verdict'], 1), -r['stress'], -r['likes']))

passed = [r for r in rows if r['verdict'] == 'PASSES']
traded = [r for r in rows if r['trades']]
print(f'**Result: {len(passed)} of {len(ids)} pass. {len(traded)} produce any trade at all; '
      f'{len(rows) - len(traded)} never signal an entry (they are dashboards, screeners and drawing tools), '
      f'and {sum(1 for r in rows if r["status"] != "ok")} cannot run here.**\n')
print('## Scripts that pass\n')
print('| Script | Type | TF | Trades | Net | At 10 bps | Markets | Windows | What it does |')
print('|---|---|---|---|---:|---:|---|---|---|')
for r in passed:
    print(f"| **{r['name']}** | {r['type']} | {r['tf']} | {r['trades']} | {r['net']:.0f} | {r['stress']:.0f} | {r['mk']} | {r['win']}/8 | {r['what']} |")
print('\n## Scripts that trade but do not pass\n')
print('| Script | Best TF | Trades | Net | At 10 bps | Why not | What it does |')
print('|---|---|---:|---:|---:|---|---|')
for r in rows:
    if r['trades'] and r['verdict'] != 'PASSES':
        print(f"| {r['name']} | {r['tf']} | {r['trades']} | {r['net']:.0f} | {r['stress']:.0f} | {r['verdict']} | {r['what']} |")
print('\n## Scripts that never signal an entry\n')
print('These draw levels, zones, dashboards or screens; they have no entry a bot can act on.\n')
print('| Script | Type | Status | What it does |')
print('|---|---|---|---|')
for r in rows:
    if not r['trades']:
        print(f"| {r['name']} | {r['type']} | {'runs' if r['status'] == 'ok' else r['status']} | {r['what']} |")
