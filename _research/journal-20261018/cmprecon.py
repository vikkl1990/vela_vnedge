import json,sys,bisect,collections as C,datetime as D
S=sys.argv[1]; d=json.load(open(S+'/cmp.json')); A=d['all']; O=d['open']; NOW=d['now']
P={p['symbol']:p for p in json.load(open(S+'/products.json'))['result']}
FEE=0.0005*1.18; BUF=0.25; MG=150.0; MAXOPEN=8; LO,MID,HI=2.5,5,50
DAY0=D.datetime(2026,10,18,18,30,tzinfo=D.UTC).timestamp()*1000
for t in A:
    p=P.get(t['symbol']); t['cap'],t['maint']=(int(100/float(p['initial_margin'])),float(p['maintenance_margin'])) if p else (20,2.5)
    t['stop']=abs(t['entry_price']-t['sl_original'])/t['entry_price']; t['n0']=t['qty']*t['cv']*t['entry_price']
    t['R']=(t['realized_pnl']-t['fees'])/t['risk_amount'] if t['risk_amount'] else 0
    t['cell']=(t['scanner_id'],t['symbol'],t['tf'])
H=sorted([t for t in A if t['bt']==2],key=lambda t:t['exit_at']); Hx=[t['exit_at'] for t in H]
def choose(t):
    i=bisect.bisect_left(Hx,t['entry_at']); xs=[h['R'] for h in H[:i] if h['cell']==t['cell']][-30:]
    if len(xs)<5: tier,why=MID,f'{len(xs)} past trades'
    else: a=sum(xs)/len(xs); tier=HI if a>0.05 else LO if a<-0.05 else MID; why=f'last {len(xs)}: {a:+.2f}R'
    safe=1/(t['stop']*(1+BUF)+t['maint']/100); L=max(1,min(tier,t['cap'],safe))
    lim='record' if tier<=min(t['cap'],safe) else (f"Delta max {t['cap']}×" if t['cap']<=safe else 'stop guard')
    return L,tier,why,lim
def outcome(t,L):
    n=MG*L; k=n/t['n0']; liqR=(1/L-t['maint']/100)/t['stop']
    if (t['worst_r'] or 0)<=-liqR: return dict(pnl=-MG-n*FEE,fees=n*FEE,liq=True,notional=n)
    return dict(pnl=(t['realized_pnl']-t['fees'])*k,fees=t['fees']*k,liq=False,notional=n)
def account(trades,opens):
    ev=[(t['entry_at'],1,t) for t in trades]+[(t['exit_at'],0,t) for t in trades]+[(o['entry_at'],1,dict(o,still=True,id='o%s'%o['id'])) for o in opens]
    ev.sort(key=lambda e:(e[0],e[1])); eq=1000.0; op={}; out={}; curve=[(DAY0,1000.0)]
    for at,k,t in ev:
        if k==1:
            if len(op)>=MAXOPEN or eq-len(op)*MG<MG:
                if not t.get('still'): out[t['id']]=dict(skipped=True)
                continue
            op[t['id']]=choose(t) if not t.get('still') else (MID,MID,'',''); continue
        if t['id'] not in op: continue
        L,tier,why,lim=op.pop(t['id']); o=outcome(t,L); eq+=o['pnl']; curve.append((max(at,DAY0),eq))
        out[t['id']]=dict(o,skipped=False,L=L,tier=tier,why=why,lim=lim,bal=eq,stopcost=o['notional']*t['stop']+2*o['notional']*FEE)
    return out,curve
paper=[t for t in A if t['bt']==0 and t['exit_at']>=DAY0]; shadow=[t for t in A if t['bt']==2 and t['exit_at']>=DAY0]
po,pc=account(paper,[o for o in O if o['bt']==0]); so,sc=account(shadow,[o for o in O if o['bt']==2])
every={t['id']:dict(outcome(t,choose(t)[0]),L=choose(t)[0]) for t in shadow}
# match paper to its shadow signal
match={}
for t in paper:
    c=[s for s in shadow if s['cell']==t['cell'] and s['side']==t['side'] and abs(s['entry_at']-t['entry_at'])<10*60000]
    if c: match[t['id']]=min(c,key=lambda s:abs(s['entry_at']-t['entry_at']))['id']
matched=set(match.values())
asp=sum(t['realized_pnl']-t['fees'] for t in paper)
summ=dict(paper_new=pc[-1][1]-1000,paper_act=asp,paper_R=sum(t['R'] for t in paper),shadow_acct=sc[-1][1]-1000,shadow_every=sum(v['pnl'] for v in every.values()),
  shadow_R=sum(t['R'] for t in shadow),n_paper=len(paper),n_shadow=len(shadow),matched=len(match),
  paper_taken=sum(not v['skipped'] for v in po.values()),shadow_taken=sum(not v['skipped'] for v in so.values()),
  shadow_unmatched_every=sum(v['pnl'] for k,v in every.items() if k not in matched),n_unmatched=len(shadow)-len(matched),
  shadow_matched_every=sum(v['pnl'] for k,v in every.items() if k in matched))
for k,v in summ.items(): print(k, round(v,2) if isinstance(v,float) else v)
def dd(c):
    pk=1000;m=0
    for _,v in c: pk=max(pk,v); m=max(m,pk-v)
    return m
print('dd paper',round(dd(pc),2),'dd shadow',round(dd(sc),2))
json.dump(dict(paper=paper,shadow=shadow,po=po,so=so,every=every,match=match,pc=pc,sc=sc,summ=summ,now=NOW,openp=[o for o in O if o['bt']==0],opens=[o for o in O if o['bt']==2],ddp=dd(pc),dds=dd(sc)),open(S+'/cmp-out.json','w'),default=list)
