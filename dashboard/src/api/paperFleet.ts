/** Decision 323: what the paper account is made of. `own` is the account's own scanner list at full size; `copy` is a shadow cell's signal taken at the pilot size. */
export type FleetSource = 'own' | 'copy' | 'unknown'
export interface PaperFleet {
  at: number
  own: { scanners: number; pairs: number }
  ownCells: Array<{ scannerId: string; symbol: string; tf: string }>
  /** Enabled and visible, but with nothing allocated: switched on, runs nothing. */
  idle: string[]
  window: {
    days: number
    entries: { own: number; copy: number; unknown: number; total: number }
    ownScanners: number
    copyScanners: number
  }
  copy: { enabled: boolean; sizeScale: number | null; minTrades: number | null; minNetR: number | null }
}
