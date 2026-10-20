import json,sys,bisect,collections as C,datetime as D,statistics as st
S=sys.argv[1]; T=json.load(open(S+'/sl-all.json'))
for t in T:
    t['R']=(t['realized_pnl']-t['fees'])/t['risk_amount']; t['sl']=t['exit_reason']=='sl'
    t['stop']=abs(t['entry_price']-t['sl_original'])/t['entry_price']*100; t['cell']=(t['scanner_id'],t['symbol'],t['tf'])
    t['dt']=D.datetime.fromtimestamp(t['entry_at']/1000,D.UTC)
SH=[t for t in T if t['bt']==2]; Hs=sorted(SH,key=lambda t:t['exit_at']); Hx=[t['exit_at'] for t in Hs]
bycell=C.defaultdict(list)
for t in Hs: bycell[t['cell']].append(t)
ent=sorted(SH,key=lambda t:t['entry_at']); Ex=[t['entry_at'] for t in ent]
for t in T:
    past=[h for h in bycell[t['cell']] if h['exit_at']<=t['entry_at']][-30:]
    t['recN']=len(past); t['rec']=sum(h['R'] for h in past)/len(past) if len(past)>=5 else None
    t['prevSL']=past[-1]['sl'] if past else None
    lo=bisect.bisect_left(Ex,t['entry_at']-15*60000); hi=bisect.bisect_right(Ex,t['entry_at']+15*60000)
    w=[e for e in ent[lo:hi] if e['id']!=t['id']]
    t['sameSym']=sum(1 for e in w if e['symbol']==t['symbol']); t['sameSymSide']=sum(1 for e in w if e['symbol']==t['symbol'] and e['side']==t['side'])
    t['fleet']=len(w)
mid=D.datetime(2026,10,5,tzinfo=D.UTC)  # halves
def show(name,keyf,X):
    g=C.defaultdict(list)
    for t in X:
        k=keyf(t)
        if k is not None: g[k].append(t)
    print(f'\n-- {name}')
    print(f"   {'bucket':22} {'n':>5} {'SL%':>5} {'avg R':>7} {'sum R':>8} {'1st half R/t':>12} {'2nd half R/t':>12}")
    for k in sorted(g,key=str):
        v=g[k]; a=[t for t in v if t['dt']<mid]; b=[t for t in v if t['dt']>=mid]
        f=lambda L:f"{sum(t['R'] for t in L)/len(L):+.3f} ({len(L)})" if L else '–'
        print(f"   {str(k):22} {len(v):5d} {sum(t['sl'] for t in v)/len(v)*100:4.0f}% {sum(t['R'] for t in v)/len(v):+7.3f} {sum(t['R'] for t in v):+8.1f} {f(a):>12} {f(b):>12}")
X=SH
print('SHADOW',len(X),'trades', D.datetime.fromtimestamp(min(t['entry_at'] for t in X)/1000,D.UTC).date(),'to',D.datetime.fromtimestamp(max(t['exit_at'] for t in X)/1000,D.UTC).date(),' SL rate %.0f%%  avg %+.3fR'%(sum(t['sl'] for t in X)/len(X)*100,sum(t['R'] for t in X)/len(X)))
show('timeframe',lambda t:t['tf'],X)
show('side',lambda t:t['side'],X)
show('stop width %',lambda t:'<0.8' if t['stop']<0.8 else '0.8-1.2' if t['stop']<1.2 else '1.2-1.6' if t['stop']<1.6 else '1.6-2.5' if t['stop']<2.5 else '2.5-4' if t['stop']<4 else '>=4',X)
show('levels source',lambda t:t['levels_source'],X)
show('hour UTC',lambda t:f"{t['dt'].hour//4*4:02d}-{t['dt'].hour//4*4+4:02d}",X)
show('weekday',lambda t:t['dt'].strftime('%a'),X)
show('cell record before entry',lambda t:'<5 trades' if t['rec'] is None else '< -0.1R' if t['rec']<-0.1 else '-0.1..0' if t['rec']<0 else '0..+0.1' if t['rec']<0.1 else '>= +0.1',X)
show('previous trade of the cell',lambda t:'none' if t['prevSL'] is None else 'stop' if t['prevSL'] else 'not stop',X)
show('other entries same market within 15 min',lambda t:min(t['sameSym'],4),X)
show('same market same side within 15 min',lambda t:min(t['sameSymSide'],4),X)
show('fleet entries within 15 min',lambda t:'0-4' if t['fleet']<5 else '5-14' if t['fleet']<15 else '15-29' if t['fleet']<30 else '30+',X)
json.dump(T,open(S+'/sl-feat.json','w'),default=str)
