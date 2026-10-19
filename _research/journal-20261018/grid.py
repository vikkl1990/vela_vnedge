import sys,collections as C
exec(open(sys.argv[1]+'/levrules.py').read().split("start=min(")[0])
def runm(trades,rule,maxopen,Mg):
    ev=[(t['entry_at'],1,t) for t in trades]+[(t['exit_at'],0,t) for t in trades]; ev.sort(key=lambda e:(e[0],e[1]))
    eq=1000.0; pk=1000.0; dd=0; op={}; days=C.defaultdict(float); liq=0; ruin=False
    for at,k,t in ev:
        if k==1:
            if len(op)>=maxopen or eq-len(op)*Mg<Mg: continue
            op[t['id']]=max(1,min(rule(t),t['cap'],safe(t))); continue
        if t['id'] not in op: continue
        L=op.pop(t['id']); n=Mg*L; kq=n/t['n0']; liqR=(1/L-t['maint']/100)/t['stop']
        pnl=(-Mg-n*FEE) if (t['worst_r'] or 0)<=-liqR else (t['realized_pnl']-t['fees'])*kq
        liq+= (t['worst_r'] or 0)<=-liqR
        eq+=pnl; days[t['day']]+=pnl; pk=max(pk,eq); dd=max(dd,(pk-eq)/pk)
        if eq<Mg: ruin=True
    ds=sorted(days); mid=ds[len(ds)//2]
    return eq-1000,dd*100,sum(v for d,v in days.items() if d<mid),sum(v for d,v in days.items() if d>=mid),ruin,min(days.values())
def rec(t,lo,mid,hi):
    xs=hist(t,lambda h:h['cell'])[-30:]
    if len(xs)<5: return mid
    a=sum(xs)/len(xs); return hi if a>0.05 else lo if a<-0.05 else mid
start=min(t['entry_at'] for t in A if t['bt']==0)
books={'acct':[t for t in A if t['bt']==0 and t['entry_at']>=start],'shad':[t for t in A if t['bt']==2 and t['entry_at']>=start]}
res=[]
for Mg in (50,100,150,200,300):
  for mid in (3,5,7,10,15,20):
    for kind in ('flat','record'):
      rule=(lambda t,mid=mid:mid) if kind=='flat' else (lambda t,mid=mid:rec(t,max(1,mid/2),mid,50))
      for mo in (3,5,8):
        r={b:runm(X,rule,mo,Mg) for b,X in books.items()}
        res.append((Mg,mid,kind,mo,r))
print(f"{'margin':>6} {'lev':>4} {'rule':7} {'open':>4} | {'account $':>9} {'DD%':>4} {'halves':>11} {'worst day':>9} | {'shadow $':>9} {'DD%':>4} {'halves':>13} {'worst day':>9}")
def line(x):
    Mg,mid,kind,mo,r=x; a=r['acct']; s=r['shad']
    return f"{Mg:6d} {mid:4d} {kind:7} {mo:4d} | {a[0]:+9.0f} {a[1]:4.0f} {a[2]:+5.0f}/{a[3]:+5.0f} {a[5]:+9.0f}{' RUIN' if a[4] else '     '}| {s[0]:+9.0f} {s[1]:4.0f} {s[2]:+6.0f}/{s[3]:+6.0f} {s[5]:+9.0f}{' RUIN' if s[4] else ''}"
print('\n-- top 12 by account profit'); 
for x in sorted(res,key=lambda x:-x[4]['acct'][0])[:12]: print(line(x))
print('\n-- top 12 by shadow profit')
for x in sorted(res,key=lambda x:-x[4]['shad'][0])[:12]: print(line(x))
print('\n-- top 12 by the lower of the two books scaled (account $ and shadow $/10), both halves positive in both, worst drop <= 30% in both')
ok=[x for x in res if all(x[4][b][2]>0 and x[4][b][3]>0 and x[4][b][1]<=30 and not x[4][b][4] for b in ('acct','shad'))]
for x in sorted(ok,key=lambda x:-min(x[4]['acct'][0],x[4]['shad'][0]/10))[:12]: print(line(x))
import json; json.dump([(x[0],x[1],x[2],x[3],x[4]) for x in res],open(sys.argv[1]+'/grid.json','w'))
