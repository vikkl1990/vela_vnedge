import sys,json
exec(open(sys.argv[1]+'/levrules.py').read().split("start=min(")[0])
d=json.load(open(S+'/today10.json')); names={t['id']:t['scanner_name'] for t in d['closed']}; ids=set(names)
T=[t for t in A if t['id'] in ids]; O=d['open']
assert len(T)==len(ids),(len(T),len(ids))
def choose(t):
    xs=hist(t,lambda h:h['cell'])[-30:]
    if len(xs)<5: tier,why=10,f'{len(xs)} past trades, too few'
    else:
        a=sum(xs)/len(xs); tier=20 if a>0.05 else 5 if a<-0.05 else 10; why=f'last {len(xs)}: {a:+.2f}R'
    L=max(1,min(tier,t['cap'],safe(t))); return L,tier,why
def sim(fn,maxopen=5):
    ev=[(t['entry_at'],1,t) for t in T]+[(t['exit_at'],0,t) for t in T]+[(o['entry_at'],1,dict(o,still=True,id='o%s'%o['id'])) for o in O]
    ev.sort(key=lambda e:(e[0],e[1])); eq=1000.0; op={}; out={}; curve=[(ev[0][0],1000.0)]
    for at,k,t in ev:
        if k==1:
            if len(op)>=maxopen or eq-len(op)*M<M:
                if not t.get('still'): out[t['id']]=dict(skipped=True)
                continue
            op[t['id']]=fn(t) if not t.get('still') else (10,10,'')
            continue
        if t['id'] not in op: continue
        L,tier,why=op.pop(t['id']); n=M*L; kq=n/t['n0']; liqR=(1/L-t['maint']/100)/t['stop']
        if (t['worst_r'] or 0)<=-liqR: fees=n*FEE; pnl=-M-fees; liq=True
        else: fees=t['fees']*kq; pnl=t['realized_pnl']*kq-fees; liq=False
        eq+=pnl; curve.append((at,eq))
        out[t['id']]=dict(skipped=False,L=L,tier=tier,why=why,notional=n,stopcost=n*t['stop']+2*n*FEE,fees=fees,pnl=pnl,bal=eq,liq=liq)
    return out,curve
plan,cp=sim(choose); flat,cf=sim(lambda t:(max(1,min(10,t['cap'],safe(t))),10,''))
act=sum(t['realized_pnl']-t['fees'] for t in T)
tk=[t for t in T if not plan[t['id']]['skipped']]
print('variable %+.2f | flat 10x %+.2f | as traded %+.2f | taken %d of %d'%(cp[-1][1]-1000,cf[-1][1]-1000,act,len(tk),len(T)))
import collections as C; print('tiers',C.Counter(plan[t['id']]['tier'] for t in tk), 'lev used', sorted({round(plan[t['id']]['L'],1) for t in tk}))
pk=1000;dd=0
for _,v in cp: pk=max(pk,v); dd=max(dd,pk-v)
print('deepest drop %.2f worst %.2f best %.2f'%(dd,min(plan[t['id']]['pnl'] for t in tk),max(plan[t['id']]['pnl'] for t in tk)))
for t in T: t['scanner_name']=names[t['id']]
json.dump(dict(T=T,O=O,plan=plan,cp=cp,cf=cf,act=act,now=d['now']),open(S+'/reconvar.json','w'),default=str)
