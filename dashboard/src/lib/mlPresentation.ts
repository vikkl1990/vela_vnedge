export interface MlSettings {
  minProb: number
  useAsScore: boolean
}

/** These are independent engine switches, not AUC-driven promotion tiers. */
export function mlState(config?: MlSettings | null) {
  if (!config || !Number.isFinite(config.minProb) || typeof config.useAsScore !== 'boolean') {
    return {
      label: 'Unknown',
      gate: null,
      score: null,
      detail: 'ML settings have not loaded; no claim is made about gating or scoring.',
    }
  }
  const gate = config.minProb > 0,
    score = config.useAsScore
  const label = gate ? (score ? 'Gate + score' : 'Gate only') : score ? 'Score only' : 'Advisory only'
  const gateText = gate
    ? `Saved entry predictions below ${(config.minProb * 100).toFixed(1)}% are refused when a prediction is available.`
    : 'The ML probability gate is off.'
  const scoreText = score
    ? 'ML supplies the score only when the scanner has no score of its own; sizing still follows the configured policy and risk caps.'
    : 'ML does not replace the scanner score. Other entry gates and risk sizing still apply.'
  return { label, gate, score, detail: `${gateText} ${scoreText}` }
}

/** A ranking statistic alone never certifies a profitable gate or permission to size up. */
export function aucEvidence(auc?: number | null) {
  if (auc == null || !Number.isFinite(auc)) return 'No held-out ranking result reported.'
  return auc <= 0.5
    ? 'No positive ranking separation in this test sample. Net-profit validation is separate.'
    : 'Ranking separation in this test sample; it does not establish a profitable gate or sizing rule.'
}
