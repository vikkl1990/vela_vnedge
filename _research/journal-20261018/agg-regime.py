import sys,glob,csv,collections as C
D=sys.argv[1]; V=['spread','spread+er0.1','spread+er0.15','spread+er0.2','spread+er0.25']
for tag in ('majors','fleet'):
    cells=C.defaultdict(dict)
    for f in glob.glob(f'{D}/{tag}-*.tsv'):
        for r in csv.DictReader(open(f),delimiter='\t'):
            if r['variant'] in V: cells[(r['scanner'],r['tf'],r['symbol'])][r['variant']]=r
    have=[k for k,d in cells.items() if all(v in d for v in V) and int(d['spread']['trades'])>=10]
    print(f'\n===== {tag}: {len(have)} cells with 10+ trades ungated (of {len(cells)})')
    def block(keys,label):
        if not keys: return
        print(f'  -- {label} ({len(keys)} cells)')
        print(f"     {'variant':16} {'trades':>7} {'sum R':>8} {'R/trade':>8} {'1st half':>9} {'2nd half':>9} {'cells better':>12} {'worse':>6}")
        for v in V:
            t=sum(int(cells[k][v]['trades']) for k in keys); s=sum(float(cells[k][v]['sumR']) for k in keys)
            h1=sum(float(cells[k][v]['r1'])*int(cells[k][v]['t1']) for k in keys); h2=sum(float(cells[k][v]['r2'])*int(cells[k][v]['t2']) for k in keys)
            up=sum(1 for k in keys if float(cells[k][v]['sumR'])-float(cells[k]['spread']['sumR'])>0.5); dn=sum(1 for k in keys if float(cells[k][v]['sumR'])-float(cells[k]['spread']['sumR'])<-0.5)
            print(f"     {v:16} {t:7d} {s:+8.1f} {s/max(t,1):+8.3f} {h1:+9.1f} {h2:+9.1f} {up:12d} {dn:6d}")
    block(have,'all')
    for tf in ('15m','1h','4h'): block([k for k in have if k[1]==tf],tf)
    if tag=='majors':
        for sym in ('ETHUSD','BTCUSD','SOLUSD','XRPUSD'): block([k for k in have if k[2]==sym],sym)
