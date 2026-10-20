/**
 * Decision 153: the Library's taxonomy. LuxAlgo's 17 families (the LuxAlgo Library's own), assigned from its catalogue
 * for LuxAlgo scripts and from the script's name for everyone else's; a script the name cannot place is "other".
 */
import fs from 'node:fs';
import path from 'node:path';
import { SCRIPTS_DIR } from '../config.ts';

export const FAMILIES: Array<{ key: string; label: string }> = [
  { key: 'trend', label: 'Trend' }, { key: 'momentum', label: 'Momentum' }, { key: 'volatility', label: 'Volatility' },
  { key: 'volume-orderflow', label: 'Volume & Flow' }, { key: 'market-structure', label: 'Structure' }, { key: 'smc-ict', label: 'SMC / ICT' },
  { key: 'wyckoff', label: 'Wyckoff' }, { key: 'elliott-harmonics', label: 'Elliott & Harmonics' }, { key: 'patterns', label: 'Patterns' },
  { key: 'levels', label: 'Levels' }, { key: 'statistics', label: 'Statistics' }, { key: 'machine-learning', label: 'Machine Learning' },
  { key: 'time-seasonality', label: 'Time & Sessions' }, { key: 'sentiment-breadth', label: 'Sentiment & Breadth' }, { key: 'risk-exits', label: 'Risk & Exits' },
  { key: 'meta-composition', label: 'Meta' }, { key: 'validation', label: 'Validation' }, { key: 'other', label: 'Other' },
];
const KEYS = new Set(FAMILIES.map(f => f.key));

/** Name rules for scripts outside the LuxAlgo catalogue, most specific first. */
const RULES: Array<[RegExp, string]> = [
  [/\b(ml|machine learning|ai|neural|knn|lorentzian|classifier|classification|k-?means|clustering|predict\w*|logistic|bayes\w*|svm|random forest|gradient boost)\b/i, 'machine-learning'],
  [/smart money|equal (high|low)|\b(eqh|eql|smc|ict|order ?blocks?|ob|fvg|ifvg|fair value|liquidity|sweeps?|bos|choch|mss|breakers?|mitigation|killzones?|silver bullet|premium|discount|imbalance|displacement|po3|amd|cisd|inducement)\b/i, 'smc-ict'],
  [/\b(wyckoff|spring|upthrust|accumulation|distribution)\b/i, 'wyckoff'],
  [/\b(elliott|harmonics?|abcd|gartley|butterfly|cypher|shark|wave count)\b/i, 'elliott-harmonics'],
  [/\b(patterns?|candlesticks?|engulfing|doji|hammer|harami|triangles?|wedges?|flags?|pennants?|head and shoulders|double (top|bottom)|wolfe|cup|candles?|candle sticks|reversals?|inside (bar|day)|outside bar|three (white|black))\b/i, 'patterns'],
  [/\b(backtest\w*|tester|validation|walk.?forward|monte carlo)\b/i, 'validation'],
  [/\b(stop.?loss|trailing stop|take.?profit|tp.?sl|risk|position siz\w*|exits?|chandelier)\b/i, 'risk-exits'],
  [/\b(sector rotation|performance comparison|sentiment|breadth|fear|greed|funding|open interest|long.?short|dominance|heatmap|correlat\w*)\b/i, 'sentiment-breadth'],
  [/\b(buy day|sessions?|seasonal\w*|almanac|day of week|asia|asian|london|new york|hourly|calendar|opening range|orb|time)\b/i, 'time-seasonality'],
  [/point of control|\b(whale\w*|liquidations?|institutional|activity|pressure|volumatic|volume|vol|obv|cvd|delta|footprint|order ?flow|profile|poc|money flow|mfi|vwap)\b/i, 'volume-orderflow'],
  [/\b(volatility|atr|bollinger|keltner|squeeze|bands?|deviation|range)\b/i, 'volatility'],
  [/\b(support|resistance|s\/r|levels?|pivots?|fibonacci|fib|zones?|anchored)\b/i, 'levels'],
  [/\b(structure|swings?|zigzag|breakouts?|breakdowns?|trend ?lines?|channels?|higher highs?)\b/i, 'market-structure'],
  [/\b(ehlers|spectrum|decomposition|statistic\w*|probability|z.?score|forecast\w*|spectral|markov|regimes?|dispersion|returns|monotonic\w*|regression|mean reversion|percentile|entropy|hurst|cycles?|kalman|filter|fourier)\b/i, 'statistics'],
  [/\b(screener|dashboard|table|calculator|widget|gifs?|portfolio|optimizer|confluence|composite|combo|toolkit|all.?in.?one)\b/i, 'meta-composition'],
  [/\b(rsi|macd|stoch\w*|momentum|oscillator|cci|roc|williams|tsi|awesome|fisher|wavetrend|divergence)\b/i, 'momentum'],
  [/trend|trail|\b(average|cloud|ribbons?|gann)\b/i, 'trend'],
  [/\b(trend\w*|ema|sma|wma|moving averages?|ma|supertrend|hull|ichimoku|adx|dmi|parabolic|sar|ribbon|cross\w*|alligator|kama|t3|tema|dema|zlema)\b/i, 'trend'],
];

let lux: { bySlug: Record<string, string>; byName: Record<string, string> } | null = null;
function luxMap() {
  if (lux) return lux;
  try { lux = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'luxalgo-families.json'), 'utf8')); } catch { lux = { bySlug: {}, byName: {} }; }
  return lux!;
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The family for one manifest row: its own `family`, LuxAlgo's catalogue, then the name rules. */
export function familyFor(m: { name: string; author?: string | null; url?: string | null; family?: string | null }): string {
  if (m.family && KEYS.has(m.family)) return m.family;
  const map = luxMap();
  const slug = m.url?.match(/luxalgo\.com\/library\/indicator\/([^/]+)/)?.[1];
  if (slug && map.bySlug[slug]) return map.bySlug[slug];
  if ((m.author ?? '').toLowerCase() === 'luxalgo' && map.byName[norm(m.name)]) return map.byName[norm(m.name)];
  for (const [re, fam] of RULES) if (re.test(m.name)) return fam;
  return 'other';
}

/** Where a script came from, by its URL. */
export function originOf(url: string | null | undefined): 'luxalgo' | 'tradingview' | 'other' {
  if (!url) return 'other';
  return /luxalgo\.com/.test(url) ? 'luxalgo' : /tradingview\.com/.test(url) ? 'tradingview' : 'other';
}
