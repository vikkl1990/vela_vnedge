import json,sys,datetime as D
S=sys.argv[1]
T=json.load(open(S+'/acct-today.json'))
P={p['symbol']:p for p in json.load(open(S+'/products.json'))['result']}
FEE=0.0005*1.18
def sim(t,L,margin=100.0):
    p=P.get(t['symbol']); maint=float(p['maintenance_margin'])/100; init=float(p['initial_margin'])
    cap=int(100/init); notional=margin*L
    k=notional/(t['qty']*t['cv']*t['entry_price'])
    stop=abs(t['entry_price']-t['sl_original'])/t['entry_price']
    liqmove=1/L-maint; liqR=liqmove/stop
    liq = t['worst_r'] is not None and t['worst_r']<=-liqR
    if liq: net=-margin-notional*FEE; gross=-margin; fees=notional*FEE
    else: gross=t['realized_pnl']*k; fees=t['fees']*k; net=gross-fees
    move=(t['exit_price']-t['entry_price'])/t['entry_price']*(1 if t['side']=='long' else -1)
    return dict(notional=notional,cap=cap,maint=maint*100,stop=stop*100,liq=liqmove*100,liqd=liq,gross=gross,fees=fees,net=net,move=move*100,lev=L)
rows=[]
for t in T:
    a=sim(t,30); c=sim(t,min(30,a['cap']))
    rows.append(dict(t=t,a=a,c=c,actual=t['realized_pnl']-t['fees']))
# concurrency
ev=sorted([(t['entry_at'],1) for t in T]+[(t['exit_at'],-1) for t in T]); cur=mx=0
for _,d in ev: cur+=d; mx=max(mx,cur)
print('trades',len(rows),'max open at once',mx,'-> margin needed $',mx*100)
for key,lab in (('a','30x everywhere'),('c','30x where allowed, else Delta cap')):
    n=sum(r[key]['net'] for r in rows); liq=sum(r[key]['liqd'] for r in rows)
    w=[r[key]['net'] for r in rows if r[key]['net']>0]; l=[r[key]['net'] for r in rows if r[key]['net']<=0]
    print(f"{lab:36s} net ${n:+8.2f}  liquidated {liq}  wins {len(w)} avg ${sum(w)/max(1,len(w)):.2f}  losses {len(l)} avg ${sum(l)/max(1,len(l)):.2f}  fees ${sum(r[key]['fees'] for r in rows):.2f}")
print('actual 1pct risk sizing net $%+.2f' % sum(r['actual'] for r in rows))
print('markets allowing 30x:',sorted({r['t']['symbol'] for r in rows if r['a']['cap']>=30}))
print('caps seen:',sorted({(r['t']['symbol'],r['a']['cap'],r['a']['maint']) for r in rows},key=lambda x:x[1])[:5])
import statistics as st
print('stop % median',st.median(r['a']['stop'] for r in rows),' liq move at 30x alts %.2f%%'%(100/30-2.5))
json.dump([dict(id=r['t']['id'],when=r['t']['entry_at'],exit=r['t']['exit_at'],scanner=r['t']['scanner_name'],sym=r['t']['symbol'],tf=r['t']['tf'],side=r['t']['side'],entry=r['t']['entry_price'],exitp=r['t']['exit_price'],reason=r['t']['exit_reason'],stop=r['a']['stop'],move=r['a']['move'],peak=r['t']['peak_r'],worst=r['t']['worst_r'],cap=r['a']['cap'],maint=r['a']['maint'],a=r['a'],c=r['c'],actual=r['actual']) for r in rows],open(S+'/recon30.json','w'))
