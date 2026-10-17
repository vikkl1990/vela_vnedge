/**
 * The settings the decisions log measured, with the value it settled on and the decision that did (decision 119).
 * The Settings page shows every edited value against this; a key not listed here falls back to the code's default.
 * Keys are dotted paths into the config.
 */
export interface Measured { value: unknown; decision: number; note: string }
export const MEASURED: Record<string, Measured> = {
  'paper.minRiskFeeRatio': { value: 6, decision: 105, note: 'tested against 2, 4 and 10 on 83 cells: the stop must cover six round trips' },
  'paper.requireQuote': { value: true, decision: 105, note: 'no entry without an executable quote' },
  'paper.fallbackAtrSl': { value: 1.5, decision: 110, note: 'eight placements tried on 43 cells; none improved most cells' },
  'paper.riskPerTradePct': { value: 1, decision: 69, note: 'the risk actually taken is measured against equity at entry' },
  'paper.trailAfterR': { value: 0.5, decision: 39, note: 'the trail arms at +0.5R; stall and time exits lost' },
  'paper.trailGiveBackPct': { value: 40, decision: 39, note: 'an armed trail keeps 60% of the peak' },
  'paper.floorAtR': { value: 0.5, decision: 63, note: 'a floor banks a small gain once the trade clears +0.5R' },
  'paper.floorKeepR': { value: 0.25, decision: 63, note: 'what the floor keeps' },
  'paper.scriptDisasterStopAtr': { value: 3, decision: 113, note: 'under exit mode script, the stop when the script publishes none' },
  'paper.slippageBps': { value: 2, decision: 96, note: 'plus the measured book cost on every market leg' },
  'risk.maxPositionsTotal': { value: 8, decision: 116, note: 'the replay of the shadow book: more positions raised the drawdown faster than the return' },
  'risk.maxPositionsPerSymbol': { value: 1, decision: 116, note: 'two per market lowered R per trade in the replay' },
  'risk.maxDailyLossPct': { value: 15, decision: 65, note: 'the daily kill switch the go-live rule simulates' },
  'risk.maxWeeklyLossPct': { value: 30, decision: 65, note: 'the weekly kill switch' },
  'risk.regime.minEr': { value: 0.25, decision: 70, note: 'the one filter that paid on every test since: +0.05R to +0.17R per trade on the same cells' },
  'risk.regime.minAtrPct': { value: 0.3, decision: 66, note: 'the volatility floor' },
  'risk.marketGate.enabled': { value: true, decision: 56, note: 'turnover, book cost and quote judged every hour' },
  'risk.marketGate.minTurnoverUsd': { value: 50_000, decision: 105, note: 'lowered from 250k with the quote requirement added' },
  'risk.marketGate.maxBookCostPct': { value: 0.25, decision: 96, note: 'a round trip for the probe notional over this is a costly book' },
  'incubator.tfs': { value: ['15m', '1h', '4h'], decision: 106, note: 'the screen rotates timeframes night by night' },
  'incubator.maxShadow': { value: 250, decision: 106, note: 'raised by the operator; the stale caps free slots' },
  'incubator.promote.maxFleet': { value: 43, decision: 103, note: 'the fleet after the October rebalance' },
  'incubator.promote.maxPerWeek': { value: 2, decision: 107, note: 'five is safe under the diversity caps' },
  'incubator.promote.maxPerMarket': { value: 2, decision: 106, note: 'the fleet spreads across markets' },
  'incubator.promote.maxPerScanner': { value: 6, decision: 106, note: 'the fleet spreads across scanners' },
  'incubator.gate.minTrades': { value: 30, decision: 89, note: 'pooled per scanner × timeframe' },
  'incubator.gate.minDays': { value: 14, decision: 89, note: '' },
  'incubator.gate.minPfR': { value: 1.2, decision: 89, note: '' },
  'incubator.gate.minAvgR': { value: 0.1, decision: 89, note: '' },
  'incubator.gate.minWeeks': { value: 3, decision: 108, note: 'the positive-weeks share is asked only from three closed weeks' },
  'incubator.gate.staleDays': { value: 21, decision: 108, note: '15m; 30 on 1h and 45 on 4h' },
  'incubator.demote.silentDays': { value: 14, decision: 106, note: 'a live cell with no trade in 14 days gives its slot back' },
  'incubator.demote.marketOutDays': { value: 3, decision: 109, note: 'three days on a refused market' },
  'incubator.demote.costStarvedRefusals': { value: 5, decision: 112, note: 'five cost-rule refusals and no open in 14 days' },
  'incubator.mirror.enabled': { value: true, decision: 116, note: 'the account takes the shadow book\'s signals under its own gates' },
  'ml.minProb': { value: 0, decision: 108, note: 'the yardstick on 2,465 real trades: no threshold paid' },
}
