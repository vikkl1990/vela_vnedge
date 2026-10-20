import json,sys,bisect,collections as C,datetime as D
S=sys.argv[1]; T=json.load(open(S+'/sl-feat.json'))
for t in T: t['dt']=D.datetime.fromisoformat(t['dt'])
SH=sorted([t for t in T if t['bt']==2],key=lambda t:t['entry_at']); Ex=[t['entry_at'] for t in SH]
for t in T:
    lo=bisect.bisect_left(Ex,t['entry_at']-15*60000); hi=bisect.bisect_left(Ex,t['entry_at'])
    w=[e for e in SH[lo:hi] if e['id']!=t['id']]
    t['priorSame']=sum(1 for e in w if e['symbol']==t['symbol'] and e['side']==t['side'])
    t['priorOpp']=sum(1 for e in w if e['symbol']==t['symbol'] and e['side']!=t['side'])
mid=D.datetime(2026,10,5,tzinfo=D.UTC)
F={
 'skip stops 0.8-1.2%':lambda t:0.8<=t['stop']<1.2,
 'skip script-placed stops':lambda t:t['levels_source']=='script',
 'skip 12-16 UTC':lambda t:12<=t['dt'].hour<16,
 'skip cell record < -0.1R':lambda t:t['rec'] is not None and t['rec']<-0.1,
 'skip longs':lambda t:t['side']=='long',
 'skip if opposite signal on market in prior 15m':lambda t:t['priorOpp']>0,
 'only if same-side signal in prior 15m':lambda t:t['priorSame']==0,
}
F['combo: width + script + record']=lambda t:F['skip stops 0.8-1.2%'](t) or F['skip script-placed stops'](t) or F['skip cell record < -0.1R'](t)
F['combo: width + script + record + 12-16']=lambda t:F['combo: width + script + record'](t) or F['skip 12-16 UTC'](t)
def ev(X,lab):
    print(f'\n== {lab}: {len(X)} trades, {sum(t["sl"] for t in X)} stop-outs, {sum(t["R"] for t in X):+.1f}R')
    print(f"   {'filter':48} {'skipped':>7} {'SL saved':>8} {'SL rate':>8} {'Δ R':>7} {'Δ R 1st':>8} {'Δ R 2nd':>8} {'skipped R/t':>11}")
    for k,f in F.items():
        sk=[t for t in X if f(t)]; kept=[t for t in X if not f(t)]
        if not sk: continue
        d1=-sum(t['R'] for t in sk if t['dt']<mid); d2=-sum(t['R'] for t in sk if t['dt']>=mid)
        print(f"   {k:48} {len(sk):7d} {sum(t['sl'] for t in sk):8d} {sum(t['sl'] for t in kept)/max(1,len(kept))*100:7.0f}% {-sum(t['R'] for t in sk):+7.1f} {d1:+8.1f} {d2:+8.1f} {sum(t['R'] for t in sk)/len(sk):+11.3f}")
ev([t for t in T if t['bt']==2],'SHADOW, 35 days')
ev([t for t in T if t['bt']==0],'PAPER, all closed')
# prior-only crowding table
g=C.defaultdict(list)
for t in [t for t in T if t['bt']==2]: g[min(t['priorSame'],2)].append(t)
print('\nprior same-side signals on the market in the 15 min before entry (shadow):')
for k in sorted(g):
    v=g[k]; a=[t for t in v if t['dt']<mid]; b=[t for t in v if t['dt']>=mid]
    print(f"   {k}: n={len(v)} SL {sum(t['sl'] for t in v)/len(v)*100:.0f}%  avg {sum(t['R'] for t in v)/len(v):+.3f}R  halves {sum(t['R'] for t in a)/max(1,len(a)):+.3f} ({len(a)}) / {sum(t['R'] for t in b)/max(1,len(b)):+.3f} ({len(b)})")
