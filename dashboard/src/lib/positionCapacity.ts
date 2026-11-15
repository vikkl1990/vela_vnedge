/** The tighter enabled account count ceiling. Zero disables that ceiling only. */
export function accountPositionLimit(engine: number, risk: number, riskEnabled = true): number | null {
  const limits = [engine, ...(riskEnabled ? [risk] : [])].filter((n) => Number.isFinite(n) && n > 0)
  return limits.length ? Math.min(...limits) : null
}
