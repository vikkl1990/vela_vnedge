import sys
src=open(sys.argv[1]+'/levrules.py').read().split("start=min(")[0]
exec(src)
def rec(t,n,lo_t,hi_t,lo,hi,base=10,win=30):
    xs=hist(t,lambda h:h['cell'])[-win:]
    if len(xs)<n: return base
    a=sum(xs)/len(xs); return hi if a>hi_t else lo if a<lo_t else base
V={'flat 10x':lambda t,c:10}
for n in (5,10):
    for lt,ht in ((0,0.1),(-0.05,0.05),(0,0.2)):
        for win in (20,30):
            V[f'n>={n} lo<{lt} hi>{ht} last {win}']=(lambda n,lt,ht,win:lambda t,c:rec(t,n,lt,ht,5,20,win=win))(n,lt,ht,win)
start=min(t['entry_at'] for t in A if t['bt']==0)
for bt,mo,lab in ((0,5,'ACCOUNT 5 open'),(2,5,'SHADOW 5 open'),(2,8,'SHADOW 8 open')):
    X=[t for t in A if t['bt']==bt and t['entry_at']>=start]; base=run(X,V['flat 10x'],mo)
    better=0; rows=[]
    for k,f in V.items():
        o=run(X,f,mo); rows.append((k,o)); better+= (k!='flat 10x' and o['net']>base['net'])
    print(f'\n== {lab}: flat 10x {base["net"]:+.0f} DD {base["dd"]:.0f}% | variants beating it: {better} of {len(V)-1}')
    for k,o in rows[1:]: print(f'   {k:32} {o["net"]:+6.0f} DD {o["dd"]:3.0f}%  halves {o["h1"]:+5.0f}/{o["h2"]:+5.0f}')
