/** Decision changes can arrive after the scanner event: a resting fill, expiry or cancellation. */
export function decisionRefreshKeys(event: string, type?: string): string[][] {
  if (!['signal', 'order', 'pending', 'trade', 'position'].includes(event)) return []
  if (event === 'position' && type === 'updated') return []
  return [
    ['signals'],
    ['signal-activity'],
    ['decision-trace'],
    ['scanner-pipeline'],
    ['scanners'],
    ['incubator'],
    ['radar'],
    ['gates'],
  ]
}
