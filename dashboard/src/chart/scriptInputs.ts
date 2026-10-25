/** Pine bot overrides can use variable ids or display titles; Vela stores values by schema key. */
export function scriptInputs(schema: readonly {key: string; title: string; defval: unknown}[], overrides: Record<string, number | string | boolean> = {}) {
  return Object.fromEntries(schema.map(i => [i.key, overrides[i.key] ?? overrides[i.title] ?? i.defval]))
}
