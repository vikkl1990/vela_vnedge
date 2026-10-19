import json,sys,datetime as D,html,collections as C
S=sys.argv[1]; R=json.load(open(S+'/cmp-out.json')); sm=R['summ']; po=R['po']; so=R['so']; ev=R['every']; match=R['match']
ist=lambda ms:(D.datetime.fromtimestamp(ms/1000,D.UTC)+D.timedelta(hours=5,minutes=30))
hm=lambda ms:ist(ms).strftime('%H:%M') if ist(ms).day==19 else ist(ms).strftime('%d %b %H:%M')
fm=lambda x:('+' if x>=0 else '−')+'$'+format(abs(x),',.2f')
cls=lambda x:'pos' if x>0 else 'neg'
E=html.escape
reason={'trail':'trail','sl':'stop','reversal':'reversal','tp1':'target','script_exit':'script','stale':'time','be':'break-even'}
def lv(L): return f'{L:.0f}×' if abs(L-round(L))<0.05 else f'{L:.1f}×'
def common(t):
    move=(t['exit_price']-t['entry_price'])/t['entry_price']*100*(1 if t['side']=='long' else -1)
    return (f'<td class="mono">{hm(t["entry_at"])}</td><td class="mono">{hm(t["exit_at"])}</td><td class="scn">{E(t["scanner_name"])}</td>'
            f'<td class="mono">{t["symbol"].replace("USD","")} <span class="muted">{t["tf"]}</span></td><td><span class="side {t["side"]}">{t["side"]}</span></td>'
            f'<td class="num">{t["stop"]*100:.2f}%</td><td class="num {cls(move)}">{move:+.2f}%</td><td>{reason.get(t["exit_reason"],t["exit_reason"])}</td>')
tierc=lambda tier:{50:'t-hi',2.5:'t-lo'}.get(tier,'t-mid')
prow=''
for t in sorted(R['paper'],key=lambda t:t['entry_at']):
    p=po.get(str(t['id'])) or po.get(t['id']); act=t['realized_pnl']-t['fees']
    tw=match.get(str(t['id'])); twin=f'<td class="num {cls(ev[str(tw)]["pnl"])}">{fm(ev[str(tw)]["pnl"])}</td>' if tw else '<td class="muted">no closed twin</td>'
    if not p or p['skipped']:
        prow+=f'<tr class="skip">{common(t)}<td colspan="6" class="muted">Skipped: no free slot or margin.</td><td class="num {cls(act)}">{fm(act)}</td>{twin}</tr>'; continue
    prow+=(f'<tr>{common(t)}<td class="muted rec">{E(p["why"])}</td><td class="num"><span class="tier {tierc(p["tier"])}">{lv(p["L"])}</span>'
           f'{"" if p["lim"]=="record" else f"<span class=lim>{E(p["lim"])}</span>"}</td><td class="num">${p["notional"]:,.0f}</td>'
           f'<td class="num {cls(p["pnl"])} strong">{"<span class=chip>liquidated</span> " if p["liq"] else ""}{fm(p["pnl"])}</td><td class="num">${p["bal"]:,.2f}</td><td class="num muted">${p["stopcost"]:.2f}</td>'
           f'<td class="num {cls(act)}">{fm(act)}</td>{twin}</tr>')
inpaper=set(int(v) for v in match.values())
srow=''
for t in sorted(R['shadow'],key=lambda t:t['entry_at']):
    e=ev[str(t['id'])]
    srow+=(f'<tr>{common(t)}<td class="num {cls(t["R"])}">{t["R"]:+.2f}R</td><td class="num">{lv(e["L"])}</td><td class="num {cls(e["pnl"])}">{"<span class=chip>liquidated</span> " if e["liq"] else ""}{fm(e["pnl"])}</td>'
           f'<td>{"<span class=yes>in paper</span>" if t["id"] in inpaper else "<span class=muted>not copied</span>"}</td></tr>')
# by scanner
g=C.defaultdict(lambda:dict(sn=0,s=0.0,sr=0.0,pn=0,p=0.0,name=''))
for t in R['shadow']:
    x=g[t['scanner_id']]; x['name']=t['scanner_name']; x['sn']+=1; x['s']+=ev[str(t['id'])]['pnl']; x['sr']+=t['R']
for t in R['paper']:
    x=g[t['scanner_id']]; x['name']=t['scanner_name']; p=po.get(str(t['id']))
    if p and not p['skipped']: x['pn']+=1; x['p']+=p['pnl']
grow=''.join(f'<tr><td class="scn">{E(x["name"])}</td><td class="num">{x["sn"]}</td><td class="num {cls(x["sr"])}">{x["sr"]:+.2f}R</td><td class="num {cls(x["s"])}">{fm(x["s"])}</td><td class="num">{x["pn"]}</td><td class="num {cls(x["p"]) if x["pn"] else "muted"}">{fm(x["p"]) if x["pn"] else "–"}</td></tr>'
             for x in sorted(g.values(),key=lambda x:-abs(x['s']))[:25])
# chart
def actcurve(trades):
    c=[(min(t['exit_at'] for t in trades),1000.0)]; e=1000
    for t in sorted(trades,key=lambda t:t['exit_at']): e+=t['realized_pnl']-t['fees']; c.append((t['exit_at'],e))
    return c
curves=[(R['pc'],'l-paper'),(R['sc'],'l-shadow'),(actcurve(R['paper']),'l-act')]
W,H,L0,Rm,Tp,B=760,280,64,16,16,36
pts=[p for c,_ in curves for p in c]; t0=min(p[0] for p in pts); t1=max(p[0] for p in pts); ymin=900; ymax=max(1400,max(p[1] for p in pts)+30)
X=lambda t:L0+(t-t0)/(t1-t0)*(W-L0-Rm); Y=lambda v:Tp+(ymax-v)/(ymax-ymin)*(H-Tp-B)
gsv=''.join(f'<line x1="{L0}" x2="{W-Rm}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" class="{"zero" if v==1000 else "grid"}"/><text x="{L0-8}" y="{Y(v)+4:.1f}" text-anchor="end" class="axis">${v:,}</text>' for v in range(900,int(ymax)+1,100))
h=ist(t0).replace(minute=0,second=0,microsecond=0)
while (h-D.timedelta(hours=5,minutes=30)).timestamp()*1000<=t1:
    ms=(h-D.timedelta(hours=5,minutes=30)).timestamp()*1000
    if ms>=t0 and h.hour%4==0: gsv+=f'<text x="{X(ms):.1f}" y="{H-12}" text-anchor="middle" class="axis">{h.strftime("%H:%M")}</text>'
    h+=D.timedelta(hours=1)
for c,k in curves:
    gsv+=f'<path d="{" ".join(("M" if i==0 else "L")+f"{X(t):.1f},{Y(v):.1f}" for i,(t,v) in enumerate(c))}" class="{k}"/><circle cx="{X(c[-1][0]):.1f}" cy="{Y(c[-1][1]):.1f}" r="3.5" class="{k}-dot"/>'
svg=f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="Balance through the day, paper and shadow">{gsv}</svg>'
cut=ist(R['now']).strftime('%H:%M')
def card(cls_,title,sub,val,rows):
    return f'<article class="card {cls_}"><h3>{title}</h3><p class="sub">{sub}</p><div class="big {cls(val)}">{fm(val)}</div><dl>{"".join(f"<dt>{a}</dt><dd>{b}</dd>" for a,b in rows)}</dl></article>'
cards=(card('paper','Paper, new sizing','A $1,000 account, $150 a trade, up to 8 open',sm['paper_new'],[('Trades taken',f"{sm['paper_taken']} of {sm['n_paper']}"),('Deepest drop',f"${R['ddp']:,.2f}"),('As actually traded',fm(sm['paper_act'])),('In R',f"{sm['paper_R']:+.2f}R")])
      +card('shadow','Shadow, same account rules','A $1,000 account, $150 a trade, up to 8 open',sm['shadow_acct'],[('Trades taken',f"{sm['shadow_taken']} of {sm['n_shadow']}"),('Deepest drop',f"${R['dds']:,.2f}"),('Slots held by open trades',f"{len(R['opens'])} at {cut}"),('In R',f"{sm['shadow_R']:+.2f}R")])
      +card('every','Shadow, every signal','Each trade sized at $150 on its own, no account limits',sm['shadow_every'],[('Signals',str(sm['n_shadow'])),('Copied to paper',f"{sm['matched']}, worth {fm(sm['shadow_matched_every'])}"),('Not copied',f"{sm['n_unmatched']}, worth {fm(sm['shadow_unmatched_every'])}")]))
TOK=""":root{--bg:#f4f6f8;--panel:#fff;--fg:#141c26;--muted:#5a6878;--line:#dce2e9;--pos:#0f7a52;--neg:#b42318;--paper:#2456c7;--shadow:#8a4bc2;--every:#0f6b5c;--act:#8a949f;
--display:"Fraunces",Georgia,serif;--body:"IBM Plex Sans",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0e131a;--panel:#151c25;--fg:#e5ebf2;--muted:#93a1b2;--line:#26303c;--pos:#3ccf8e;--neg:#ff6b5e;--paper:#7aa2ff;--shadow:#c294f0;--every:#3fd0b4;--act:#7d8893;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0e131a;--panel:#151c25;--fg:#e5ebf2;--muted:#93a1b2;--line:#26303c;--pos:#3ccf8e;--neg:#ff6b5e;--paper:#7aa2ff;--shadow:#c294f0;--every:#3fd0b4;--act:#7d8893;color-scheme:dark}"""
CSS=TOK+"""
body{background:var(--bg);color:var(--fg);font:15px/1.5 var(--body);padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:28px 48px}
main{max-width:1280px;margin:0 auto;display:grid;gap:26px}
h1{font:600 clamp(26px,4vw,36px)/1.15 var(--display);margin:0;text-wrap:balance} h2{font:600 12px/1.2 var(--body);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 12px} h3{font:600 15px/1.3 var(--body);margin:0}
.lede{max-width:72ch;color:var(--muted);margin:8px 0 0}
.rules{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px} .rule{border-left:3px solid var(--paper);padding:2px 0 2px 12px} .rule b{display:block} .rule span{color:var(--muted);font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-top:3px solid var(--paper);border-radius:8px;padding:16px 18px;display:grid;gap:6px;align-content:start}
.card.shadow{border-top-color:var(--shadow)} .card.every{border-top-color:var(--every)}
.sub{margin:0;color:var(--muted);font-size:13px} .big{font:500 30px/1.1 var(--mono);font-variant-numeric:tabular-nums;margin:6px 0}
dl{display:grid;grid-template-columns:1fr auto;gap:4px 12px;margin:0;font-size:13px} dt{color:var(--muted)} dd{margin:0;font-family:var(--mono);text-align:right;font-variant-numeric:tabular-nums}
.pos{color:var(--pos)} .neg{color:var(--neg)} .muted{color:var(--muted)} .strong{font-weight:600}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px 18px;min-width:0}
svg{width:100%;height:auto;display:block} .grid{stroke:var(--line)} .zero{stroke:var(--muted);stroke-dasharray:3 3} .axis{fill:var(--muted);font:11px var(--mono)}
path{fill:none;stroke-width:2;stroke-linejoin:round} .l-paper{stroke:var(--paper);stroke-width:2.5} .l-shadow{stroke:var(--shadow)} .l-act{stroke:var(--act);stroke-dasharray:5 4}
.l-paper-dot{fill:var(--paper)} .l-shadow-dot{fill:var(--shadow)} .l-act-dot{fill:var(--act)}
.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--muted);margin-top:8px} .legend i{display:inline-block;width:16px;height:3px;vertical-align:middle;margin-right:6px}
.notes{display:grid;gap:6px;max-width:78ch;margin:0;padding-left:18px}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:13px} table.wide{min-width:1500px} table.mid{min-width:1150px} table.small{min-width:620px}
th{text-align:left;font-weight:600;color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase;padding:10px;border-bottom:1px solid var(--line);white-space:nowrap;background:var(--panel)}
td{padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap} tr:last-child td{border-bottom:0}
tr.skip td{background:color-mix(in srgb,var(--line) 35%,transparent)}
.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums} th.num{text-align:right} .mono{font-family:var(--mono)}
.scn{max-width:250px;overflow:hidden;text-overflow:ellipsis} .rec{font-size:12px}
.side{font:500 11px var(--mono);text-transform:uppercase;letter-spacing:.05em} .side.long{color:var(--pos)} .side.short{color:var(--neg)}
.tier{font-weight:600;padding:1px 6px;border-radius:4px;border:1px solid var(--line)} .t-hi{color:var(--pos);border-color:var(--pos)} .t-lo{color:var(--neg);border-color:var(--neg)}
.lim{display:block;font:11px var(--body);color:var(--muted)} .chip{font:600 10px var(--body);text-transform:uppercase;border:1px solid var(--neg);border-radius:4px;padding:1px 5px}
.yes{color:var(--paper);font-weight:500} th.p{color:var(--paper)} th.s{color:var(--shadow)}
details summary{cursor:pointer;font-weight:600;padding:6px 0} details summary:focus-visible{outline:2px solid var(--paper);outline-offset:2px}
"""
page=f'''<title>Paper vs Shadow Journal</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Fraunces:opsz,wght@9..144,600&display=swap">
<style>
/* layout: two ledgers side by side in summary, then the paper blotter, the scanner comparison, the shadow blotter */
{CSS}</style>
<main>
<header><h1>Today's paper and shadow trades at $150 margin</h1>
<p class="lede">Every trade that closed on 19 October up to {cut} IST, replayed with its real entry, exit, stop and times. Only the size changes. Paper and shadow get the same sizing, so the difference between them is which signals each one took.</p></header>
<section class="rules" aria-label="Sizing">
<div class="rule"><b>$150 margin per trade</b><span>5× by default, a $750 position</span></div>
<div class="rule"><b>Leverage from the record</b><span>The scanner on the same market and timeframe, its last 30 shadow trades: above +0.05R up to 50×, below −0.05R 2.5×, otherwise 5×</span></div>
<div class="rule"><b>Never past the stop</b><span>Capped at Delta's maximum, and lowered if liquidation would sit within 1.25 times the stop</span></div>
<div class="rule"><b>Up to 8 open</b><span>Or as many as the free margin allows</span></div>
</section>
<section class="cards" aria-label="Totals">{cards}</section>
<section class="panel"><h2>Balance through the day, from $1,000</h2>{svg}
<div class="legend"><span><i style="background:var(--paper)"></i>paper, new sizing</span><span><i style="background:var(--shadow)"></i>shadow, same account rules</span><span><i style="background:var(--act)"></i>paper as actually traded</span></div></section>
<section><h2>What the comparison shows</h2><ol class="notes">
<li>The new sizing turns the paper day from {fm(sm['paper_act'])} into {fm(sm['paper_new'])}, on the same trades.</li>
<li>Taken one by one, the shadow book's {sm['n_shadow']} signals were worth {fm(sm['shadow_every'])}. The {sm['matched']} that paper copied were worth {fm(sm['shadow_matched_every'])}; the {sm['n_unmatched']} it did not copy were worth {fm(sm['shadow_unmatched_every'])}.</li>
<li>Run as a $1,000 account, the shadow book makes less than paper today: {fm(sm['shadow_acct'])}. Its {len(R['opens'])} long-running open positions hold most of the 8 slots, so it takes only {sm['shadow_taken']} of its {sm['n_shadow']} signals.</li>
<li>{sm['n_paper']-sm['matched']} paper trades have no closed shadow twin yet: the shadow copy is still open, or it is a tracker cell.</li>
</ol></section>
<section><h2>Paper journal, times in IST</h2>
<div class="scroll"><table class="wide"><thead><tr><th>Opened</th><th>Closed</th><th>Scanner</th><th>Market</th><th>Side</th><th class="num">Stop</th><th class="num">Price move</th><th>Exit</th><th class="p">Record</th><th class="num p">Leverage</th><th class="num p">Position</th><th class="num p">P&amp;L</th><th class="num p">Balance</th><th class="num p">Stop would cost</th><th class="num">As traded</th><th class="num s">Shadow twin</th></tr></thead><tbody>{prow}</tbody></table></div></section>
<section><h2>By scanner, today, at the same sizing</h2>
<div class="scroll"><table class="small"><thead><tr><th>Scanner</th><th class="num s">Shadow trades</th><th class="num s">Shadow R</th><th class="num s">Shadow $</th><th class="num p">Paper trades</th><th class="num p">Paper $</th></tr></thead><tbody>{grow}</tbody></table></div>
<p class="muted" style="font-size:13px;margin:8px 0 0">The 25 scanners with the largest shadow result either way. Shadow $ takes every signal at $150; paper $ is the paper account's replay.</p></section>
<section><details><summary>Shadow journal, {sm['n_shadow']} trades</summary>
<div class="scroll"><table class="mid"><thead><tr><th>Opened</th><th>Closed</th><th>Scanner</th><th>Market</th><th>Side</th><th class="num">Stop</th><th class="num">Price move</th><th>Exit</th><th class="num s">Result</th><th class="num s">Leverage</th><th class="num s">P&amp;L at $150</th><th>Paper</th></tr></thead><tbody>{srow}</tbody></table></div></details></section>
<section><h2>How this was built</h2><ol class="notes">
<li>Each trade keeps its real fills, stop, exit and times. Profit and fees scale with the position, so the Scalper Offer's waived closing fee carries over.</li>
<li>The record uses only shadow trades closed before the entry, so nothing from the future sets the leverage.</li>
<li>A trade is liquidated when its recorded worst point crossed the liquidation price for its leverage and the market's maintenance margin. It then loses the $150 and the opening fee. Worst points come from 1-minute prices.</li>
<li>A paper trade's shadow twin is the shadow trade of the same scanner, market, timeframe and side opened within 10 minutes of it.</li>
<li>Trades that opened before midnight and closed today are included. The tracker's cells are left out.</li>
</ol></section>
</main>'''
out='/Users/scorpion/Desktop/Vela_VNEdge/_research/journal-20261018/paper-vs-shadow.html'
open(out,'w').write(page); print('ok',len(page))
