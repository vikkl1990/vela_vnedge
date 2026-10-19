import json,sys,collections as C,datetime as D
S=sys.argv[1]; T=json.load(open(S+'/sizing-trades.json'))
P={p['symbol']:p for p in json.load(open(S+'/products.json'))['result']}
FEE=0.0005*1.18; BUF=float(sys.argv[2]) if len(sys.argv)>2 else 0.2
def spec(sym):
    p=P.get(sym); 
    if not p: return 20,2.5
    return int(100/float(p['initial_margin'])), float(p['maintenance_margin'])
for t in T:
    t['stop']=abs(t['entry_price']-t['sl_original'])/t['entry_price']; t['cap'],t['maint']=spec(t['symbol'])
    t['n0']=t['qty']*t['cv']*t['entry_price']
def safeL(t): return max(1.0,min(t['cap'],1/(t['stop']*(1+BUF)+t['maint']/100)))
POL={
 'fixed 5x':lambda t:min(5,t['cap']),'fixed 10x':lambda t:min(10,t['cap']),'fixed 15x':lambda t:min(15,t['cap']),'fixed 20x':lambda t:min(20,t['cap']),
 'Delta max':lambda t:t['cap'],
 'liq-safe max':safeL,
 'stop costs $10':lambda t:min(safeL(t),10/(100*t['stop'])),
 'stop costs $20':lambda t:min(safeL(t),20/(100*t['stop'])),
 'stop costs $30':lambda t:min(safeL(t),30/(100*t['stop'])),
}
def run(trades,pol,maxopen=None,margin=100.0):
    ev=[]
    for t in trades: ev.append((t['entry_at'],1,t)); ev.append((t['exit_at'],0,t))
    ev.sort(key=lambda e:(e[0],e[1]))
    eq=1000.0; pk=1000; dd=0; ddp=0; open_=set(); res={}; liq=0; taken=0; skipped=0; days=C.defaultdict(float); blown=None
    for at,kind,t in ev:
        if kind==1:
            if (maxopen and len(open_)>=maxopen) or eq-len(open_)*margin<margin or eq<=0: skipped+=1; continue
            open_.add(t['id']); taken+=1
        else:
            if t['id'] not in open_: continue
            open_.discard(t['id'])
            L=pol(t); notional=margin*L; k=notional/t['n0']
            liqmove=1/L-t['maint']/100; liqR=liqmove/t['stop']
            if t['worst_r'] is not None and t['worst_r']<=-liqR: pnl=-margin-notional*FEE; liq+=1
            else: pnl=(t['realized_pnl']-t['fees'])*k
            eq+=pnl; days[D.datetime.utcfromtimestamp(at/1000).date()]+=pnl
            pk=max(pk,eq); dd=max(dd,pk-eq); ddp=max(ddp,(pk-eq)/pk if pk>0 else 0)
            if eq<=0 and blown is None: blown=D.datetime.utcfromtimestamp(at/1000).strftime('%d %b')
    mid=sorted(days)[len(days)//2] if days else None
    h1=sum(v for d,v in days.items() if d<mid); h2=sum(v for d,v in days.items() if d>=mid)
    return dict(net=eq-1000,dd=dd,ddp=ddp*100,liq=liq,taken=taken,skipped=skipped,worstday=min(days.values()) if days else 0,h1=h1,h2=h2,blown=blown,
                pos_days=sum(v>0 for v in days.values()),ndays=len(days))
import warnings; warnings.filterwarnings('ignore')
for bt,lab in ((0,'ACCOUNT, all closed trades'),(2,'SHADOW, last 14 days')):
    X=[t for t in T if t['bt']==bt]
    for mo in (None,5,8):
        print(f'\n== {lab}  n={len(X)}  max open: {mo or "no cap"}')
        print(f"{'rule':16} {'net $':>9} {'max DD $':>9} {'DD %':>6} {'liq':>4} {'taken':>6} {'worst day':>10} {'1st half':>9} {'2nd half':>9} {'+days':>6} blown")
        for name,pol in POL.items():
            r=run(X,pol,mo)
            print(f"{name:16} {r['net']:+9.0f} {r['dd']:9.0f} {r['ddp']:6.0f} {r['liq']:4d} {r['taken']:6d} {r['worstday']:+10.0f} {r['h1']:+9.0f} {r['h2']:+9.0f} {r['pos_days']:>3}/{r['ndays']:<2} {r['blown'] or ''}")
