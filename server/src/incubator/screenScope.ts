/** Explicit scanner/market requests must test watch-list cells too. This changes
 * screening coverage only: recordScreen keeps tracked cells outside admission. */
export function screenScope(options: {
  shadowOnly: boolean;
  rescreenStages: Set<string>;
  explicitCells: boolean;
}) {
  const skipStages = new Set(options.shadowOnly
    ? ['live', 'demote_proposed', 'tracked', 'candidate', 'retired', 'shadow', 'proposed']
      .filter(stage => !options.rescreenStages.has(stage))
    : ['live', 'demote_proposed', 'shadow', 'proposed', ...(options.explicitCells ? [] : ['tracked'])]);
  return {
    skipStages,
    // The rolling three-market probe belongs to broad library discovery. A
    // bounded request must not silently drop its remaining markets after silence.
    silentProbeLimit: options.shadowOnly || options.explicitCells ? Infinity : 3,
  };
}
