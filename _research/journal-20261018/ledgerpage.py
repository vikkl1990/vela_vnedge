import json,sys,datetime as D,html,collections as C
S=sys.argv[1]; R=json.load(open(S+'/ledger-out.json')); s=R['S']; po=R['po']; so=R['so']; ev=R['every']
IST=D.timedelta(hours=5,minutes=30)
ist=lambda ms:D.datetime.fromtimestamp(ms/1000,D.UTC)+IST
hm=lambda ms:ist(ms).strftime('%d %b %H:%M')
fm=lambda x:('+' if x>=0 else '−')+'$'+format(abs(x),',.2f')
f0=lambda x:('+' if x>=0 else '−')+'$'+format(abs(x),',.0f')
cls=lambda x:'pos' if x>0 else 'neg' if x<0 else ''
E=html.escape
RS={'trail':'trail','sl':'stop','reversal':'reversal','tp1':'target','tp2':'target','tp3':'target','script_exit':'script','stale':'time','be':'break-even','liquidation':'liquidation','manual':'manual'}
def g(m,i): return m.get(str(i))
# daily
day=C.defaultdict(lambda:[0.0,0.0,0.0,0.0,0,0])
for t in R['paper']:
    k=ist(t['exit_at']).date(); day[k][0]+=t['realized_pnl']-t['fees']; v=g(po,t['id'])
    if v['st']=='taken': day[k][1]+=v['pnl']; day[k][4]+=1
for t in R['shadow']:
    k=ist(t['exit_at']).date(); v=g(so,t['id'])
    if v['st']=='taken': day[k][2]+=v['pnl']
    if str(t['id']) in ev: day[k][3]+=ev[str(t['id'])]
    day[k][5]+=1
cum=[0,0,0]; drows=''
for k in sorted(day):
    a,b,c_,e,n,ns=day[k]; cum[0]+=a; cum[1]+=b; cum[2]+=c_
    drows+=f'<tr><td class="mono">{k.strftime("%a %d %b")}</td><td class="num {cls(a)}">{fm(a)}</td><td class="num {cls(b)} strong">{fm(b)}</td><td class="num muted">{f0(cum[1])}</td><td class="num {cls(c_)}">{fm(c_)}</td><td class="num muted">{f0(cum[2])}</td><td class="num {cls(e)}">{fm(e)}</td></tr>'
# chart: cumulative by exit for paper recorded, paper corrected, shadow corrected
pr=[]; e_=1000
for t in sorted(R['paper'],key=lambda t:t['exit_at']): e_+=t['realized_pnl']-t['fees']; pr.append((t['exit_at'],e_))
curves=[(pr,'l-act','paper as recorded'),([(a,b) for a,b in R['pc']],'l-paper','paper corrected'),([(a,b) for a,b in R['sc']],'l-shadow','shadow corrected')]
W,H,L0,Rm,Tp,B=780,300,70,16,16,36
pts=[p for c,_,_ in curves for p in c]; t0=min(p[0] for p in pts); t1=max(p[0] for p in pts)
ymin=min(800,min(p[1] for p in pts)-50); ymax=max(p[1] for p in pts)+200
import math
step=1000 if ymax-ymin>4000 else 500 if ymax-ymin>1500 else 100
X=lambda t:L0+(t-t0)/(t1-t0)*(W-L0-Rm); Y=lambda v:Tp+(ymax-v)/(ymax-ymin)*(H-Tp-B)
gs=''
v=math.ceil(ymin/step)*step
while v<=ymax:
    gs+=f'<line x1="{L0}" x2="{W-Rm}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" class="{"zero" if v==1000 else "grid"}"/><text x="{L0-8}" y="{Y(v)+4:.1f}" text-anchor="end" class="axis">${v:,.0f}</text>'; v+=step
dd=ist(t0).replace(hour=0,minute=0,second=0,microsecond=0)
while (dd-IST).timestamp()*1000<=t1:
    ms=(dd-IST).timestamp()*1000
    if ms>=t0 and dd.weekday()==0: gs+=f'<text x="{X(ms):.1f}" y="{H-12}" text-anchor="middle" class="axis">{dd.strftime("%d %b")}</text><line x1="{X(ms):.1f}" x2="{X(ms):.1f}" y1="{Tp}" y2="{H-B}" class="grid"/>'
    dd+=D.timedelta(days=1)
for c,k,_ in curves:
    gs+=f'<path d="{" ".join(("M" if i==0 else "L")+f"{X(a):.1f},{Y(b):.1f}" for i,(a,b) in enumerate(c))}" class="{k}"/><circle cx="{X(c[-1][0]):.1f}" cy="{Y(c[-1][1]):.1f}" r="3.5" class="{k}-dot"/>'
svg=f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="Balance from $1,000: paper as recorded, paper corrected, shadow corrected">{gs}</svg>'
def common(t):
    return (f'<td class="mono">{hm(t["entry_at"])}</td><td class="mono">{hm(t["exit_at"])}</td><td class="scn">{E(t["scanner_name"])}</td><td class="mono">{t["symbol"].replace("USD","")} <span class="muted">{t["tf"]}</span></td>'
            f'<td><span class="side {t["side"]}">{t["side"]}</span></td><td class="num">{t["stop"]*100:.2f}%</td><td>{"script" if t["levels_source"]!="atr-fallback" else "ATR"}</td><td>{RS.get(t["exit_reason"],t["exit_reason"])}</td><td class="num {cls(t["R"])}">{t["R"]:+.2f}R</td>')
def lv(L): return f'{L:.0f}×' if abs(L-round(L))<0.05 else f'{L:.1f}×'
def corr(v):
    if v['st']!='taken': return f'<td colspan="4" class="muted">{"Skipped: script stop" if v["st"]=="script stop" else "Skipped: "+v["st"]}</td>'
    return f'<td class="num"><span class="tier {"t-hi" if v["tier"]==20 else ""}">{lv(v["L"])}</span></td><td class="num">${v["n"]:,.0f}</td><td class="num {cls(v["pnl"])} strong">{"<span class=chip>liquidated</span> " if v["liq"] else ""}{fm(v["pnl"])}</td><td class="num">${v["bal"]:,.2f}</td>'
prow=''.join(f'<tr class="{"" if g(po,t["id"])["st"]=="taken" else "skip"}">{common(t)}<td class="num {cls(t["realized_pnl"]-t["fees"])}">{fm(t["realized_pnl"]-t["fees"])}</td>{corr(g(po,t["id"]))}</tr>' for t in sorted(R['paper'],key=lambda t:t['entry_at']))
srow=''.join(f'<tr class="{"" if g(so,t["id"])["st"]=="taken" else "skip"}">{common(t)}{corr(g(so,t["id"]))}</tr>' for t in sorted(R['shadow'],key=lambda t:t['entry_at']))
start=ist(min(t['entry_at'] for t in R['paper'])).strftime('%d %b'); sstart=ist(min(t['entry_at'] for t in R['shadow'])).strftime('%d %b'); cut=ist(R['now']).strftime('%d %b %H:%M')
def card(c,title,sub,val,rows): return f'<article class="card {c}"><h3>{title}</h3><p class="sub">{sub}</p><div class="big {cls(val)}">{fm(val)}</div><dl>{"".join(f"<dt>{a}</dt><dd>{b}</dd>" for a,b in rows)}</dl></article>'
pk=max([1000]+[b for _,b in R['sc']]); 
cards=(card('act','Paper, as recorded',f'{len(R["paper"])} trades since {start}, 1% risk sizing',s['paper_rec'],[('In R',f"{s['paper_R']:+.2f}R"),('Stop-outs',str(s['paper_sl_rec']))])
 +card('paper','Paper, corrected','The rules live now, from $1,000',s['paper_new'],[('Trades taken',f"{s['paper_taken']} of {len(R['paper'])}"),('Skipped, script stop',str(s['paper_script'])),('Skipped, no slot',str(s['paper_slot'])),('Stop-outs',f"{s['paper_sl_new']} instead of {s['paper_sl_rec']}"),('Deepest drop',f"${s['paper_dd']:,.2f}")])
 +card('shadow','Shadow, corrected',f'The same rules as one $1,000 account, {len(R["shadow"])} signals since {sstart}',s['shadow_new'],[('Trades taken',f"{s['shadow_taken']} of {len(R['shadow'])}"),('Skipped, script stop',str(s['shadow_script'])),('Stop-outs taken',f"{s['shadow_sl_new']} of {s['shadow_sl_rec']}"),('Deepest drop',f"${s['shadow_dd']:,.0f}")])
 +card('every','Shadow, every signal','Each ATR-stop signal at $150 on its own',s['shadow_every'],[('In R, as recorded',f"{s['shadow_R']:+.1f}R"),('In R, script stops removed',f"{s['shadow_R_filtered']:+.1f}R")]))
CSS=open(S+'/cmppage.py').read().split('CSS=TOK+"""')[1].split('"""')[0]
TOK=open(S+'/cmppage.py').read().split('TOK="""')[1].split('"""')[0]
page=f'''<title>Corrected Ledger</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Fraunces:opsz,wght@9..144,600&display=swap">
<style>
/* layout: four ledger totals, one balance chart, the day book, then both full ledgers */
{TOK}
{CSS}
.card.act{{border-top-color:var(--act)}} table.wide{{min-width:1500px}} table.mid{{min-width:1250px}}
</style>
<main>
<header><h1>The paper and shadow ledgers, corrected to today's rules</h1>
<p class="lede">Every closed trade up to {cut} IST, replayed with its real entry, exit, stop and times under the rules that went live on 19 and 20 October. The stored records are unchanged; this is what the same signals make under the new rules.</p></header>
<section class="rules" aria-label="The rules">
<div class="rule"><b>$150 margin per trade</b><span>5× by default; 20× when the scanner's last 30 shadow trades on the market average above +0.05R</span></div>
<div class="rule"><b>Never past the stop</b><span>Under Delta's maximum, and lowered so liquidation stays beyond 1.25 times the stop</span></div>
<div class="rule"><b>Only the ATR stop</b><span>Signals whose stop the scanner placed itself are skipped</span></div>
<div class="rule"><b>Up to 8 open</b><span>Or as many as the free margin allows</span></div>
</section>
<section class="cards" aria-label="Totals">{cards}</section>
<section class="panel"><h2>Balance from $1,000</h2>{svg}
<div class="legend"><span><i style="background:var(--act)"></i>paper as recorded</span><span><i style="background:var(--paper)"></i>paper corrected</span><span><i style="background:var(--shadow)"></i>shadow corrected</span></div></section>
<section><h2>Day by day, IST</h2><div class="scroll"><table class="small" style="min-width:820px"><thead><tr><th>Day</th><th class="num">Paper as recorded</th><th class="num p">Paper corrected</th><th class="num p">running</th><th class="num s">Shadow corrected</th><th class="num s">running</th><th class="num">Shadow, every signal</th></tr></thead><tbody>{drows}</tbody></table></div></section>
<section><h2>Paper ledger, {len(R["paper"])} trades, times in IST</h2><div class="scroll"><table class="wide"><thead><tr><th>Opened</th><th>Closed</th><th>Scanner</th><th>Market</th><th>Side</th><th class="num">Stop</th><th>Stop from</th><th>Exit</th><th class="num">Result</th><th class="num">As recorded</th><th class="num p">Leverage</th><th class="num p">Position</th><th class="num p">Corrected P&amp;L</th><th class="num p">Balance</th></tr></thead><tbody>{prow}</tbody></table></div></section>
<section><details><summary>Shadow ledger, {len(R["shadow"])} trades</summary><div class="scroll"><table class="mid"><thead><tr><th>Opened</th><th>Closed</th><th>Scanner</th><th>Market</th><th>Side</th><th class="num">Stop</th><th>Stop from</th><th>Exit</th><th class="num">Result</th><th class="num s">Leverage</th><th class="num s">Position</th><th class="num s">Corrected P&amp;L</th><th class="num s">Balance</th></tr></thead><tbody>{srow}</tbody></table></div></details></section>
<section><h2>How this was built</h2><ol class="notes">
<li>Each trade keeps its real fills, stop, exit and times. Profit and fees scale with the position, so the Scalper Offer's waived closing fee carries over.</li>
<li>The record that sets leverage uses only shadow trades closed before the entry.</li>
<li>A trade is liquidated when its recorded worst point crossed the liquidation price for its leverage; none did.</li>
<li>Skipping a trade frees its slot, but a signal the real account refused for other reasons is not in either ledger, so the corrected books cannot take it.</li>
<li>The shadow book is replayed as a single $1,000 account so the two can be compared; live, it still trades every signal in R and keeps its script-stop trades as evidence.</li>
<li>The tracker's cells are left out of the shadow ledger.</li>
</ol></section>
</main>'''
out='/Users/scorpion/Desktop/Vela_VNEdge/_research/journal-20261018/corrected-ledger.html'
open(out,'w').write(page); print('ok',len(page)//1024,'KB')
