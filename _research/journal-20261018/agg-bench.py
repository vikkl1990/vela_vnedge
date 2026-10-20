import sys,glob,csv,collections as C,statistics as st
D=sys.argv[1]; cells=C.defaultdict(dict)
for f in glob.glob(D+'/bench-*.tsv'):
    for r in csv.DictReader(open(f),delimiter='\t'): cells[(r['scanner'],r['tf'],r['symbol'])][r['variant']]=r
have=[k for k,d in cells.items() if 'sig-atr' in d and int(d['sig-atr']['trades'])>=10 and sum(1 for v in d if v.startswith('rand-'))==20]
print(f'{len(have)} cells with 10+ trades on their own entries (of {len(cells)})')
rows=[]
for k in have:
    d=cells[k]; s=float(d['sig-atr']['sumR']); rs=sorted(float(d[f'rand-{i}']['sumR']) for i in range(1,21))
    pct=sum(1 for x in rs if x<s)/20; med=st.median(rs)
    rows.append(dict(k=k,s=s,med=med,pct=pct,n=int(d['sig-atr']['trades']),spread=float(d['spread']['sumR']) if 'spread' in d else None,
        long=float(d['sig-long']['sumR']),short=float(d['sig-short']['sumR']),nl=int(d['sig-long']['trades']),ns=int(d['sig-short']['trades']),drift=float(d['drift']['sumR']),
        s1=float(d['sig-atr']['r1'])*int(d['sig-atr']['t1']),s2=float(d['sig-atr']['r2'])*int(d['sig-atr']['t2']),
        m1=st.median(float(d[f'rand-{i}']['r1'])*int(d[f'rand-{i}']['t1']) for i in range(1,21)),m2=st.median(float(d[f'rand-{i}']['r2'])*int(d[f'rand-{i}']['t2']) for i in range(1,21))))
def summary(R,label):
    if not R: return
    beat90=sum(r['pct']>=0.9 for r in R); above=sum(r['pct']>0.5 for r in R); below10=sum(r['pct']<=0.1 for r in R)
    print(f"\n{label}: {len(R)} cells")
    print(f"  scanner entries {sum(r['s'] for r in R):+.1f}R against the random median {sum(r['med'] for r in R):+.1f}R (difference {sum(r['s']-r['med'] for r in R):+.1f}R)")
    print(f"  halves: scanner {sum(r['s1'] for r in R):+.1f} / {sum(r['s2'] for r in R):+.1f}R, random median {sum(r['m1'] for r in R):+.1f} / {sum(r['m2'] for r in R):+.1f}R")
    print(f"  cells above 90% of their random runs {beat90}, above the median {above}, at or below 10% {below10}")
summary(rows,'all')
for tf in ('15m','1h','4h'): summary([r for r in rows if r['k'][1]==tf],tf)
print('\nper cell, sorted by percentile:')
for r in sorted(rows,key=lambda r:-r['pct']):
    print(f"  {r['k'][0][:40]:40} {r['k'][2]:11} {r['k'][1]:3} n={r['n']:3d} scanner {r['s']:+6.1f}R  random median {r['med']:+6.1f}R  beats {r['pct']*100:3.0f}% of random runs | long {r['long']:+5.1f} ({r['nl']}) short {r['short']:+5.1f} ({r['ns']}) drift {r['drift']:+5.1f}%")
# directional: does the long-minus-short gap follow the market's drift?
import math
xs=[r['drift'] for r in rows]; ys=[(r['long']/max(1,r['nl']))-(r['short']/max(1,r['ns'])) for r in rows]
mx,my=sum(xs)/len(xs),sum(ys)/len(ys); cov=sum((a-mx)*(b-my) for a,b in zip(xs,ys)); sx=math.sqrt(sum((a-mx)**2 for a in xs)); sy=math.sqrt(sum((b-my)**2 for b in ys))
print(f"\ndirection: correlation between the market's drift and (long R a trade minus short R a trade) across cells: {cov/(sx*sy):+.2f}")
up=[r for r in rows if r['drift']>0]; dn=[r for r in rows if r['drift']<=0]
for name,R in (('market rose',up),('market fell',dn)):
    if R: print(f"  {name}: {len(R)} cells; longs {sum(r['long'] for r in R):+.1f}R over {sum(r['nl'] for r in R)} trades, shorts {sum(r['short'] for r in R):+.1f}R over {sum(r['ns'] for r in R)}")
