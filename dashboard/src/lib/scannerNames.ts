/** Identify name collisions, not duplicate evidence. A scanner can occur in many cells. */
export function ambiguousScannerNames(rows: { id: string; name: string }[]): Set<string> {
  const ids = new Map<string, Set<string>>()
  for (const row of rows) {
    const members = ids.get(row.name) ?? new Set<string>()
    members.add(row.id)
    ids.set(row.name, members)
  }
  return new Set([...ids].filter(([, members]) => members.size > 1).map(([name]) => name))
}
