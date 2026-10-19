import json,sys,datetime as D,html
S=sys.argv[1]; R=json.load(open(S+'/recon50.json')); T=R['T']; plan=R['plan']
ist=lambda ms:(D.datetime.fromtimestamp(ms/1000,D.UTC)+D.timedelta(hours=5,minutes=30))
fm=lambda x:('+' if x>=0 else '−')+'$'+format(abs(x),',.2f')
taken=[t for t in T if not plan[str(t['id'])]['skipped']]; sk=[t for t in T if plan[str(t['id'])]['skipped']]
pv=lambda t:plan[str(t['id'])]
net=R['cp'][-1][1]-1000; wins=sum(pv(t)['pnl']>0 for t in taken); fees=sum(pv(t)['fees'] for t in taken)
pk=1000; dd=0
for _,v in R['cp']: pk=max(pk,v); dd=max(dd,pk-v)
actc=[(min(t['entry_at'] for t in T),1000.0)]; e=1000
for t in sorted(T,key=lambda t:t['exit_at']): e+=t['realized_pnl']-t['fees']; actc.append((t['exit_at'],e))
curves=[('plan',R['cp'],'l-plan'),('flat',R['cf'],'l-nocap'),('act',actc,'l-act')]
W,H,L,Rm,Tp,B=760,280,64,16,16,36
allp=[p for _,c,_ in curves for p in c]; t0=min(p[0] for p in allp); t1=max(p[0] for p in allp)
ymin=900; ymax=max(1300,max(p[1] for p in allp)+20)
X=lambda t:L+(t-t0)/(t1-t0)*(W-L-Rm); Y=lambda v:Tp+(ymax-v)/(ymax-ymin)*(H-Tp-B)
g=''
for v in range(900,int(ymax)+1,100):
    g+=f'<line x1="{L}" x2="{W-Rm}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" class="{"zero" if v==1000 else "grid"}"/><text x="{L-8}" y="{Y(v)+4:.1f}" text-anchor="end" class="axis">${v:,}</text>'
h=ist(t0).replace(minute=0,second=0,microsecond=0)
while (h-D.timedelta(hours=5,minutes=30)).timestamp()*1000<=t1:
    ms=(h-D.timedelta(hours=5,minutes=30)).timestamp()*1000
    if ms>=t0 and h.hour%4==0: g+=f'<text x="{X(ms):.1f}" y="{H-12}" text-anchor="middle" class="axis">{h.strftime("%d %b %H:%M") if h.hour==0 else h.strftime("%H:%M")}</text>'
    h+=D.timedelta(hours=1)
for _,c,cls in curves:
    dpath=' '.join(f'{"M" if i==0 else "L"}{X(t):.1f},{Y(v):.1f}' for i,(t,v) in enumerate(c))
    g+=f'<path d="{dpath}" class="{cls}"/><circle cx="{X(c[-1][0]):.1f}" cy="{Y(c[-1][1]):.1f}" r="3.5" class="{cls}-dot"/>'
svg=f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="Balance through the day">{g}</svg>'
rows=''
reasonmap={'trail':'trail','sl':'stop','reversal':'reversal','tp1':'target','script_exit':'script'}
for t in sorted(T,key=lambda t:t['entry_at']):
    p=pv(t); stop=abs(t['entry_price']-t['sl_original'])/t['entry_price']*100
    move=(t['exit_price']-t['entry_price'])/t['entry_price']*100*(1 if t['side']=='long' else -1)
    act=t['realized_pnl']-t['fees']
    base=(f'<td class="mono">{ist(t["entry_at"]).strftime("%d %b %H:%M") if ist(t["entry_at"]).day!=19 else ist(t["entry_at"]).strftime("%H:%M")}</td><td class="mono">{ist(t["exit_at"]).strftime("%H:%M")}</td>'
      f'<td class="scn">{html.escape(t["scanner_name"])}</td><td class="mono">{t["symbol"].replace("USD","")} <span class="muted">{t["tf"]}</span></td>'
      f'<td><span class="side {t["side"]}">{t["side"]}</span></td><td class="num">{stop:.2f}%</td><td class="num {"pos" if move>0 else "neg"}">{move:+.2f}%</td><td>{reasonmap.get(t["exit_reason"],t["exit_reason"])}</td>')
    if p['skipped']:
        rows+=f'<tr class="skip">{base}<td colspan="8" class="muted">Skipped: 5 already open.</td><td class="num {"pos" if act>0 else "neg"}">{fm(act)}</td></tr>'
    else:
        lv=f'{p["L"]:.0f}×' if abs(p["L"]-round(p["L"]))<0.05 else f'{p["L"]:.1f}×'
        tierc={50:'t-hi',5:'t-lo'}.get(p['tier'],'t-mid')
        safeL=1/(t['stop']*1.25+t['maint']/100); want=p['tier']
        lim='record' if want<=min(t['cap'],safeL) else ('Delta max '+str(t['cap'])+'×' if t['cap']<=safeL else 'stop guard')
        rows+=(f'<tr>{base}<td class="muted rec">{html.escape(p["why"])}</td><td class="num muted">{want}×</td><td class="muted">{lim}</td><td class="num"><span class="tier {tierc}">{lv}</span></td><td class="num">${p["notional"]:,.0f}</td><td class="num muted">${p["stopcost"]:.2f}</td>'
               f'<td class="num {"pos" if p["pnl"]>0 else "neg"} strong">{fm(p["pnl"])}</td><td class="num">${p["bal"]:,.2f}</td><td class="num {"pos" if act>0 else "neg"}">{fm(act)}</td></tr>')
openrows=''.join(f'<li>{html.escape(o["scanner_name"])}, {o["symbol"].replace("USD","")} {o["tf"]} {o["side"]}, opened {ist(o["entry_at"]).strftime("%d %b %H:%M")} IST</li>' for o in R['O'])
cut=ist(R['now']).strftime('%H:%M')
def stat(k,v,cls=''): return f'<div class="stat"><span class="k">{k}</span><span class="v {cls}">{v}</span></div>'
page=f'''<title>Up to 50× Journal</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Fraunces:opsz,wght@9..144,600&display=swap">
<style>
/* layout: a desk blotter; headline numbers, one balance chart, the full journal in its own scroller */
:root{{--bg:#f5f7f6;--panel:#ffffff;--fg:#16211d;--muted:#5b6b65;--line:#dde4e1;--pos:#0f7a52;--neg:#b42318;--plan:#0f6b5c;--nocap:#7aa89d;--act:#8a949f;
--display:"Fraunces",Georgia,serif;--body:"IBM Plex Sans",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#0e1513;--panel:#151e1b;--fg:#e4ece9;--muted:#93a39d;--line:#26322e;--pos:#3ccf8e;--neg:#ff6b5e;--plan:#3fd0b4;--nocap:#4e8a7d;--act:#7d8893;color-scheme:dark}}}}
:root[data-theme="dark"]{{--bg:#0e1513;--panel:#151e1b;--fg:#e4ece9;--muted:#93a39d;--line:#26322e;--pos:#3ccf8e;--neg:#ff6b5e;--plan:#3fd0b4;--nocap:#4e8a7d;--act:#7d8893;color-scheme:dark}}
body{{background:var(--bg);color:var(--fg);font:15px/1.5 var(--body);padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:28px 48px}}
main{{max-width:1240px;margin:0 auto;display:grid;gap:26px}}
h1{{font:600 clamp(26px,4vw,36px)/1.15 var(--display);margin:0;text-wrap:balance}}
h2{{font:600 12px/1.2 var(--body);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}}
.lede{{max-width:70ch;color:var(--muted);margin:8px 0 0}}
.stats{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:8px;overflow:hidden}}
.stat{{background:var(--panel);padding:14px 16px;display:grid;gap:4px}} .k{{font-size:12px;color:var(--muted)}} .v{{font:500 22px/1.15 var(--mono);font-variant-numeric:tabular-nums}}
.stat.hero .v{{font-size:28px}}
.pos{{color:var(--pos)}} .neg{{color:var(--neg)}} .muted{{color:var(--muted)}} .strong{{font-weight:600}}
.panel{{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px 18px;min-width:0}}
svg{{width:100%;height:auto;display:block}} .grid{{stroke:var(--line)}} .zero{{stroke:var(--muted);stroke-dasharray:3 3}}
.axis{{fill:var(--muted);font:11px var(--mono)}} path{{fill:none;stroke-width:2;stroke-linejoin:round}}
.l-plan{{stroke:var(--plan);stroke-width:2.5}} .l-nocap{{stroke:var(--nocap);stroke-dasharray:5 4}} .l-act{{stroke:var(--act)}}
.l-plan-dot{{fill:var(--plan)}} .l-nocap-dot{{fill:var(--nocap)}} .l-act-dot{{fill:var(--act)}}
.legend{{display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--muted);margin-top:8px}} .legend i{{display:inline-block;width:16px;height:3px;vertical-align:middle;margin-right:6px}}
.rules{{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}}
.rule{{border-left:3px solid var(--plan);padding:2px 0 2px 12px}} .rule b{{display:block;font-weight:600}} .rule span{{color:var(--muted);font-size:13px}}
.scroll{{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel)}}
table{{border-collapse:collapse;width:100%;font-size:13px;min-width:1480px}}
th{{text-align:left;font-weight:600;color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase;padding:10px;border-bottom:1px solid var(--line);white-space:nowrap;background:var(--panel)}}
td{{padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap}} tr:last-child td{{border-bottom:0}}
tr.skip td{{background:color-mix(in srgb,var(--line) 35%,transparent)}}
.num{{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}} th.num{{text-align:right}} .mono{{font-family:var(--mono)}}
th.plan{{color:var(--plan)}}
.tier{{font-weight:600;padding:1px 6px;border-radius:4px;border:1px solid var(--line)}} .t-hi{{color:var(--pos);border-color:var(--pos)}} .t-lo{{color:var(--neg);border-color:var(--neg)}} .rec{{font-size:12px}}
.scn{{max-width:250px;overflow:hidden;text-overflow:ellipsis}}
.side{{font:500 11px var(--mono);text-transform:uppercase;letter-spacing:.05em}} .side.long{{color:var(--pos)}} .side.short{{color:var(--neg)}}
ul,ol{{margin:0;padding-left:18px;display:grid;gap:6px;max-width:78ch}}
</style>
<main>
<header><h1>Today's trades at $100 margin, up to 50× on a strong record</h1>
<p class="lede">The account's {len(T)} trades closed on 19 October up to {cut} IST, replayed with their real entries, exits, stops and times. Only the size changes. The balance starts at $1,000.</p></header>
<section class="rules" aria-label="The plan">
<div class="rule"><b>$100 margin per trade</b><span>Leverage sets the position: 5× is $500, 20× is $2,000, 50× is $5,000</span></div>
<div class="rule"><b>Leverage from the record</b><span>The same scanner on the same market and timeframe, its last 30 shadow trades: above +0.05R a trade asks for 50×, below −0.05R gets 5×, otherwise 10×. Fewer than 5 past trades gets 10×.</span></div>
<div class="rule"><b>Never past the stop</b><span>Leverage never exceeds Delta's maximum for the market, and drops if liquidation would sit within 1.25 times the stop</span></div>
<div class="rule"><b>At most 5 open</b><span>A sixth signal is skipped</span></div>
</section>
<section class="stats" aria-label="Today on the plan">
{stat("Net today",fm(net),"pos" if net>0 else "neg").replace('class="stat"','class="stat hero"')}
{stat("Flat 10× instead",fm(R["cf"][-1][1]-1000),"pos")}
{stat("As actually traded",fm(R["act"]),"pos" if R["act"]>0 else "neg")}
{stat("Trades taken",f"{len(taken)} of {len(T)}")}
{stat("Winners",f"{wins} of {len(taken)}")}
{stat("Deepest drop",f"${dd:,.2f}")}
{stat("Fees",f"${fees:,.2f}")}
{stat("Liquidations","0")}
</section>
<section class="panel"><h2>Balance through the day</h2>{svg}
<div class="legend"><span><i style="background:var(--plan)"></i>leverage by record</span><span><i style="background:var(--nocap)"></i>flat 10×</span><span><i style="background:var(--act)"></i>as actually traded</span></div></section>
<section><h2>Journal, times in IST</h2>
<div class="scroll"><table><thead><tr><th>Opened</th><th>Closed</th><th>Scanner</th><th>Market</th><th>Side</th><th class="num">Stop</th><th class="num">Price move</th><th>Exit</th><th class="plan">Its record</th><th class="num plan">Asks for</th><th class="plan">Limited by</th><th class="num plan">Leverage</th><th class="num plan">Position</th><th class="num plan">Stop would cost</th><th class="num plan">P&amp;L</th><th class="num plan">Balance</th><th class="num">As traded</th></tr></thead>
<tbody>{rows}</tbody></table></div></section>
<section><h2>Still open at {cut} IST, holding slots</h2><ul>{openrows}</ul></section>
<section><h2>How this was built</h2><ol>
<li>Each trade keeps its real fill prices, stop, exit and times. Profit and fees scale with the position, so the Scalper Offer's waived closing fee carries over.</li>
<li>The record uses only shadow trades that closed before the trade opened, so nothing from the future sets the leverage.</li><li>Leverage is capped where it would put liquidation within 1.25 times the stop distance, using each market's maintenance margin on Delta India.</li>
<li>"Stop would cost" is the loss had the trade hit its original stop, fees included.</li>
<li>A signal is skipped when 5 trades are already open, counting the account's positions that are still open now.</li>
<li>Trades opened before midnight and closed today are included.</li>
</ol></section>
</main>'''
out='/Users/scorpion/Desktop/Vela_VNEdge/_research/journal-20261018/journal-50x.html'
open(out,'w').write(page); print('ok',len(page),'net',round(net,2),'dd',round(dd,2))
