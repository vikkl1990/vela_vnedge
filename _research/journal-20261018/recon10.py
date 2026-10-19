import json,sys,datetime as D
S=sys.argv[1]; d=json.load(open(S+'/today10.json')); T=d['closed']; O=d['open']; NOW=d['now']
P={p['symbol']:p for p in json.load(open(S+'/products.json'))['result']}
FEE=0.0005*1.18; BUF=0.25; MARGIN=100.0
def spec(sym):
    p=P.get(sym); return (int(100/float(p['initial_margin'])),float(p['maintenance_margin'])) if p else (20,2.5)
def lev(t):
    cap,m=spec(t['symbol']); stop=abs(t['entry_price']-t['sl_original'])/t['entry_price']
    return min(10,cap,1/(stop*(1+BUF)+m/100)),stop,cap,m
def sim(maxopen):
    ev=[(t['entry_at'],1,t) for t in T]+[(t['exit_at'],0,t) for t in T]+[(o['entry_at'],1,dict(o,still=True)) for o in O]
    ev.sort(key=lambda e:(e[0],e[1])); eq=1000.0; open_=set(); out={}; curve=[(min(e[0] for e in ev),1000.0)]
    for at,kind,t in ev:
        if kind==1:
            if len(open_)>=maxopen or eq-len(open_)*MARGIN<MARGIN: 
                if not t.get('still'): out[t['id']]=dict(skipped=True,open_now=len(open_))
                continue
            open_.add(t['id']); continue
        if t['id'] not in open_: continue
        open_.discard(t['id'])
        L,stop,cap,m=lev(t); n=MARGIN*L; k=n/(t['qty']*t['cv']*t['entry_price'])
        liqR=(1/L-m/100)/stop; liq=(t['worst_r'] or 0)<=-liqR
        if liq: pnl=-MARGIN-n*FEE; fees=n*FEE
        else: fees=t['fees']*k; pnl=t['realized_pnl']*k-fees
        eq+=pnl; curve.append((at,eq))
        out[t['id']]=dict(skipped=False,L=L,notional=n,stopcost=n*stop+n*FEE*2,fees=fees,pnl=pnl,bal=eq,liq=liq,cap=cap)
    return out,eq,curve
plan,eqp,cp=sim(5); nocap,eqn,cn=sim(99)
act=sum(t['realized_pnl']-t['fees'] for t in T)
taken=[t for t in T if not plan[t['id']]['skipped']]
print('plan net %+.2f taken %d skipped %d  | 10x no cap %+.2f | as traded %+.2f'%(eqp-1000,len(taken),len(T)-len(taken),eqn-1000,act))
w=[plan[t['id']]['pnl'] for t in taken]; print('wins',sum(x>0 for x in w),'worst %.2f best %.2f fees %.2f liq %d'%(min(w),max(w),sum(plan[t['id']]['fees'] for t in taken),sum(plan[t['id']]['liq'] for t in taken)))
pk=1000;dd=0
for _,v in cp: pk=max(pk,v); dd=max(dd,pk-v)
print('deepest drop %.2f'%dd, 'lev used', sorted({round(plan[t['id']]['L'],1) for t in taken}))
sk=[t for t in T if plan[t['id']]['skipped']]; 
# what skipped trades would have made at 10x
sv=sum(nocap[t['id']]['pnl'] for t in sk if not nocap[t['id']]['skipped']); print('skipped trades would have made %+.2f'%sv)
json.dump(dict(T=T,O=O,plan=plan,nocap=nocap,cp=cp,cn=cn,now=NOW,act=act),open(S+'/recon10.json','w'))
