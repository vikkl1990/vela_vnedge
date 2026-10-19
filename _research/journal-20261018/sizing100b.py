import json,sys,collections as C
exec(open(sys.argv[1]+'/sizing100.py').read().split('import warnings')[0].replace("S=sys.argv[1]","S=sys.argv[1]"))
import warnings; warnings.filterwarnings('ignore')
def safe10(t): return min(10,safeL(t))
def safe8(t): return min(8,safeL(t))
def safe12(t): return min(12,safeL(t))
def run_list(trades,pol,maxopen,drop=set()):
    return run([t for t in trades if t['id'] not in drop],pol,maxopen)
for bt,mo,lab in ((0,5,'ACCOUNT max 5 open'),(2,8,'SHADOW max 8 open'),(2,5,'SHADOW max 5 open')):
    X=[t for t in T if t['bt']==bt]
    print(f'\n== {lab}')
    for name,pol in (('fixed 8x, liq beyond stop',safe8),('fixed 10x',lambda t:min(10,t['cap'])),('fixed 10x, liq beyond stop',safe10),('fixed 12x, liq beyond stop',safe12)):
        r=run(X,pol,mo)
        # per-trade $ at this rule, no equity constraint, for concentration
        pn=[]
        for t in X:
            L=pol(t); n=100*L; k=n/t['n0']; liqR=(1/L-t['maint']/100)/t['stop']
            pn.append(-100-n*FEE if t['worst_r'] is not None and t['worst_r']<=-liqR else (t['realized_pnl']-t['fees'])*k)
        pn.sort(reverse=True); tot=sum(pn)
        print(f"  {name:28} net {r['net']:+6.0f}  DD {r['ddp']:3.0f}%  liq {r['liq']}  worst day {r['worstday']:+5.0f}  halves {r['h1']:+5.0f}/{r['h2']:+5.0f} | all trades {tot:+6.0f}, without top 5 {tot-sum(pn[:5]):+6.0f}, without top 10 {tot-sum(pn[:10]):+6.0f}")
    # by stop width at fixed 10x liq-safe, no constraint
    b=C.defaultdict(list)
    for t in X:
        L=safe10(t); n=100*L; k=n/t['n0']; liqR=(1/L-t['maint']/100)/t['stop']
        v=-100-n*FEE if (t['worst_r'] or 0)<=-liqR else (t['realized_pnl']-t['fees'])*k
        s=t['stop']*100; key='<1%' if s<1 else '1-1.5%' if s<1.5 else '1.5-2%' if s<2 else '2-3%' if s<3 else '>=3%'
        b[key].append((v,(t['realized_pnl']-t['fees'])/t['risk_amount']))
    for k in ('<1%','1-1.5%','1.5-2%','2-3%','>=3%'):
        v=b.get(k,[]); 
        if v: print(f'    stop {k:7} n={len(v):4d}  $ at 10x {sum(x[0] for x in v):+7.0f}  avg $ {sum(x[0] for x in v)/len(v):+6.2f}  avg R {sum(x[1] for x in v)/len(v):+.3f}')
