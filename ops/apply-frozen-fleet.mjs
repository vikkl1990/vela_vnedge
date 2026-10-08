#!/usr/bin/env node
// Merge ops/frozen-fleet.config.json into data/config.json.
// Stored config wins over defaults, so editing server defaults does not change a running bot.
// Telegram tokens and other keys are left alone. scanners is replaced, not merged.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const overlayPath = path.join(root, 'ops', 'frozen-fleet.config.json');
const configPath = process.env.VNEDGE_CONFIG || path.join(root, 'data', 'config.json');
const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
const current = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

const next = merge(current, overlay);
next.scanners = {};
next.timeframes = ['1h'];
next.symbols = ['BTCUSD', 'ETHUSD'];
fs.mkdirSync(path.dirname(configPath), { recursive: true });
const tmp = `${configPath}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
fs.renameSync(tmp, configPath);
console.log(`wrote ${configPath}`);
console.log('scanners cleared, symbols BTCUSD/ETHUSD, timeframe 1h, execution paper');
console.log('restart the server, then POST /api/risk/kill so a stale in-memory fleet cannot open');
