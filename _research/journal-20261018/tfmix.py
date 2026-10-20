import json,sys,collections as C,datetime as D
S=sys.argv[1]; A=json.load(open(S+'/tfmix.json'))['all']
P={p['symbol']:p for p in json.load(open(S+'/products.json'))['result']}
FEE=0.0005*1.18; BUF=0.25; MG=150.0; MAXOPEN=8
for t in A:
    p=P.get(t['symbol']); t['cap'],t['maint']=(int(100/float(p['initial_margin'])),float(p['maintenance_margin'])) if p else (20,2.5)
    t['stop']=abs(t['entry_price']-t['sl_original'])/t['entry_price']; t['n0']=t['qty']*t['cv']*t['entry_price']
    t['R']=(t['realized_pnl']-t['fees'])/t['risk_amount']; t['cell']=(t['scanner_id'],t['symbol'],t['tf'])
H=sorted([t for t in A if t['bt']==2],key=lambda t:t['exit_at']); byc=C.defaultdict(list)
for h in H: byc[h['cell']].append(h)
for t in A:
    xs=[h['R'] for h in byc[t['cell']] if h['exit_at']<=t['entry_at']][-30:]
    tier=20 if len(xs)>=5 and sum(xs)/len(xs)>0.05 else 5
    t['L']=max(1,min(tier,t['cap'],1/(t['stop']*(1+BUF)+t['maint']/100)))
def run(X,fac,cap15=None):
    ev=[(t['entry_at'],1,t) for t in X]+[(t['exit_at'],0,t) for t in X]; ev.sort(key=lambda e:(e[0],e[1]))
    eq=1000.0; pk=1000; dd=0; op={}; mg_used=0.0; out=[]
    for at,k,t in ev:
        if k==1:
            if t['levels_source']!='atr-fallback': continue
            m=MG*fac.get(t['tf'],1)
            if len(op)>=MAXOPEN or eq-mg_used<m: continue
            if cap15 is not None and t['tf']=='15m' and sum(1 for v in op.values() if v[1]=='15m')>=cap15: continue
            op[t['id']]=(m,t['tf']); mg_used+=m; continue
        if t['id'] not in op: continue
        m,tf=op.pop(t['id']); mg_used-=m; n=m*t['L']; kq=n/t['n0']; liqR=(1/t['L']-t['maint']/100)/t['stop']
        pnl=(-m-n*FEE) if (t['worst_r'] or 0)<=-liqR else (t['realized_pnl']-t['fees'])*kq
        eq+=pnl; pk=max(pk,eq); dd=max(dd,(pk-eq)/pk); out.append((t,pnl,m/MG))
    return out,eq-1000,dd*100
V=[('as live (1 / 1 / 1)',{},None),('4h ×1.25, 15m ×0.8',{'4h':1.25,'15m':0.8},None),('4h ×1.5, 15m ×0.67',{'4h':1.5,'15m':0.67},None),
   ('4h ×2, 15m ×0.5',{'4h':2,'15m':0.5},None),('4h ×1.5, 1h ×1.25, 15m ×0.75',{'4h':1.5,'1h':1.25,'15m':0.75},None),('4h ×1.5 only',{'4h':1.5},None),('15m ×0.67 only',{'15m':0.67},None),
   ('15m at most 6 of 8 slots',{},6),('15m at most 4 of 8 slots',{},4),('15m at most 4, 4h ×1.5',{'4h':1.5},4)]
for bt,lab in ((2,'SHADOW as a $1,000 account, 35 days'),(0,'PAPER, all closed (15m and 1h only)')):
    X=[t for t in A if t['bt']==bt]; days=sorted({D.datetime.fromtimestamp(t['entry_at']/1000,D.UTC).date() for t in X}); mid=days[len(days)//2]
    h=lambda t:0 if D.datetime.fromtimestamp(t['entry_at']/1000,D.UTC).date()<mid else 1
    base=None; rows=[]
    for name,fac,c in V:
        out,net,dd=run(X,fac,c)
        half=[sum(p for t,p,w in out if h(t)==i) for i in (0,1)]; wr=[sum(t['R']*w for t,p,w in out if h(t)==i) for i in (0,1)]
        bytf={tf:(sum(1 for t,p,w in out if t['tf']==tf),sum(p for t,p,w in out if t['tf']==tf)) for tf in ('15m','1h','4h')}
        rows.append((name,net,dd,half,wr,bytf,len(out)))
        if base is None: base=rows[0]
    print(f'\n== {lab}: halves split at {mid}')
    print(f"   {'variant':32} {'trades':>6} {'net $':>7} {'Δ $':>7} {'drop':>5} {'Δ $ 1st':>8} {'Δ $ 2nd':>8} {'Δ wR 1st':>9} {'Δ wR 2nd':>9}  by tf (trades, $)")
    for name,net,dd,half,wr,bytf,n in rows:
        print(f"   {name:32} {n:6d} {net:+7.0f} {net-base[1]:+7.0f} {dd:4.0f}% {half[0]-base[3][0]:+8.0f} {half[1]-base[3][1]:+8.0f} {wr[0]-base[4][0]:+9.1f} {wr[1]-base[4][1]:+9.1f}  "+' '.join(f"{tf} {v[0]},{v[1]:+.0f}" for tf,v in bytf.items() if v[0]))
    best=max(rows[1:],key=lambda r:r[3][0]-base[3][0])
    print(f"   chosen on the first half: {best[0]} (Δ 1st {best[3][0]-base[3][0]:+.0f}) → out of sample Δ 2nd half {best[3][1]-base[3][1]:+.0f} $, Δ weighted R {best[4][1]-base[4][1]:+.1f}")
