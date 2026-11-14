/** Runtime transport, not the saved mode name, decides whether orders can reach production. */
export function liveStatus(status?: { mode: string; host: string | null; dryRun: boolean; hasKeys: boolean } | null) {
  if (!status) return { armed: false, label: 'Unknown', detail: 'Execution status is unavailable. Check Exchange before relying on the displayed account mode.' }
  if (status.mode === 'paper' && status.host === null) return { armed: false, label: 'Off', detail: 'The bot runs in paper mode and submits no exchange orders. Existing exchange exposure is checked separately on Exchange.' }
  if (status.dryRun) return { armed: false, label: 'Dry run', detail: `Order submission is disabled; the runtime uses the ${status.host ?? 'unknown'} host for observation.` }
  if (status.host === 'testnet') return { armed: false, label: 'Testnet', detail: 'The runtime is connected to testnet, not the production exchange.' }
  if (status.host === 'production' && status.hasKeys) return { armed: true, label: 'Armed', detail: 'The runtime can submit production orders. Entry gates and risk controls still apply; this does not prove any strategy has traded live.' }
  return { armed: false, label: 'Unknown', detail: 'The runtime did not report a recognized, authenticated execution transport. Check Exchange.' }
}
