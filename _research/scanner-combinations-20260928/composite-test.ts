/** Research-only test of the four composite strategies proposed in the 28 Sep report, as specified there. */
import fs from 'node:fs';
import { DeltaRest } from '/Users/scorpion/Desktop/Vela_VNEdge/server/src/delta/rest.ts';
import { PinePool } from '/Users/scorpion/Desktop/Vela_VNEdge/server/src/pine/pool.ts';
import { ScannerRegistry } from '/Users/scorpion/Desktop/Vela_VNEdge/server/src/scanners/registry.ts';
import { ConfigStore, TF_SECONDS } from '/Users/scorpion/Desktop/Vela_VNEdge/server/src/config.ts';
import { runBacktest } from '/Users/scorpion/Desktop/Vela_VNEdge/server/src/paper/backtest.ts';
import type { Bar } from '/Users/scorpion/Desktop/Vela_VNEdge/server/src/data/candleStore.ts';

const S = '/private/tmp/claude-501/-Users-scorpion-Desktop-Vela-VNEdge/141a6943-1b95-4d1a-a133-4b46245901e5/scratchpad';
const MARKETS = (process.env.MARKETS ?? 'ETHUSD,BTCUSD,SOLUSD').split(',');
const rest = new DeltaRest();
const reg = new ScannerRegistry();
const pool = new PinePool(3, 120000);
const cfg = new ConfigStore().get();
Object.assign(cfg.paper, JSON.parse(fs.readFileSync(`${S}/paper-vm.json`, 'utf8')));
const FEE = 0.118 / 100, SLIP = 2 / 1e4;
const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
const atr14 = (b: Bar[]) => { const out: number[] = []; let a = NaN; for (let i = 0; i < b.length; i++) { const tr = i ? Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close)) : b[i].high - b[i].low; a = i < 14 ? (i ? (a * i + tr) / (i + 1) : tr) : (a * 13 + tr) / 14; out.push(a); } return out; };
const src = (id: string, add = '') => { const s = reg.all().find((x: any) => x.id === id); if (!s) throw new Error('no script ' + id); return (s.patched ?? s.source) + add; };
async function run(id: string, add: string, symbol: string, tf: string, bars: Bar[], tick: number) {
  const r = await pool.run({ scannerId: id, source: src(id, add), symbol, tf, tickSize: tick, bars, tailBars: 'all', plotTail: bars.length } as any);
  if (!r.ok) throw new Error(`${id} ${tf} failed: ${r.error}`);
  return r;
}
const series = (r: any, title: string, bars: Bar[]) => { const p = r.plots.find((x: any) => x.title === title); if (!p) throw new Error(`no plot ${title} in ${r.title}: ${r.plots.map((x: any) => x.title).join(',')}`); const m = new Map(p.data.map((d: any) => [d.time, d.value])); return bars.map(b => (m.get(b.time) as number | null) ?? NaN); };
interface Sig { i: number; side: 1 | -1; stop: number; target?: number | 'r2'; maxBars: number; exitOnRegimeFlip?: boolean; label: string }
interface Trade { entryAt: number; side: 1 | -1; R: number; bars: number; exit: string }
/** Fill at the next bar's open, stop first when both lie in one bar, fees and slippage in R. */
function simulate(bars: Bar[], sigs: Sig[], trendingAt?: boolean[]): Trade[] {
  const out: Trade[] = []; let busyUntil = -1;
  for (const s of sigs.sort((a, b) => a.i - b.i)) {
    const i0 = s.i + 1; if (i0 >= bars.length || i0 <= busyUntil) continue;
    const entry = bars[i0].open * (1 + s.side * SLIP); const risk = Math.abs(entry - s.stop); if (!(risk > 0)) continue;
    if ((entry - s.stop) * s.side <= 0) continue; // stop on the wrong side after the gap → reject
    const target = s.target === 'r2' ? entry + s.side * 2 * risk : s.target; if (target !== undefined && (target - entry) * s.side <= 0) continue;
    let R = NaN, exit = 'time', j = i0;
    for (; j < Math.min(bars.length, i0 + s.maxBars); j++) {
      const x = bars[j];
      const hitS = s.side > 0 ? x.low <= s.stop : x.high >= s.stop;
      const hitT = target !== undefined && (s.side > 0 ? x.high >= target : x.low <= target);
      if (hitS) { R = -1; exit = 'stop'; break; }
      if (hitT) { R = (target! - entry) * s.side / risk; exit = 'target'; break; }
      if (s.exitOnRegimeFlip && trendingAt && trendingAt[j] && j + 1 < bars.length) { R = (bars[j + 1].open * (1 - s.side * SLIP) - entry) * s.side / risk; exit = 'regime'; j++; break; }
    }
    if (!Number.isFinite(R)) { const k = Math.min(j, bars.length - 1); R = (bars[k].close * (1 - s.side * SLIP) - entry) * s.side / risk; }
    R -= FEE * entry / risk; busyUntil = j;
    out.push({ entryAt: bars[i0].time, side: s.side, R, bars: j - i0 + 1, exit });
  }
  return out;
}
const stat = (t: Trade[], split: number) => { const R = (x: Trade[]) => x.length ? x.reduce((a, y) => a + y.R, 0) / x.length : NaN; const h1 = t.filter(x => x.entryAt < split), h2 = t.filter(x => x.entryAt >= split); return { n: t.length, r: R(t), win: t.length ? t.filter(x => x.R > 0).length / t.length : NaN, n1: h1.length, r1: R(h1), n2: h2.length, r2: R(h2), sum: t.reduce((a, y) => a + y.R, 0), stops: t.filter(x => x.exit === 'stop').length, long: t.filter(x => x.side > 0).length } };
const fmt = (name: string, s: ReturnType<typeof stat>) => `${name.padEnd(46)} n=${String(s.n).padStart(3)} E[R]=${(s.r >= 0 ? '+' : '') + s.r.toFixed(3)} win ${(s.win * 100).toFixed(0).padStart(3)}% stops ${String(s.stops).padStart(3)} ΣR=${s.sum.toFixed(1).padStart(6)} | halves ${s.n1}/${(s.r1 >= 0 ? '+' : '') + s.r1.toFixed(3)} ${s.n2}/${(s.r2 >= 0 ? '+' : '') + s.r2.toFixed(3)} | longs ${s.long}`;
const lines: string[] = [];
const say = (s: string) => { console.log(s); lines.push(s); };
try {
  for (const symbol of MARKETS) {
    const p = await rest.product(symbol); const tick = Number(p?.tick_size ?? 0.01), cv = Number(p?.contract_value ?? 0.001);
    const b15 = toBars(await rest.recentCandles(symbol, '15m', 8000, TF_SECONDS['15m']));
    const b1h = toBars(await rest.recentCandles(symbol, '1h', 3000, TF_SECONDS['1h']));
    say(`\n=== ${symbol}: 15m ${b15.length} bars (${new Date(b15[0].time).toISOString().slice(0, 10)} → ${new Date(b15.at(-1)!.time).toISOString().slice(0, 10)}), 1h ${b1h.length} bars (${new Date(b1h[0].time).toISOString().slice(0, 10)} →)`);
    const a15 = atr14(b15), a1h = atr14(b1h);
    const [zl, dyn, sq, hv, mre, ro, lsf] = await Promise.all([
      run('zero-lag-trend-signals-mtf', '\nplot(trend, "AUDIT_TREND")\n', symbol, '1h', b1h, tick),
      run('dynamic-trend-bands-anchored-vwap-signals', '', symbol, '15m', b15, tick),
      run('squeeze-index', '', symbol, '1h', b1h, tick),
      run('high-volume-breakout-targets', '\nplot(bullish_breakout_signal ? 1 : bearish_breakout_signal ? -1 : 0, "AUDIT_BREAKOUT")\n', symbol, '1h', b1h, tick),
      run('market-regime-engine', '\nplot(er, "AUDIT_ER")\nplot(trending ? dir : 0, "AUDIT_REGIME")\n', symbol, '1h', b1h, tick),
      run('range-oscillator-zeiierman', '\nplot(ma, "AUDIT_MA")\n', symbol, '1h', b1h, tick),
      run('liquidity-sweep-filter', '', symbol, '1h', b1h, tick),
    ]);
    const trend1h = series(zl, 'AUDIT_TREND', b1h), psi = series(sq, 'PSI', b1h), brk = series(hv, 'AUDIT_BREAKOUT', b1h), er = series(mre, 'AUDIT_ER', b1h), regime = series(mre, 'AUDIT_REGIME', b1h), osc = series(ro, 'Range Oscillator', b1h), ma = series(ro, 'AUDIT_MA', b1h);
    const shapeTimes = (r: any, title: string) => new Set<number>((r.shapes.find((s: any) => s.title === title)?.times ?? []) as number[]);
    const up15 = shapeTimes(dyn, 'Break Up Triangle'), dn15 = shapeTimes(dyn, 'Break Dn Triangle');
    const sweeps = (title: string) => new Set<number>([...shapeTimes(lsf, title), ...lsf.alerts.filter((a: any) => a.type === 'alertcondition' && a.title === title).map((a: any) => a.time)]);
    const bullSweep = sweeps('Bullish Sweep'), bearSweep = sweeps('Bearish Sweep'); // the script draws sweeps as shapes; its alertconditions do not surface in this runtime
    say(`  components: zero-lag trend ±1 on ${trend1h.filter(v => v === 1 || v === -1).length} bars · dynamic breaks up ${up15.size} dn ${dn15.size} · PSI>80 on ${psi.filter(v => v > 80).length} bars · HV breakouts ${brk.filter(v => v).length} · ER<0.35 on ${er.filter(v => v < 0.35).length} bars · osc |≥100| on ${osc.filter(v => Math.abs(v) >= 100).length} · sweeps ${bullSweep.size}/${bearSweep.size}`);
    const split15 = b15[Math.floor(b15.length / 2)].time, split1h = b1h[Math.floor(b1h.length / 2)].time;
    // S1: 1h zero-lag state (last 1h bar closed before the 15m bar closes) gates a 15m Dynamic break
    const t1h = b1h.map(b => b.time);
    const lastClosed1h = (t15close: number) => { let lo = 0, hi = t1h.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (t1h[m] + 3_600_000 <= t15close) { k = m; lo = m + 1; } else hi = m - 1; } return k; };
    const s1: Sig[] = [];
    for (let j = 20; j < b15.length - 1; j++) {
      const t = b15[j].time, side: 1 | -1 | 0 = up15.has(t) ? 1 : dn15.has(t) ? -1 : 0; if (!side) continue;
      const k = lastClosed1h(t + 900_000); if (k < 0 || trend1h[k] !== side) continue;
      s1.push({ i: j, side, stop: b15[j].close - side * 1.5 * a15[j], target: 'r2', maxBars: 24, label: 'S1' });
    }
    // fix: stop from the actual entry, not the signal close
    const s1e = s1.map(s => ({ ...s, stop: b15[s.i + 1] ? b15[s.i + 1].open - s.side * 1.5 * a15[s.i] : s.stop }));
    say(fmt('S1 trend continuation (15m, 1h gate)', stat(simulate(b15, s1e), split15)));
    say(fmt('   S1 ungated: every Dynamic break', stat(simulate(b15, [...up15, ...dn15].filter(t => t < b15.at(-1)!.time).map(t => { const j = b15.findIndex(b => b.time === t); const side: 1 | -1 = up15.has(t) ? 1 : -1; return { i: j, side, stop: (b15[j + 1]?.open ?? b15[j].close) - side * 1.5 * a15[j], target: 'r2' as const, maxBars: 24, label: 'S1u' }; }).filter(s => s.i >= 20)), split15)));
    // S2: PSI>80 arms; cross below opens a 3-bar window; HV breakout + relvol ≥ 1.2 in the window
    const vol20 = b1h.map((_, i) => i >= 20 ? b1h.slice(i - 20, i).reduce((a, x) => a + x.volume, 0) / 20 : NaN);
    const s2: Sig[] = []; let windowUntil = -1, armed = false;
    for (let i = 20; i < b1h.length - 1; i++) {
      if (psi[i] > 80) { armed = true; windowUntil = -1; }
      else if (armed && psi[i - 1] > 80 && psi[i] <= 80) { windowUntil = i + 2; armed = false; }
      if (i <= windowUntil && brk[i] && b1h[i].volume / vol20[i] >= 1.2) { const side = brk[i] as 1 | -1; s2.push({ i, side, stop: b1h[i + 1].open - side * 1.5 * a1h[i], target: 'r2', maxBars: 24, label: 'S2' }); windowUntil = -1; }
    }
    say(fmt('S2 compression-release breakout (1h)', stat(simulate(b1h, s2), split1h)));
    say(fmt('   S2 ungated: every HV breakout', stat(simulate(b1h, b1h.map((_, i) => i).filter(i => i >= 20 && i < b1h.length - 1 && brk[i]).map(i => { const side = brk[i] as 1 | -1; return { i, side, stop: b1h[i + 1].open - side * 1.5 * a1h[i], target: 'r2' as const, maxBars: 24, label: 'S2u' }; })), split1h)));
    // S3: sweep in a ranging regime with a stretched oscillator, reclaimed within two bars (level ≈ prior 20-bar valley/peak — the script does not export it)
    const s3: Sig[] = [];
    for (let i = 21; i < b1h.length - 2; i++) {
      const t = b1h[i].time; const side: 1 | -1 | 0 = bullSweep.has(t) ? 1 : bearSweep.has(t) ? -1 : 0; if (!side || !(er[i] < 0.35)) continue;
      if (side > 0 ? !(osc[i] <= -100) : !(osc[i] >= 100)) continue;
      const level = side > 0 ? Math.min(...b1h.slice(i - 20, i).map(x => x.low)) : Math.max(...b1h.slice(i - 20, i).map(x => x.high));
      const extreme = side > 0 ? b1h[i].low : b1h[i].high;
      for (let k = i; k <= i + 1; k++) { if (!(er[k] < 0.35)) break; if ((b1h[k].close - level) * side > 0) { s3.push({ i: k, side, stop: extreme - side * 0.1 * a1h[k], target: 'r2', maxBars: 12, label: 'S3' }); break; } }
    }
    say(fmt('S3 liquidity sweep and reclaim (1h)', stat(simulate(b1h, s3), split1h)));
    say(fmt('   S3 ungated: every sweep, next open', stat(simulate(b1h, b1h.map((_, i) => i).filter(i => i >= 21 && i < b1h.length - 1 && (bullSweep.has(b1h[i].time) || bearSweep.has(b1h[i].time))).map(i => { const side: 1 | -1 = bullSweep.has(b1h[i].time) ? 1 : -1; return { i, side, stop: (side > 0 ? b1h[i].low : b1h[i].high) - side * 0.1 * a1h[i], target: 'r2' as const, maxBars: 12, label: 'S3u' }; })), split1h)));
    // S4: ranging regime, oscillator beyond ±100 arms, crossing back within 3 bars triggers; target = weighted mean at trigger; exit on regime change or 12 bars
    const s4: Sig[] = []; const trendingAt = regime.map(v => v !== 0);
    for (let i = 20; i < b1h.length - 1; i++) {
      for (const side of [1, -1] as const) {
        const stretched = side > 0 ? osc[i] <= -100 : osc[i] >= 100; if (!stretched || !(er[i] < 0.35)) continue;
        let ext = side > 0 ? b1h[i].low : b1h[i].high;
        for (let k = i + 1; k <= Math.min(i + 3, b1h.length - 2); k++) {
          ext = side > 0 ? Math.min(ext, b1h[k].low) : Math.max(ext, b1h[k].high);
          const back = side > 0 ? osc[k] > -100 && osc[k - 1] <= -100 : osc[k] < 100 && osc[k - 1] >= 100;
          if (back) { if (er[k] < 0.35 && Number.isFinite(ma[k])) s4.push({ i: k, side, stop: ext - side * 0.1 * a1h[k], target: ma[k], maxBars: 12, exitOnRegimeFlip: true, label: 'S4' }); break; }
          if (side > 0 ? osc[k] > -100 : osc[k] < 100) break;
        }
      }
    }
    const dedup = [...new Map(s4.map(s => [`${s.i}:${s.side}`, s])).values()];
    say(fmt('S4 range return to value (1h)', stat(simulate(b1h, dedup, trendingAt), split1h)));
    // the same S1/S2 entries under the fleet's own exit model (VM paper settings)
    const ev = (bars: Bar[], sigs: Sig[], id: string) => sigs.map(s => ({ kind: 'entry' as const, side: s.side > 0 ? 'long' as const : 'short' as const, tp: [], label: id, message: id, source: 'derived' as const, barTime: bars[s.i].time, barIndex: s.i }));
    for (const [name, bars, sigs] of [['S1', b15, s1e], ['S2', b1h, s2], ['S3', b1h, s3], ['S4', b1h, dedup]] as const) {
      const r = runBacktest({ scannerId: name, scannerName: name, symbol, tf: bars === b15 ? '15m' : '1h', bars, events: ev(bars, sigs as Sig[], name), cfg: cfg.paper, exitMode: 'both', contractValue: cv, tickSize: tick });
      const t = (r.trades as any[]).map(x => ({ entryAt: x.entryAt, side: (x.side === 'long' ? 1 : -1) as 1 | -1, R: x.rMultiple ?? 0, bars: 0, exit: x.exitReason ?? '' }));
      say(fmt(`   ${name} under the fleet's exit model (ATR stop, lock, trail)`, { ...stat(t, bars === b15 ? split15 : split1h), stops: t.filter(x => x.exit === 'sl').length }));
    }
  }
} finally { await pool.stop(); }
fs.writeFileSync(`${S}/composite-results-2.txt`, lines.join('\n'));
