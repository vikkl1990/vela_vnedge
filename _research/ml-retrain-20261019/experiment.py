import json, sys, numpy as np, pandas as pd, bisect, collections
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score
D=sys.argv[1]
FEATS=['side_long','score','has_score','hour','dow','atr_pct','sl_atr','tp1_rr','ret5','ret20','trend50','trend200','vol_ratio','range_pos','lvl_script','src_alert','src_shape','src_derived','src_cond','burst3','bar_range_atr','er20','chop14','adx14','day_range_used']
tr=pd.DataFrame(json.load(open(f'{D}/mlx-trades.json'))); sm=pd.DataFrame(json.load(open(f'{D}/mlx-samples.json'))); hist=pd.DataFrame(json.load(open(f'{D}/mlx-history.json')))
X=lambda df: np.array([[ (row.get(k) if isinstance(row,dict) and np.isfinite(row.get(k,np.nan) if isinstance(row.get(k,None),(int,float)) else np.nan) else 0.0) for k in FEATS] for row in df['f']],dtype=float)
tr['win']=(tr['r']>0).astype(int); sm['win']=sm['win'].astype(int)
# ---- cell history features, strictly from trades closed before this entry ----
hist=hist.sort_values('exit_at').reset_index(drop=True)
def build_hist(keyf):
    d=collections.defaultdict(lambda:([],[]))
    for _,h in hist.iterrows(): k=keyf(h); d[k][0].append(h['exit_at']); d[k][1].append(h['r'])
    return d
H={'cell':build_hist(lambda h:(h['scanner'],h['symbol'],h['tf'])),'scantf':build_hist(lambda h:(h['scanner'],h['tf'])),'mkt':build_hist(lambda h:h['symbol'])}
def hfeat(t):
    out=[]
    for name,keyf in (('cell',lambda t:(t['scanner'],t['symbol'],t['tf'])),('scantf',lambda t:(t['scanner'],t['tf'])),('mkt',lambda t:t['symbol'])):
        ts,rs=H[name][keyf(t)]; i=bisect.bisect_left(ts,t['at']); past=rs[:i]
        last=past[-10:]; out+= [len(past), np.mean(last) if last else 0.0, np.mean(past) if past else 0.0, (np.mean([x>0 for x in last]) if last else 0.5)]
    return out
HF=['cell_n','cell_r10','cell_rall','cell_win10','stf_n','stf_r10','stf_rall','stf_win10','mkt_n','mkt_r10','mkt_rall','mkt_win10']
sh=tr[tr.src=='shadow'].sort_values('at').reset_index(drop=True)
def evaluate(split_frac, label):
    cut=int(len(sh)*split_frac); trn=sh.iloc[:cut]; tst=sh.iloc[cut:]; t0=tst['at'].min()
    Xtr,Xts=X(trn),X(tst); Htr=np.array([hfeat(r) for _,r in trn.iterrows()]); Hts=np.array([hfeat(r) for _,r in tst.iterrows()])
    smp=sm[sm['at']<t0]; Xs=X(smp)
    res={}
    def fit_lr(A,y):
        sc=StandardScaler().fit(A); m=LogisticRegression(C=0.5,max_iter=2000).fit(sc.transform(A),y); return lambda B: m.predict_proba(sc.transform(B))[:,1]
    res['current setup: backtest+live samples']=fit_lr(Xs,smp['win'])(Xts)
    res['shadow trades only']=fit_lr(Xtr,trn['win'])(Xts)
    res['shadow + backtest samples']=fit_lr(np.vstack([Xtr,Xs]),np.r_[trn['win'],smp['win']])(Xts)
    res['cell track record only']=fit_lr(Htr,trn['win'])(Hts)
    res['shadow features + track record']=fit_lr(np.hstack([Xtr,Htr]),trn['win'])(np.hstack([Xts,Hts]))
    g=HistGradientBoostingClassifier(max_iter=200,learning_rate=0.05,max_leaf_nodes=15,l2_regularization=1.0,random_state=0).fit(np.hstack([Xtr,Htr]),trn['win'])
    res['boosted trees, features + track record']=g.predict_proba(np.hstack([Xts,Hts]))[:,1]
    res['rule: cell last-10 mean R']=Hts[:,1]
    y=tst['win'].values; r=tst['r'].values
    print(f"\n== {label}: train {len(trn)} shadow trades (+{len(smp)} backtest/live samples before {pd.to_datetime(t0,unit='ms').date()}), test {len(tst)} shadow trades, test R/trade {r.mean():+.3f}")
    print(f"{'model':42} {'AUC':>6} {'top half R':>10} {'bottom half R':>13} {'drop lowest third: kept R':>26} {'Δ sum R':>8}")
    for k,p in res.items():
        o=np.argsort(p); n=len(p); bot,top=o[:n//2],o[n//2:]; lo3=o[:n//3]; kept=np.setdiff1d(np.arange(n),lo3)
        auc=roc_auc_score(y,p) if len(set(y))>1 else float('nan')
        print(f"{k:42} {auc:6.3f} {r[top].mean():+10.3f} {r[bot].mean():+13.3f} {r[kept].mean():+26.3f} {r[kept].sum()-r.sum():+8.1f}")
evaluate(0.7,'split A: newest 30% as test')
evaluate(0.5,'split B: newest 50% as test')
