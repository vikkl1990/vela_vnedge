"""Read-only, causal sensitivity studies; never imports results into promotion evidence."""
import collections,datetime,json,math,pathlib,statistics,sys
ROOT=pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else pathlib.Path(__file__).parent
# Input directory must contain the sanitized account-study-input.json and account-paths.json snapshots.
# Writes only a local report; never connects to or mutates the bot.
data=json.load(open(ROOT/'account-study-input.json'));closed=[r for r in data['positions']if r['status']=='closed']
paths=collections.defaultdict(list)
for r in json.load(open(ROOT/'account-paths.json'))['paths']:paths[r['position_id']].append(r)
end=data['at'];split=end-14*86400000
def stats(values):
    gain=sum(x for x in values if x>0);loss=-sum(x for x in values if x<0)
    eq=peak=dd=0
    for v in values:eq+=v;peak=max(peak,eq);dd=max(dd,peak-eq)
    return {'trades':len(values),'net':sum(values),'pf':gain/loss if loss else None,'maxClosedDrawdown':dd,'wins':sum(x>0 for x in values)}

# Reweight only trades actually admitted. This cannot show added opportunities, queue effects or changed fills.
sizing=[]
for target in [None,5,7.5,10,15]:
    rows=[]
    for r in closed:
        gross=r['qty']*r['contract_value']*r['entry_price'];risk=r['risk_amount'];net=r['realized_pnl']-r['fees']
        if gross<=0 or risk<=0:continue
        # Never extrapolate beyond observed quantity/depth in this study.
        scale=1 if target is None else min(1,target/risk)
        q=math.floor(r['qty']*scale);scale=q/r['qty'];notional=gross*scale
        stopRisk=notional*(abs(r['entry_price']-r['sl_original'])/r['entry_price']+.00118+.0004) if r['sl_original'] else math.inf
        if target is not None and stopRisk>30:
            q=math.floor(q*30/stopRisk);scale=q/r['qty'];notional=gross*scale
        leverage=r.get('marginLeverage') or 5
        if target is not None:
            stop=abs(r['entry_price']-(r['sl_original']or r['entry_price']))/r['entry_price']
            leverage=min(100,1/(stop*1.25+.005),max(5,notional/50))
        rows.append({'id':r['id'],'entry':r['entry_at'],'exit':r['exit_at'],'net':net*scale,'margin':notional/leverage if leverage>0 else 0,'lev':leverage,'qty':q,'sample':'later' if r['entry_at']>=split else 'earlier'})
    rows.sort(key=lambda r:(r['exit'],r['id']))
    sizing.append({'targetRiskUsd':target,'sample':'observed quantities only; smaller risk reweight, no newly admitted trades','earlier':stats([r['net']for r in rows if r['sample']=='earlier' and r['qty']]),'later':stats([r['net']for r in rows if r['sample']=='later' and r['qty']]),'total':stats([r['net']for r in rows if r['qty']]),'medianMargin':statistics.median(r['margin']for r in rows if r['qty']),'maxLev':max(r['lev']for r in rows if r['qty'])})

def fee(f):
    if f['reason']=='funding':return 0
    if f.get('feeGross') is not None:return f['feeGross']
    # Missing historic gross fees are conservatively reconstructed, never called actual cash.
    return max(f.get('fee',0),f['price']*f['qty']*cv*(.000236 if f.get('liquidity')=='maker' else .00059))

eligible=[];coverage=collections.Counter()
for r in closed:
    pp=paths[r['id']];fills=r['fills'];entries=[f for f in fills if f['reason']=='entry']
    if len(entries)!=1 or entries[0]['qty']!=r['qty']:coverage['non-single-entry']+=1;continue
    if len(pp)<3 or r['risk_amount']<=0:coverage['missing-path']+=1;continue
    if pp[0]['at']-r['entry_at']>120000 or r['exit_at']-pp[-1]['at']>120000 or any(b['at']-a['at']>180000 for a,b in zip(pp,pp[1:])):coverage['path-gaps']+=1;continue
    cv=r['contract_value'];base=r['realized_pnl']-sum(fee(f)for f in fills)
    eligible.append((r,pp,base));coverage['usable']+=1

targets=[]
for target,share in [(t,s)for t in [.5,.75,1,1.5,2,3]for s in [1,.5]]:
    rows=[]
    for r,pp,base in eligible:
        trigger=next((i for i,p in enumerate(pp[:-1])if p['r']>=target),None)
        change=0;executed=False
        if trigger is not None:
            # Wait for the NEXT observed price; no target-level fill and no intraminute path invention.
            p=pp[trigger+1];at=p['at'];cv=r['contract_value'];q=math.floor(r['qty']*share);dir=1 if r['side']=='long' else -1
            prior=[f for f in r['fills']if f['at']<=at and f['reason']not in ['entry','funding']]
            # Fixed TP must precede all actual partial exits; otherwise leave the trade unchanged.
            if q>0 and not prior and at<r['exit_at']:
                price=p['price']*(1-dir*.0005)
                beforeFunding=sum(f.get('pnl',0)for f in r['fills']if f['reason']=='funding' and f['at']<=at)*q/r['qty']
                entryFee=sum(fee(f)for f in r['fills']if f['reason']=='entry')*q/r['qty']
                early=(price-r['entry_price'])*dir*q*cv-entryFee-price*q*cv*.00059+beforeFunding
                result=early+base*(1-q/r['qty']);change=result-base;executed=True
        rows.append({'exit':r['exit_at'],'candidateExit':at if executed and share==1 else r['exit_at'],'id':r['id'],'scanner':r['scanner_id'],'tf':r['tf'],'sample':'later' if r['entry_at']>=split else 'earlier','base':base,'candidate':base+change,'change':change,'fired':executed,'stop':r['exit_reason']=='sl','rescued':executed and base<0 and base+change>base,'cutGood':executed and base>0 and change<0})
    groups=collections.defaultdict(list)
    for r in rows:groups[(r['scanner'],r['tf'],r['sample'])].append(r)
    groupStats=[{'scanner':k[0],'tf':k[1],'sample':k[2],'baseline':stats([r['base']for r in sorted(v,key=lambda x:(x['exit'],x['id']))]),'candidate':stats([r['candidate']for r in sorted(v,key=lambda x:(x['candidateExit'],x['id']))]),'change':sum(r['change']for r in v),'fired':sum(r['fired']for r in v),'rescued':sum(r['rescued']for r in v),'cutGood':sum(r['cutGood']for r in v)}for k,v in groups.items()]
    targets.append({'targetR':target,'share':share,'groups':groupStats,'overall':{'baseline':stats([r['base']for r in sorted(rows,key=lambda x:(x['exit'],x['id']))]),'candidate':stats([r['candidate']for r in sorted(rows,key=lambda x:(x['candidateExit'],x['id']))]),'fired':sum(r['fired']for r in rows),'change':sum(r['change']for r in rows)}})

# Choose by EARLIER slice only; evaluate once on later entries. No tuning on the later period.
families=set((g['scanner'],g['tf'])for t in targets for g in t['groups']);selection=[]
for scanner,tf in sorted(families):
    options=[]
    for t in targets:
        earlier=next((g for g in t['groups']if g['scanner']==scanner and g['tf']==tf and g['sample']=='earlier'),None)
        if earlier and earlier['baseline']['trades']>=30 and earlier['fired']>=10 and earlier['change']>0:options.append((t,earlier))
    if not options:continue
    t,early=max(options,key=lambda z:z[1]['change']);later=next((g for g in t['groups']if g['scanner']==scanner and g['tf']==tf and g['sample']=='later'),None)
    selection.append({'scanner':scanner,'tf':tf,'targetR':t['targetR'],'share':t['share'],'earlier':early,'later':later,'prospectiveOnly':True})
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'holdoutEntryFrom':datetime.datetime.fromtimestamp(split/1000,datetime.timezone.utc).isoformat(),'purse':1000,'sizing':sizing,'pathCoverage':dict(coverage),'targetCandidates':targets,'selectedOnEarlierOnly':selection,'limitations':['Illustrative leverage calculations use a generic maintenance buffer, not historic product/tier limits. They are not executable allocation recommendations. The deployable advisory module separately respects current product and policy ceilings.', 'Historical sizing reweight does not model extra trades, funding/liquidation tier changes, or deeper books. Not a profitability backtest of a new allocator.','Minute observations cannot establish actual tick executions; exits use next observation and 5bp adverse price stress. Full gross commissions exclude all promotional discounts for both sides.','Actual entry sequence retained; no cooldown/capacity reuse after hypothetical early exits. Historical source/execution policies mixed; prospective per-version evidence required.','Research results never count toward promotion. No configuration changed.']}
(ROOT/'capital-target-study.json').write_text(json.dumps(result,indent=2))
print(json.dumps({'coverage':dict(coverage),'sizing':sizing,'selected':selection},indent=2))
