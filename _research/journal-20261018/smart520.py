import sys,math,json
S=sys.argv[1]; src=open(S+'/grid.py').read(); exec(src[:src.index("start=min(t['entry_at'] for t in A if t['bt']==0)\nbooks")])
def recxs(t): return hist(t,lambda h:h['cell'])[-30:]
def tiers(lo,mid,hi):
    def f(t):
        xs=recxs(t)
        if len(xs)<5: return mid
        a=sum(xs)/len(xs); return hi if a>0.05 else lo if a<-0.05 else mid
    return f
def slide(none=10):
    def f(t):
        xs=recxs(t)
        if len(xs)<5: return none
        a=sum(xs)/len(xs); return max(5,min(20,5+(a+0.1)/0.3*15))
    return f
def conf(none=10):
    def f(t):
        xs=recxs(t)
        if len(xs)<5: return none
        m=sum(xs)/len(xs); sd=(sum((x-m)**2 for x in xs)/(len(xs)-1))**.5 or 1; z=m/(sd/math.sqrt(len(xs)))
        return max(5,min(20,10+5*z))
    return f
V=[('$100 flat 10x',100,lambda t:10),('$150 2.5/5/50 (current best)',150,tiers(2.5,5,50)),
   ('$100 tiers 5/10/20',100,tiers(5,10,20)),('$150 tiers 5/10/20',150,tiers(5,10,20)),
   ('$100 tiers 5/5/20',100,tiers(5,5,20)),('$150 tiers 5/5/20',150,tiers(5,5,20)),
   ('$100 tiers 5/7/20',100,tiers(5,7,20)),('$150 tiers 5/7/20',150,tiers(5,7,20)),
   ('$100 sliding 5-20, new 10',100,slide(10)),('$100 sliding 5-20, new 5',100,slide(5)),('$150 sliding 5-20, new 5',150,slide(5)),
   ('$100 confidence 5-20, new 10',100,conf(10)),('$100 confidence 5-20, new 5',100,conf(5)),('$150 confidence 5-20, new 5',150,conf(5))]
start=min(t['entry_at'] for t in A if t['bt']==0)
books={'acct':[t for t in A if t['bt']==0 and t['entry_at']>=start],'shad':[t for t in A if t['bt']==2 and t['entry_at']>=start]}
d=json.load(open(S+'/cmp.json')); import datetime as D; day0=D.datetime(2026,10,18,18,30,tzinfo=D.UTC).timestamp()*1000
today=[t for t in A if t['bt']==0 and t['exit_at']>=day0]
print(f"{'rule':32} {'open':>4} | {'account':>8} {'DD':>4} {'halves':>11} {'worst day':>9} | {'shadow':>8} {'DD':>4} {'halves':>13} | {'today':>6}")
for mo in (8,5):
    for name,Mg,f in V:
        a=runm(books['acct'],lambda t,f=f:f(t),mo,Mg); s=runm(books['shad'],lambda t,f=f:f(t),mo,Mg); td=runm(today,lambda t,f=f:f(t),mo,Mg)
        ok='both' if a[2]>0 and a[3]>0 and s[2]>0 and s[3]>0 else ''
        print(f"{name:32} {mo:4d} | {a[0]:+8.0f} {a[1]:3.0f}% {a[2]:+5.0f}/{a[3]:+5.0f} {a[5]:+9.0f} | {s[0]:+8.0f} {s[1]:3.0f}% {s[2]:+6.0f}/{s[3]:+6.0f} | {td[0]:+6.0f} {ok}")
    print()
