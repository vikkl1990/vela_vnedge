import json,sys,bisect,collections as C,datetime as D,html
S=sys.argv[1]; d=json.load(open(S+'/ledger.json')); A=d['all']
P={p['symbol']:p for p in json.load(open(S+'/products.json'))['result']}
FEE=0.0005*1.18; BUF=0.25; MG=150.0; MAXOPEN=8
for t in A:
    p=P.get(t['symbol']); t['cap'],t['maint']=(int(100/float(p['initial_margin'])),float(p['maintenance_margin'])) if p else (20,2.5)
    t['stop']=abs(t['entry_price']-t['sl_original'])/t['entry_price']; t['n0']=t['qty']*t['cv']*t['entry_price']
    t['R']=(t['realized_pnl']-t['fees'])/t['risk_amount']; t['cell']=(t['scanner_id'],t['symbol'],t['tf'])
H=sorted([t for t in A if t['bt']==2],key=lambda t:t['exit_at']); Hx=[t['exit_at'] for t in H]
bycell=C.defaultdict(list)
for h in H: bycell[h['cell']].append(h)
def choose(t):
    xs=[h['R'] for h in bycell[t['cell']] if h['exit_at']<=t['entry_at']][-30:]
    if len(xs)<5: tier,why=5,f'{len(xs)} past trades'
    else: a=sum(xs)/len(xs); tier=20 if a>0.05 else 5; why=f'last {len(xs)}: {a:+.2f}R'
    return max(1,min(tier,t['cap'],1/(t['stop']*(1+BUF)+t['maint']/100))),tier,why
def outcome(t,L):
    n=MG*L; k=n/t['n0']; liqR=(1/L-t['maint']/100)/t['stop']
    if (t['worst_r'] or 0)<=-liqR: return -MG-n*FEE,n,True
    return (t['realized_pnl']-t['fees'])*k,n,False
def book(X,filt=True):
    ev=[(t['entry_at'],1,t) for t in X]+[(t['exit_at'],0,t) for t in X]; ev.sort(key=lambda e:(e[0],e[1]))
    eq=1000.0; op={}; out={}; curve=[]
    for at,k,t in ev:
        if k==1:
            if filt and t['levels_source']!='atr-fallback': out[t['id']]=dict(st='script stop'); continue
            if len(op)>=MAXOPEN: out[t['id']]=dict(st='8 open'); continue
            if eq-len(op)*MG<MG: out[t['id']]=dict(st='no free margin'); continue
            op[t['id']]=choose(t); continue
        if t['id'] not in op: continue
        L,tier,why=op.pop(t['id']); pnl,n,liq=outcome(t,L); eq+=pnl; curve.append((at,eq))
        out[t['id']]=dict(st='taken',L=L,tier=tier,why=why,n=n,pnl=pnl,bal=eq,liq=liq)
    return out,curve,eq
paper=[t for t in A if t['bt']==0]; shadow=[t for t in A if t['bt']==2]
po,pc,pe=book(paper); so,sc,se=book(shadow)
every={t['id']:outcome(t,choose(t)[0])[0] for t in shadow if t['levels_source']=='atr-fallback'}
def dd(c,start=1000):
    pk=start; m=0
    for _,v in c: pk=max(pk,v); m=max(m,pk-v)
    return m
act=sum(t['realized_pnl']-t['fees'] for t in paper)
S_={'paper_rec':act,'paper_new':pe-1000,'paper_dd':dd(pc),'paper_taken':sum(v['st']=='taken' for v in po.values()),'paper_script':sum(v['st']=='script stop' for v in po.values()),'paper_slot':sum(v['st'] in('8 open','no free margin') for v in po.values()),
    'paper_sl_rec':sum(t['exit_reason']=='sl' for t in paper),'paper_sl_new':sum(1 for t in paper if po[t['id']]['st']=='taken' and t['exit_reason']=='sl'),
    'paper_R':sum(t['R'] for t in paper),'shadow_R':sum(t['R'] for t in shadow),'shadow_new':se-1000,'shadow_dd':dd(sc),'shadow_taken':sum(v['st']=='taken' for v in so.values()),
    'shadow_script':sum(v['st']=='script stop' for v in so.values()),'shadow_every':sum(every.values()),'shadow_R_filtered':sum(t['R'] for t in shadow if t['levels_source']=='atr-fallback'),
    'shadow_sl_rec':sum(t['exit_reason']=='sl' for t in shadow),'shadow_sl_new':sum(1 for t in shadow if so[t['id']]['st']=='taken' and t['exit_reason']=='sl')}
for k,v in S_.items(): print(k, round(v,2) if isinstance(v,float) else v)
json.dump(dict(paper=paper,shadow=shadow,po=po,so=so,pc=pc,sc=sc,every=every,S=S_,now=d['now']),open(S+'/ledger-out.json','w'),default=list)
