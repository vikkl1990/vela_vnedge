// Freeze the parallel list from the ranked candidates plus the VM's view of each cell (stage, manifest, quarantine, copy-signal rejections).
// Rules, in order: shadow stage only (tracked cells are handled by start-judging-tracked); the script is in the manifest and not
// quarantined; fewer than 30% of the cell's account copy signals died at the fee gate or the market gate (only judged with >= 10);
// at most 2 cells per scanner and 2 per market; the 12 with the highest expected next-week excess.
import fs from 'node:fs';
const D = new URL('.', import.meta.url).pathname;
const cands = JSON.parse(fs.readFileSync(process.argv[2] ?? D + 'cands-vm.json', 'utf8'));
const MAX = 12, PER_SCANNER = 2, PER_MARKET = 2;
const picked = [], excluded = [];
const perScanner = new Map(), perMarket = new Map();
for (const c of cands) {
  const why = [];
  if (c.stage !== 'shadow') why.push(`stage is ${c.stage}, not shadow`);
  if (c.quarantined) why.push('the script is quarantined');
  if (c.inManifest === false) why.push('not in the script manifest');
  if (c.copySignals14d >= 10 && c.tightShare >= 0.3) why.push(`${Math.round(c.tightShare * 100)}% of its account copy signals die at the fee gate (stop too tight)`);
  if (c.copySignals14d >= 10 && c.marketShare >= 0.3) why.push(`${Math.round(c.marketShare * 100)}% of its account copy signals die at the market gate`);
  if (!why.length && picked.length >= MAX) why.push('the list is full');
  if (!why.length && (perScanner.get(c.scannerId) ?? 0) >= PER_SCANNER) why.push(`scanner already has ${PER_SCANNER} cells`);
  if (!why.length && (perMarket.get(c.symbol) ?? 0) >= PER_MARKET) why.push(`market already has ${PER_MARKET} cells`);
  if (why.length) { excluded.push({ scannerId: c.scannerId, symbol: c.symbol, tf: c.tf, reasons: why }); continue; }
  picked.push(c);
  perScanner.set(c.scannerId, (perScanner.get(c.scannerId) ?? 0) + 1);
  perMarket.set(c.symbol, (perMarket.get(c.symbol) ?? 0) + 1);
}
const out = {
  id: 'fleet-b',
  createdAt: '2026-11-21',
  note: 'A parallel scanner list for the paper account, chosen from 28 days of shadow results by excess R after shrinking toward zero. See README.md.',
  persistenceSlope: 0.13,
  cells: picked.map((c) => ({ scannerId: c.scannerId, symbol: c.symbol, tf: c.tf, name: c.name, shadow28d: { trades: c.n28, rawR: c.rawR, excessR: c.excess, expectedNextExcessR: c.expected, longShare: c.longShare }, copy14d: { signals: c.copySignals14d, opened: c.copiesOpened } })),
  excluded,
};
console.log(JSON.stringify(out, null, 2));
