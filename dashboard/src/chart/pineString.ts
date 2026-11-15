/** A Pine string literal, including quotes. Labels must never become executable source. */
export function pineString(value: string): string {
  return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
}
