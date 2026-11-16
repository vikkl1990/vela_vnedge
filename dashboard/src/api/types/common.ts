/**
 * Types mirroring docs/API.md (VNEdge server contract).
 * Time values are epoch milliseconds unless the field name ends in `Sec`.
 */

export type Side = 'long' | 'short'
export type Timeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '1d'
export type ScannerStatus = 'ok' | 'incompatible' | 'unavailable'
export type ExitMode = 'levels' | 'script' | 'both'
export type SignalKind = 'entry' | 'exit' | 'info'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogScope = 'feed' | 'scanner' | 'paper' | 'api' | string
