import json,sys,collections as C,datetime as D,bisect
S=sys.argv[1]; A=json.load(open(S+'/lev-trades.json'))
P={p['symbol']:p for p in json.load(open(S+'/products.json'))['result']}
FEE=0.0005*1.18; BUF=0.25; M=100.0
for t in A:
    p=P.get(t['symbol']); t['cap'],t['maint']=(int(100/float(p['initial_margin'])),float(p['maintenance_margin'])) if p else (20,2.5)
    t['stop']=abs(t['entry_price']-t['sl_original'])/t['entry_price']; t['n0']=t['qty']*t['cv']*t['entry_price']
    t['R']=(t['realized_pnl']-t['fees'])/t['risk_amount'] if t['risk_amount'] else 0
    t['cell']=(t['scanner_id'],t['symbol'],t['tf']); t['day']=D.datetime.fromtimestamp(t['entry_at']/1000,D.UTC).date()
H=sorted([t for t in A if t['bt']==2],key=lambda t:t['exit_at']); Hx=[t['exit_at'] for t in H]
def hist(t,key):
    i=bisect.bisect_left(Hx,t['entry_at']); xs=[h['R'] for h in H[:i] if key(h)==key(t)]
    return xs[-30:]
def safe(t): return 1/(t['stop']*(1+BUF)+t['maint']/100)
MAJ={'BTCUSD','ETHUSD','SOLUSD','XRPUSD'}
def cellrec(t,base=10,lo=5,hi=15,n=5,key=lambda h:h['cell']):
    xs=hist(t,key)
    if len(xs)<n: return base
    a=sum(xs)/len(xs); return hi if a>0.1 else lo if a<0 else base
def scanrec(t): return cellrec(t,key=lambda h:h['scanner_id'],n=10)
RULES={
 'flat 10x':lambda t,c:10,
 'flat 7x':lambda t,c:7,
 'by stop width (5/10/15)':lambda t,c:5 if t['stop']<0.01 else 10 if t['stop']<0.02 else 15,
 'by timeframe (15m 8, 1h 10, 4h 15)':lambda t,c:{'15m':8,'1h':10,'4h':15}.get(t['tf'],10),
 'by market (majors 15, alts 8)':lambda t,c:15 if t['symbol'] in MAJ else 8,
 'by cell record (5/10/15)':lambda t,c:cellrec(t),
 'by cell record (5/10/20)':lambda t,c:cellrec(t,hi=20),
 'by scanner record (5/10/15)':lambda t,c:scanrec(t),
 'drawdown throttle (10, 5 when >5% down)':lambda t,c:5 if c['eq']<c['pk']*0.95 else 10,
 'win-streak (15 at a high, 5 when >5% down)':lambda t,c:15 if c['eq']>=c['pk'] else 5 if c['eq']<c['pk']*0.95 else 10,
 'cell record + stop width':lambda t,c:min(cellrec(t), 5 if t['stop']<0.01 else 20),
}
def run(trades,rule,maxopen=5):
    ev=[(t['entry_at'],1,t) for t in trades]+[(t['exit_at'],0,t) for t in trades]; ev.sort(key=lambda e:(e[0],e[1]))
    eq=1000.0; pk=1000.0; dd=0; op={}; days=C.defaultdict(float); liq=0; levs=[]
    for at,k,t in ev:
        if k==1:
            if len(op)>=maxopen or eq-len(op)*M<M: continue
            L=max(1,min(rule(t,dict(eq=eq,pk=pk)),t['cap'],safe(t))); op[t['id']]=L; levs.append(L); continue
        if t['id'] not in op: continue
        L=op.pop(t['id']); n=M*L; kq=n/t['n0']; liqR=(1/L-t['maint']/100)/t['stop']
        if (t['worst_r'] or 0)<=-liqR: pnl=-M-n*FEE; liq+=1
        else: pnl=(t['realized_pnl']-t['fees'])*kq
        eq+=pnl; days[t['day']]+=pnl; pk=max(pk,eq); dd=max(dd,(pk-eq)/pk)
    ds=sorted(days); mid=ds[len(ds)//2]
    return dict(net=eq-1000,dd=dd*100,liq=liq,h1=sum(v for d,v in days.items() if d<mid),h2=sum(v for d,v in days.items() if d>=mid),avgL=sum(levs)/max(1,len(levs)),n=len(levs))
start=min(t['entry_at'] for t in A if t['bt']==0)
for bt,mo,lab in ((0,5,'ACCOUNT, 5 open max'),(2,5,'SHADOW same 14 days, 5 open max'),(2,8,'SHADOW same 14 days, 8 open max')):
    X=[t for t in A if t['bt']==bt and t['entry_at']>=start]
    print(f'\n== {lab}  n={len(X)}')
    print(f"{'rule':44} {'net $':>7} {'DD%':>4} {'net/DD':>6} {'liq':>3} {'avg lev':>7} {'1st half':>8} {'2nd half':>8}")
    for name,r in RULES.items():
        o=run(X,r,mo); print(f"{name:44} {o['net']:+7.0f} {o['dd']:4.0f} {o['net']/max(1,o['dd']*10):6.2f} {o['liq']:3d} {o['avgL']:7.1f} {o['h1']:+8.0f} {o['h2']:+8.0f}")
