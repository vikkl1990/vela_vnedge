/** Assign a display category to a scanner by name keywords. */

export const CATEGORIES = [
  'All',
  'Trend',
  'Breakout',
  'Liquidity/SMC',
  'Volume Profile',
  'Momentum',
  'Structure/Fib',
  'Other',
] as const
export type Category = (typeof CATEGORIES)[number]

const RULES: [Category, RegExp][] = [
  ['Liquidity/SMC', /liquidity|smart money|smc|sweep|ict|session|amd|po3|mirage|pools/i],
  ['Volume Profile', /volume profile|vwap|volume-weighted|volume weighted/i],
  ['Breakout', /breakout|squeeze|trap|sniper|targets/i],
  ['Structure/Fib', /fib|fibonacci|structure|harmonic|abcd|elliott|pivot|s-r|s&r|support|channels|zones/i],
  ['Momentum', /momentum|rsi|macd|oscillator|classifier|spectral|radar|forecast/i],
  ['Trend', /trend|trail|supertrend|ichimoku|cloud|flow|meridian|synapse|nexus|fusion|almanac/i],
]

export function categorize(name: string): Category {
  for (const [cat, re] of RULES) if (re.test(name)) return cat
  return 'Other'
}
