/**
 * The go-live rule, evaluated (decision 65). Going live had been a feeling; this makes it a set of
 * conditions the dashboard can show green or red, each with the number behind it:
 *
 *   trades      enough closed account trades to judge (the band needs them)
 *   expectancy  the lower 90% bound of E[R] after costs is above zero
 *   survival    a block-bootstrap Monte Carlo of the journal's R series through the fleet's own halt
 *               rules (daily loss, max loss) over 30 days breaches rarely enough
 *   drawdown    the simulated 95th-percentile drawdown stays inside the alert line
 *   halts       no halt was tripped in the window
 *   alerts      someone would hear a halt
 *
 * The simulation is the same idea as LuxAlgo's Prop Firm Sim (stationary block bootstrap of the
 * trader's own R series through an explicit ruleset), written here so the check runs inside the
 * bot with no network. Pure and deterministic: the same inputs and seed give the same numbers.
 */
export interface GoLiveInputs {
  rs: number[];                 // R per closed account trade, in exit order
  tradesPerDay: number;
  riskPct: number;              // risk per trade as % of balance
  dailyLossPct: number;         // the fleet's daily halt
  maxLossPct: number;           // the fleet's max loss (weekly halt used as the floor)
  drawdownAlertPct: number;     // the alert line
  lb90: number | null;          // lower band of E[R] after costs
  haltsInWindow: number;
  alertsConfigured: boolean;
  days?: number; paths?: number; seed?: number; minTrades?: number; maxBreachPct?: number; maxRiskPct?: number;
}
export interface GoLiveCheck { key: string; label: string; ok: boolean; value: string; need: string }
export interface GoLiveVerdict { ok: boolean; checks: GoLiveCheck[]; sim: { paths: number; days: number; breachPct: number; dailyBreachPct: number; maxLossBreachPct: number; dd50Pct: number; dd95Pct: number; medianEndPct: number } | null }

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Stationary block bootstrap of the R series through the halt rules; returns per-path outcomes. */
export function simulateSurvival(rs: number[], o: { tradesPerDay: number; riskPct: number; dailyLossPct: number; maxLossPct: number; days: number; paths: number; seed: number; blockLen?: number }) {
  const n = rs.length; const block = o.blockLen ?? 5; const rand = rng(o.seed);
  const out = { breach: 0, daily: 0, maxLoss: 0, dds: [] as number[], ends: [] as number[] };
  for (let p = 0; p < o.paths; p++) {
    let eq = 1, peak = 1, dd = 0, dead = false; let idx = Math.floor(rand() * n), left = 0;
    for (let d = 0; d < o.days && !dead; d++) {
      const dayStart = eq; const trades = Math.max(0, Math.round(o.tradesPerDay + (rand() - 0.5) * 2 * Math.sqrt(o.tradesPerDay)));
      for (let t = 0; t < trades; t++) {
        if (left <= 0) { idx = Math.floor(rand() * n); left = 1 + Math.floor(-Math.log(1 - rand()) * block); }
        const r = rs[idx % n]; idx++; left--;
        eq += eq * (o.riskPct / 100) * r;
        peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
        if (eq <= dayStart * (1 - o.dailyLossPct / 100)) { out.daily++; dead = true; break; }
        if (eq <= 1 - o.maxLossPct / 100) { out.maxLoss++; dead = true; break; }
      }
    }
    if (dead) out.breach++;
    out.dds.push(dd); out.ends.push(eq - 1);
  }
  const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  return { breachPct: out.breach / o.paths * 100, dailyBreachPct: out.daily / o.paths * 100, maxLossBreachPct: out.maxLoss / o.paths * 100, dd50Pct: q(out.dds, 0.5) * 100, dd95Pct: q(out.dds, 0.95) * 100, medianEndPct: q(out.ends, 0.5) * 100 };
}

export function goLive(inp: GoLiveInputs): GoLiveVerdict {
  const minTrades = inp.minTrades ?? 200, maxBreach = inp.maxBreachPct ?? 10, days = inp.days ?? 30, paths = inp.paths ?? 2000;
  const sim = inp.rs.length >= 10 ? { paths, days, ...simulateSurvival(inp.rs, { tradesPerDay: inp.tradesPerDay, riskPct: inp.riskPct, dailyLossPct: inp.dailyLossPct, maxLossPct: inp.maxLossPct, days, paths, seed: inp.seed ?? 42 }) } : null;
  const checks: GoLiveCheck[] = [
    { key: 'trades', label: 'Closed account trades', ok: inp.rs.length >= minTrades, value: String(inp.rs.length), need: `≥ ${minTrades}` },
    { key: 'risk', label: 'Risk per trade actually taken (% of equity)', ok: inp.riskPct <= (inp.maxRiskPct ?? 1.5), value: `${inp.riskPct.toFixed(2)}%`, need: `≤ ${inp.maxRiskPct ?? 1.5}%` },
    { key: 'expectancy', label: 'Lower 90% bound of E[R] after costs', ok: inp.lb90 !== null && inp.lb90 > 0, value: inp.lb90 === null ? 'no band yet' : `${inp.lb90 >= 0 ? '+' : ''}${inp.lb90.toFixed(3)}R`, need: '> 0' },
    { key: 'survival', label: `P(halt within ${days} days), block bootstrap of the journal`, ok: sim !== null && sim.breachPct <= maxBreach, value: sim ? `${sim.breachPct.toFixed(1)}%` : 'under 10 trades', need: `≤ ${maxBreach}%` },
    { key: 'drawdown', label: `Simulated 95th-percentile drawdown in ${days} days`, ok: sim !== null && sim.dd95Pct <= inp.drawdownAlertPct, value: sim ? `${sim.dd95Pct.toFixed(1)}%` : '–', need: `≤ ${inp.drawdownAlertPct}%` },
    { key: 'halts', label: 'Halts tripped in the window', ok: inp.haltsInWindow === 0, value: String(inp.haltsInWindow), need: '0' },
    { key: 'alerts', label: 'Alert channel configured', ok: inp.alertsConfigured, value: inp.alertsConfigured ? 'yes' : 'no', need: 'yes' },
  ];
  return { ok: checks.every(c => c.ok), checks, sim };
}
