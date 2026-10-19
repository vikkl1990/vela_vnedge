import sys
exec(open(sys.argv[1]+'/levrules.py').read().split("start=min(")[0])
def rec(t,lo,mid,hi):
    xs=hist(t,lambda h:h['cell'])[-30:]
    if len(xs)<5: return mid
    a=sum(xs)/len(xs); return hi if a>0.05 else lo if a<-0.05 else mid
V={'flat 10x':lambda t,c:10,
   'record 5 / 10 / 20x (decision 143)':lambda t,c:rec(t,5,10,20),
   'record 5 / 10 / up to 50x':lambda t,c:rec(t,5,10,50),
   'record 5 / 20 / up to 50x':lambda t,c:rec(t,5,20,50),
   'record 10 / up to 50 / up to 50x':lambda t,c:rec(t,10,50,50),
   'every trade up to 50x':lambda t,c:50}
start=min(t['entry_at'] for t in A if t['bt']==0)
for bt,mo,lab in ((0,5,'ACCOUNT 5 open'),(2,5,'SHADOW 5 open'),(2,8,'SHADOW 8 open')):
    X=[t for t in A if t['bt']==bt and t['entry_at']>=start]
    print(f'\n== {lab}')
    for k,f in V.items():
        o=run(X,f,mo); print(f'   {k:36} {o["net"]:+7.0f}  DD {o["dd"]:3.0f}%  liq {o["liq"]}  avg lev {o["avgL"]:4.1f}  halves {o["h1"]:+6.0f}/{o["h2"]:+6.0f}')
