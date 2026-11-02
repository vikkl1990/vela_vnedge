import { TF_SECONDS, pineTfToDelta } from '../config.ts';

/** Fixed-duration, bounded requests shared by the diagnostics and Pine endpoints. */
export function flowQuery(params: URLSearchParams, now = Date.now()) {
  const symbol = (params.get('symbol') ?? 'BTCUSD').replace(/^delta:/i, '').toUpperCase();
  if (!/^[A-Z0-9]{2,24}USD$/.test(symbol)) throw new Error('Use a Delta USD perpetual symbol');
  const rawTf = params.get('tf') ?? '1m';
  const tf = TF_SECONDS[rawTf] ? rawTf : pineTfToDelta(rawTf) ?? rawTf;
  const duration = (TF_SECONDS[tf] ?? 0) * 1000;
  if (!duration || duration < 60000 || duration > 86400000) throw new Error('Order flow supports 1m through 1d');
  const num = (name: string, fallback: number) => {
    const raw = params.get(name); if (raw === null) return fallback;
    const value = Number(raw); if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}`);
    return value;
  };
  const limit = Math.max(1, Math.min(500, Math.floor(num('limit', 120))));
  const to = Math.min(now, num('to', now));
  const from = Math.max(0, to - 3 * 86400000, Math.floor(num('from', to - limit * duration) / duration) * duration);
  if (from > to) throw new Error('from must precede to');
  return { symbol, tf, duration, from, to, limit };
}
