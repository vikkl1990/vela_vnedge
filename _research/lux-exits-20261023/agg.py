import csv, glob, os, sys, collections
D = sys.argv[1]
V = ['spread', 'lux-sig', 'lux-sig+ours', 'lux-stat1', 'lux-stat2', 'lux-stat2+ours', 'lux-ms', 'lux-ms+ours']
tot = {v: collections.defaultdict(lambda: {'n': 0, 'R': 0.0, 'h1': 0.0, 'h2': 0.0, 'cells': 0, 'cellsUp': 0, 'bothUp': 0, 'better': 0}) for v in V}
cells = 0
for f in sorted(glob.glob(D + '/*.tsv')):
    by = collections.defaultdict(dict)
    for r in csv.DictReader(open(f), delimiter='\t'):
        by[(r['tf'], r['symbol'])][r['variant']] = r
    for (tf, sym), d in by.items():
        if 'spread' not in d or int(d['spread']['trades']) == 0: continue
        cells += 1
        base = float(d['spread']['sumR'])
        for v in V:
            if v not in d: continue
            s = d[v]; n = int(s['trades']); R = float(s['sumR'])
            h1 = float(s['r1']) * int(s['t1']); h2 = float(s['r2']) * int(s['t2'])
            for key in ('all', tf):
                t = tot[v][key]
                t['n'] += n; t['R'] += R; t['h1'] += h1; t['h2'] += h2; t['cells'] += 1
                t['cellsUp'] += R > 0; t['bothUp'] += (h1 > 0 and h2 > 0); t['better'] += (R > base) if v != 'spread' else 0
print(f'cells with trades: {cells}')
for key in ('all', '15m', '1h', '4h'):
    print(f'\n== {key} ==')
    print(f"{'variant':16} {'trades':>7} {'sumR':>8} {'R/trade':>8} {'half1':>7} {'half2':>7} {'cells+':>7} {'both+':>6} {'> base':>7}")
    for v in V:
        t = tot[v][key]
        if not t['cells']: continue
        print(f"{v:16} {t['n']:7} {t['R']:8.1f} {t['R']/max(1,t['n']):8.3f} {t['h1']:7.1f} {t['h2']:7.1f} {t['cellsUp']:4}/{t['cells']:<3} {t['bothUp']:6} {t['better'] if v!='spread' else '-':>7}")
