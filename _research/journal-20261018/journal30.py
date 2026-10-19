import json,sys,datetime as D,html
S=sys.argv[1]; R=json.load(open(S+'/recon30.json'))
ist=lambda ms:(D.datetime.fromtimestamp(ms/1000,D.UTC)+D.timedelta(hours=5,minutes=30))
fm=lambda x:('+' if x>=0 else '−')+'$'+format(abs(x),',.2f')
xs=sorted(R,key=lambda r:r['exit'])
def curve(key):
    eq=1000; pts=[(xs[0]['when'],1000)]; pk=1000; dd=0; blown=None; liq=0; fees=0; worst=0; wins=0
    for r in xs:
        v=r['actual'] if key=='actual' else r[key]['net']
        eq+=v; pts.append((r['exit'],eq)); pk=max(pk,eq); dd=max(dd,pk-eq); worst=min(worst,v); wins+=v>0
        if key!='actual': liq+=r[key]['liqd']; fees+=r[key]['fees']
        if eq<=0 and blown is None: blown=r['exit']
    return dict(pts=pts,end=eq,dd=dd,blown=blown,liq=liq,worst=worst,wins=wins,net=eq-1000,fees=fees)
C={k:curve(k) for k in ('actual','c','a')}
blown=C['a']['blown']
# chart
W,H,L,Rm,T,B=760,300,64,16,16,36
t0=min(p[0] for c in C.values() for p in c['pts']); t1=max(p[0] for c in C.values() for p in c['pts'])
ymin=min(-1400,min(p[1] for c in C.values() for p in c['pts'])); ymax=1500
X=lambda t:L+(t-t0)/(t1-t0)*(W-L-Rm); Y=lambda v:T+(ymax-v)/(ymax-ymin)*(H-T-B)
grid=''
for v in range(-1000,1501,500):
    grid+=f'<line x1="{L}" x2="{W-Rm}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" class="{"zero" if v==0 else "grid"}"/><text x="{L-8}" y="{Y(v)+4:.1f}" text-anchor="end" class="axis">{"−" if v<0 else ""}${abs(v):,}</text>'
# hour ticks every 4h IST
st=ist(t0).replace(minute=0,second=0,microsecond=0)
h=st
while h.timestamp()*1000<=t1:
    ms=(h-D.timedelta(hours=5,minutes=30)).timestamp()*1000
    if ms>=t0 and h.hour%4==0: grid+=f'<text x="{X(ms):.1f}" y="{H-12}" text-anchor="middle" class="axis">{h.strftime("%H:%M")}</text>'
    h+=D.timedelta(hours=1)
lines=''
for k,cls in (('actual','l-act'),('c','l-cap'),('a','l-30')):
    d=' '.join(f'{"M" if i==0 else "L"}{X(t):.1f},{Y(v):.1f}' for i,(t,v) in enumerate(C[k]['pts']))
    lines+=f'<path d="{d}" class="{cls}"/>'
    t,v=C[k]['pts'][-1]; lines+=f'<circle cx="{X(t):.1f}" cy="{Y(v):.1f}" r="3.5" class="{cls}-dot"/>'
if blown: lines+=f'<line x1="{X(blown):.1f}" x2="{X(blown):.1f}" y1="{T}" y2="{H-B}" class="blown"/><text x="{X(blown)+6:.1f}" y="{T+14}" class="axis blown-t">30× account gone {ist(blown).strftime("%H:%M")} IST</text>'
svg=f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="Equity through the day for the three sizings">{grid}{lines}</svg>'
# rows
rows=''
for r in sorted(R,key=lambda r:r['when']):
    after=blown is not None and r['when']>blown
    def cell(s):
        if s['liqd']: return f'<td class="num neg"><span class="chip liq">liquidated</span> {fm(s["net"])}</td>'
        return f'<td class="num {"pos" if s["net"]>0 else "neg"}">{fm(s["net"])}</td>'
    a=cell(r['a']) if not after else '<td class="num muted">account gone</td>'
    capnote=f'{r["cap"]}×' + ('' if r['cap']>=30 else '')
    reason={'trail':'trail','sl':'stop','reversal':'reversal','tp1':'target','script_exit':'script'}.get(r['reason'],r['reason'])
    rows+=(f'<tr><td class="mono">{ist(r["when"]).strftime("%H:%M")}</td><td class="mono">{ist(r["exit"]).strftime("%H:%M")}</td>'
      f'<td class="scn">{html.escape(r["scanner"])}</td><td class="mono">{r["sym"].replace("USD","")} <span class="muted">{r["tf"]}</span></td>'
      f'<td><span class="side {r["side"]}">{r["side"]}</span></td><td class="num">{r["stop"]:.2f}%</td><td class="num {"pos" if r["move"]>0 else "neg"}">{r["move"]:+.2f}%</td>'
      f'<td>{reason}</td><td class="num {"warn" if r["cap"]<30 else ""}">{capnote}</td><td class="num">{100/30-r["maint"]:.2f}%</td>{a}{cell(r["c"])}<td class="num {"pos" if r["actual"]>0 else "neg"}">{fm(r["actual"])}</td></tr>')
n=len(R); n30=sum(1 for r in R if r['cap']>=30)
def card(k,title,sub):
    c=C[k]
    return (f'<article class="card {k}"><h3>{title}</h3><p class="sub">{sub}</p><div class="big {"pos" if c["net"]>0 else "neg"}">{fm(c["net"])}</div>'
     f'<dl><dt>Balance at the end</dt><dd>{fm(c["end"]).lstrip("+")}</dd><dt>Winning trades</dt><dd>{c["wins"]} of {n}</dd>'
     f'<dt>Liquidations</dt><dd>{c["liq"] if k!="actual" else 0}</dd><dt>Deepest drop from a high</dt><dd>${c["dd"]:,.0f}</dd><dt>Worst single trade</dt><dd>{fm(c["worst"])}</dd>'
     + (f'<dt>Account gone at</dt><dd class="neg">{ist(c["blown"]).strftime("%H:%M")} IST</dd>' if c['blown'] else '') + '</dl></article>')
day=ist(min(r['when'] for r in R)).strftime('%d %b'); dayend=ist(max(r['exit'] for r in R)).strftime('%d %b %H:%M')
page=f'''<title>30× Journal Replay</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Fraunces:opsz,wght@9..144,600&display=swap">
<style>
/* layout: a trading-desk ledger; summary cards, one chart, then the full blotter in its own scroller */
:root{{--bg:#f6f7f9;--panel:#ffffff;--fg:#17202b;--muted:#5d6b7a;--line:#dfe3e9;--pos:#0f7a52;--neg:#b42318;--warn:#a15c00;--act:#5d6b7a;--cap:#1f5fbf;--x30:#b42318;
--display:"Fraunces",Georgia,serif;--body:"IBM Plex Sans",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#0f141a;--panel:#161d25;--fg:#e6ebf1;--muted:#91a0b1;--line:#27313c;--pos:#3ccf8e;--neg:#ff6b5e;--warn:#f0a43a;--act:#91a0b1;--cap:#6ea8ff;--x30:#ff6b5e;color-scheme:dark}}}}
:root[data-theme="dark"]{{--bg:#0f141a;--panel:#161d25;--fg:#e6ebf1;--muted:#91a0b1;--line:#27313c;--pos:#3ccf8e;--neg:#ff6b5e;--warn:#f0a43a;--act:#91a0b1;--cap:#6ea8ff;--x30:#ff6b5e;color-scheme:dark}}
body{{background:var(--bg);color:var(--fg);font:15px/1.5 var(--body);padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:28px 48px}}
main{{max-width:1180px;margin:0 auto;display:grid;gap:28px}}
h1{{font:600 clamp(26px,4vw,36px)/1.15 var(--display);margin:0;text-wrap:balance}}
h2{{font:600 13px/1.2 var(--body);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}}
h3{{font:600 15px/1.3 var(--body);margin:0}}
.lede{{max-width:68ch;color:var(--muted);margin:8px 0 0}}
.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}}
.card{{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px 18px;display:grid;gap:6px;align-content:start;border-top:3px solid var(--act)}}
.card.c{{border-top-color:var(--cap)}} .card.a{{border-top-color:var(--x30)}}
.sub{{margin:0;color:var(--muted);font-size:13px}}
.big{{font:500 30px/1.1 var(--mono);font-variant-numeric:tabular-nums;margin:6px 0}}
dl{{display:grid;grid-template-columns:1fr auto;gap:4px 12px;margin:0;font-size:13px}} dt{{color:var(--muted)}} dd{{margin:0;font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right}}
.pos{{color:var(--pos)}} .neg{{color:var(--neg)}} .warn{{color:var(--warn)}} .muted{{color:var(--muted)}}
.panel{{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px 18px;min-width:0}}
svg{{width:100%;height:auto;display:block}} .grid{{stroke:var(--line);stroke-width:1}} .zero{{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}}
.axis{{fill:var(--muted);font:11px var(--mono)}} path{{fill:none;stroke-width:2;stroke-linejoin:round}}
.l-act{{stroke:var(--act)}} .l-cap{{stroke:var(--cap)}} .l-30{{stroke:var(--x30)}} .l-act-dot{{fill:var(--act)}} .l-cap-dot{{fill:var(--cap)}} .l-30-dot{{fill:var(--x30)}}
.blown{{stroke:var(--x30);stroke-dasharray:4 4}} .blown-t{{fill:var(--x30)}}
.legend{{display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--muted);margin-top:8px}} .legend i{{display:inline-block;width:14px;height:3px;vertical-align:middle;margin-right:6px}}
.notes{{display:grid;gap:8px;max-width:76ch;margin:0;padding-left:18px}} .notes li{{color:var(--fg)}}
.scroll{{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel)}}
table{{border-collapse:collapse;width:100%;font-size:13px;min-width:1080px}}
th{{position:sticky;top:0;background:var(--panel);text-align:left;font-weight:600;color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase;padding:10px 10px;border-bottom:1px solid var(--line);white-space:nowrap}}
td{{padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap}} tr:last-child td{{border-bottom:0}}
.num{{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}} th.num{{text-align:right}} .mono{{font-family:var(--mono)}}
.scn{{max-width:260px;overflow:hidden;text-overflow:ellipsis}}
.side{{font:500 11px var(--mono);text-transform:uppercase;letter-spacing:.05em}} .side.long{{color:var(--pos)}} .side.short{{color:var(--neg)}}
.chip.liq{{font:600 10px var(--body);text-transform:uppercase;letter-spacing:.06em;border:1px solid var(--neg);border-radius:4px;padding:1px 5px;margin-right:4px}}
th.grp-a{{color:var(--x30)}} th.grp-c{{color:var(--cap)}}
</style>
<main>
<header><h1>Today's account trades at $100 margin</h1>
<p class="lede">The account's {n} trades closed between {day} 00:00 IST and {dayend} IST, replayed with the same entries, exits and times. Only the size changes: $100 of margin per trade at 30×, which is $3,000 per position, against the same $100 at the most Delta India allows on each market, and against what was actually traded at 1% risk.</p></header>
<section class="cards" aria-label="Totals">
{card("a","$100 at 30× on every trade","$3,000 per position, liquidation 0.83% away on most markets")}
{card("c","$100 at Delta's maximum","30× where allowed, 20× on most alts, 10× on a few")}
{card("actual","As traded","1% of equity at risk at the stop, about $9.40 a trade")}
</section>
<section class="panel"><h2>Balance through the day, from $1,000</h2>{svg}
<div class="legend"><span><i style="background:var(--x30)"></i>$100 at 30×</span><span><i style="background:var(--cap)"></i>$100 at Delta's maximum</span><span><i style="background:var(--act)"></i>as traded</span></div></section>
<section><h2>What decides it</h2><ol class="notes">
<li>Delta India allows 30× on only {n30} of today's {n} trades' markets. Most alts stop at 20×, with a 2.5% maintenance margin.</li>
<li>At 30× on a 2.5% maintenance market, liquidation sits 0.83% from the entry. Today's stops sat a median 1.48% away, so every stop-out is liquidated first, and so is any winner that dipped 0.83% before it turned.</li>
<li>At 20× the same market liquidates 2.5% away. Only the three trades with stops wider than that are liquidated.</li>
<li>Up to 8 positions were open at once, which is $800 of margin on a $1,000 account.</li>
<li>Today was a winning day for these signals: 49 of 71 trades won. On a day with the usual share of stop-outs, the larger size loses about $40 per stop at 20×, instead of about $9.40.</li>
</ol></section>
<section><h2>Journal, {n} trades, times in IST</h2>
<div class="scroll"><table><thead><tr><th>Opened</th><th>Closed</th><th>Scanner</th><th>Market</th><th>Side</th><th class="num">Stop</th><th class="num">Price move</th><th>Exit</th><th class="num">Delta max</th><th class="num">30× liq. at</th><th class="num grp-a">$100 at 30×</th><th class="num grp-c">$100 at max</th><th class="num">As traded</th></tr></thead>
<tbody>{rows}</tbody></table></div></section>
<section><h2>How this was built</h2><ol class="notes">
<li>Each trade keeps its real fill prices, stop, exit and times. Profit and fees scale with the position size, so the Scalper Offer's waived closing fee carries over.</li>
<li>A trade counts as liquidated when its recorded worst point crossed the liquidation price, which is 1 ÷ leverage minus the market's maintenance margin. A liquidation loses the full $100 margin plus the opening fee.</li>
<li>The worst point comes from 1-minute prices, so a wick inside a minute can be missed. The liquidation counts are a floor.</li>
<li>After the 30× balance reaches zero, its later trades are marked "account gone".</li>
</ol></section>
</main>'''
open(S+'/journal-30x.html','w').write(page); print('ok', len(page))
