# The system, step by step

The single point of truth for what the bot does. Three documents, three jobs, and they do not overlap:

| document | answers | maintained by |
|---|---|---|
| **`SYSTEM.md`** (this file) | what the bot does, in order, and which decision proves each rule | edited by hand when a rule changes, in the same commit as the code |
| [`STATE.md`](STATE.md) | what is true on the machine right now — fleet, settings, trades, incubator | generated: `npm run state`, never edited |
| [`DECISIONS.md`](DECISIONS.md) | why each rule is what it is, including everything tested and rejected | appended to, never rewritten |

If this file and the running machine disagree, the machine is right and this file is a bug. If this
file and a number quoted in chat disagree, this file is right. `ARCHITECTURE.md` describes the
modules; this describes the behaviour.

**The machine that counts is the VM** (`/opt/vnedge`, systemd, starts at boot). The Mac is the
workshop: it holds the research tooling and is where code is changed and tested (decision 1).

---

## The pipeline

A trade passes through twelve steps. Each one below states the rule in force, where it lives, and
what established it.

### 1. Candles arrive

Delta Exchange India over REST for history and websocket for live (`delta/rest.ts`, `delta/ws.ts`).
`CandleStore` merges them and emits each closed bar exactly once, which is the only event that starts
a scan. Marks, funding and the trade tape arrive on their own channels into `MarkStore`.

Quotes carry two clocks — when we received them and the exchange's own timestamp — and anything more
than 2 s apart is treated as stale rather than trusted (audit finding, decision 18).

### 2. A scanner runs

Each enabled scanner × market × timeframe runs its Pine source on the closed bars, inside a worker
thread, through PineTS (`pine/pool.ts`, `pine/worker.ts`). Workers are capped at 1536 MB of heap and
the service at a `MemoryMax`, because one runaway script froze the whole VM once (decision 22). Live
scans jump the queue ahead of research jobs.

Scripts written as `strategy()` are read from their own order ledger rather than from alert text
(decision 23).

### 3. The signal is extracted

`scanners/extractor.ts` turns alerts, plotshapes and the strategy ledger into one event: side, price,
and whatever stop and targets the script itself drew. A signal older than **300 s** is dropped rather
than chased.

### 4. Levels are resolved

Whatever the script supplies is used. Where it supplies nothing:

- **stop** — 1.5 × ATR(14), from the last *closed* bar only, never a forming one.
- **targets** — 2R / 4R / 6R.

Stops drawn by scripts were tested as a replacement for the ATR fallback and are worse, so the
fallback stands (decision 25). Closer targets were tested twice and are worse (decisions 24, 26).

### 5. Risk decides whether to take it

`risk/manager.ts`: daily and weekly kill switches, a manual halt, position caps, per-scanner budget,
cooldown, drawdown-scaled sizing and a BTC-beta exposure cap. Then one cost test: the stop must be at
least **4 × the round-trip fee**, or the trade is not worth taking (decision 21).

### 6. It is sized

Quality-weighted, risking **1% of equity** per trade, with the stop distance capped at **2%** so a
wide stop cannot quietly buy a large position. Size is shrunk further if the book cannot absorb it.

### 7. It fills

Live fills come from the tape where available and 1m candles otherwise, crossing the quoted spread,
plus 2 bps of slippage. The fill's own timestamp is what starts the Scalper Offer clock (step 9), not
the signal's.

### 8. It is managed — the exit policy

This is the part that decides the money, and it is resolved on **1m candles**, not on the signal's
15m bar. Measuring exits on the signal bar flattered the trail badly — profit factor 1.21 became 1.06
when the same trades were replayed minute by minute (decision 13). Every exit claim in this repo that
predates that is void.

In order:

| | rule |
|---|---|
| **stop** | −1R, or the level the script drew |
| **floor** | at **+1R** the stop moves to **+0.5R** and never comes back down |
| **trail** | from **+1.5R**, keep **60%** of the best price reached |
| **ceiling** | +6R closes what is left |
| **reversal** | an opposite signal on the same market closes the position |

Three things were tested against this and rejected: partial profit at TP1 (decision 9), volatility
trailing stops (decision 7), and exiting when a profitable trade turns flat or reverses — which looked
like a +9% improvement until a bug in my own lab was fixed, after which it loses money (decision 27).
An EMA-based trend exit is implemented and **off**; leave it off unless something new justifies it.

### 9. It is charged

0.05% taker on notional, **plus 18% GST** on the fee — which was missing until decision 14 and cost
the measured fleet 12% when added. Funding is charged per 8 h slot.

**Delta's Scalper Offer** is modelled: the closing fee is waived inside 30 minutes on BTC and ETH and
15 minutes elsewhere, partial closes included, liquidations and PAXG/SLVON/XAUT excluded. It is
modelled because it is real money; it is **not** chased — trading to land inside the window was tested
and is worse than ignoring it (decision 20).

All P&L shown anywhere in this system is **net** of all of the above.

### 10. It is recorded

SQLite (`node:sqlite`, WAL). `positions.bt` says which book a trade belongs to: **0 = live paper**,
**2 = the incubator's shadow book**. They never mix.

### 11. Nothing is sent to an exchange

`execution.mode` is `paper`. Mirroring to the demo host stays off until two audit findings are
implemented: fills must be authoritative from the exchange, and brackets must be persistent and
verified (decision 18). Production is double-locked behind `allowProduction: true` *and* `DELTA_LIVE=1`,
and even then only market orders with reduce-only exits.

### 12. New pairs are grown, not guessed

The incubator (decision 17) is the only route into the fleet:

```
2,588 scripts ──daily screen (a slice each night)──► candidate
   candidate ──shadow book, 100 slots, paper-traded on bt=2──► proven?
   proven ──proposed to you──► you approve ──► live fleet
   live ──last 50 trades below PF 0.9──► demotion proposed
```

**The gate judges a scanner, not a market** (decision 29). Evidence is pooled across every market a
scanner runs on one timeframe — its cohort — and the cohort passes or fails together:

| | requirement |
|---|---|
| sample | ≥30 pooled trades over ≥14 days |
| quality | profit factor ≥1.2, ≥0.1R per trade, ≥60% of weeks positive |
| breadth | ≥50% of the markets with enough trades to judge are net positive |
| originality | ≤50% of entries overlapping a live pair |
| clock | retired unproven after 45 days on 15m, 60 on 1h, 90 on 4h |

Cohort size follows how often a timeframe trades — 5 markets on 15m, 8 on 1h, 12 on 4h — so a pooled
sample lands in roughly 8, 14 and 39 days respectively. Only the best markets of a passing cohort are
proposed, at most 2 a week, and nothing is promoted without your click. See `STATE.md` for today's
numbers.

---

## What is actually established

Honest separation, after the lab bug in decision 27 forced a re-audit (decision 28):

**Established by evidence I have re-verified:**
- exits must be measured on 1m; bar-level results overstate the trail (13)
- wide targets do not cost anything — 21% of trades reach 6R and the trail, not the target, is what
  ends most trades (24, 26)
- closer targets, partial profits, plot-derived stops, volatility trails and reversal-on-flat all
  lose money against the current policy (7, 9, 24, 25, 27)
- costs are about 0.15R per trade, and GST is a material part of that (14)

**Believed, not established:**
- that the current six-pair fleet is better than the ten it replaced. It was chosen on backtests after
  the bug fix, and as of today the six current pairs have taken **zero** live trades between them —
  the four closed trades in the paper account all belong to pairs that were cut.
- that 15m is the right timeframe. Decision 10 says so on the old fleet; decision 23's 626-script
  survey says the edge is on 1h and 4h. These contradict each other and it is unresolved.

**Not known:**
- whether any of this makes money forward. The live paper record is days old and tiny. The
  pre-committed review is at 100 live trades (decision 4) and nothing should be re-tuned before it.

---

## Open items, in priority order

1. **Incubator page** should show cohort progress and the real time to a verdict (the gate itself is fixed — decision 29).
2. **Alerting** — the Telegram token is still unset, so a halt or a crash is silent (decision 5).
3. **Audit findings 2, 3, 11, 12** — the first two block exchange mirroring.
4. **The Mac bot** runs a different 33-pair fleet than the VM's 6. Two records, one of them noise: mirror it or stop it.
5. **`liquidity-trail-matrix`** fails every run with an array-bounds error and sat in the live fleet doing nothing.
6. **The 100-trade review**, when the trades exist.

## The rules of this repo

- The VM is the record; when the two disagree, the VM is right (decision 1).
- Configuration is frozen until the live sample exists; the review is pre-committed so a bad week
  cannot rewrite it (decisions 3, 4).
- Nothing enters the fleet except through the incubator, and nothing is promoted without approval.
- Every rule change lands in the same commit as its decision entry, and updates this file.
- Never real production keys; the bot binds to 127.0.0.1 only; the Telegram token lives in the
  systemd environment and never in `config.json`.
