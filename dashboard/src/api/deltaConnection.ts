export type DeltaEnvironment = 'production' | 'testnet'
export interface DeltaConnectionStatus {
  configured: boolean
  environment: DeltaEnvironment | null
  savedAt: number | null
  check: { ok: boolean; at: number; latencyMs: number; message: string } | null
}
