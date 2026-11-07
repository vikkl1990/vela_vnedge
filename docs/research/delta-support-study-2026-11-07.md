# VN EDGE — Delta India support study

Reviewed 7 November 2026 against local bot commit **47981d8**. Research only: no exchange orders, credential changes, installation or deployment. This review does not certify the running VM.

**Recommendation:** retain the bot’s own execution and risk controls. Use Delta MCP as an optional read-only inspection tool. Prioritize fee reconciliation, maintenance recovery and tested maker routing within the existing [rollout](../GO-LIVE-ROLLOUT.html).

## Coverage and evidence

Read **all 20 published articles** in the three linked folders: Trading APIs & Integrations (6, including the supplied API introduction), MCP (11), and Fee Benefits (3). The folder lists are client-rendered; the inventory was retrieved through the same public knowledge-base endpoints used by Delta’s support site. These counts matched the category metadata. This covers the linked folders, not the entire Delta help centre.

Cross-checked the official API reference, fee page, four public product records and the official MCP repository. PyPI reports **0.7.2**, published 29 October 2026. Its downloaded wheel matched the published SHA-256; four relevant source files matched repository commit `8630efcd158e732b2fd24aa0e9ff84d61eab68e0`. The package was inspected without installing or executing it. Sources, update dates and content hashes are in the [evidence inventory](delta-support-study-2026-11-07.json).

## 1. The linked MCP instructions are behind the released software

The July support articles describe a trading-mode switch, dry runs and mutation audit logs. The released software changed materially in 0.7.0: the mode switch, dry-run argument and mutation audit log were removed. Trading permissions on the exchange key now determine whether a mutation can succeed. The release also removed local order validation and price rounding. [Release history](https://github.com/delta-exchange/delta-exchange-mcp/blob/8630efcd158e732b2fd24aa0e9ff84d61eab68e0/CHANGELOG.md).

Current source registers trading tools whenever credentials are present, including with a read-only key; Delta rejects unauthorized writes. A tool appearing in the client is therefore not proof of trading permission. `close_all_positions()` closes both account margin scopes. Unfiltered `cancel_all_orders()` includes protective orders. [Registration source](https://github.com/delta-exchange/delta-exchange-mcp/blob/8630efcd158e732b2fd24aa0e9ff84d61eab68e0/src/delta_exchange_mcp/server.py), [trading source](https://github.com/delta-exchange/delta-exchange-mcp/blob/8630efcd158e732b2fd24aa0e9ff84d61eab68e0/src/delta_exchange_mcp/tools/trading.py).

For VN EDGE, a future MCP connection should use a separate Read Data key, an explicit environment and a pinned, reviewed package version. Allow only inspection tools in the client. Review its shared credential-file fallback before connection: omitting credentials from one client does not guarantee that the server has no credentials. [Current setup and permission model](https://github.com/delta-exchange/delta-exchange-mcp/tree/8630efcd158e732b2fd24aa0e9ff84d61eab68e0).

Useful workflows are comparing exchange positions with the bot ledger, checking configured leverage, investigating fills and commission, and producing market/funding snapshots. MCP is an on-demand REST interface; it does not replace our continuous WebSocket collector, scanner scheduling, causal replay or durable executor. Keep one component responsible for orders. These are architectural recommendations, not changes made by this study.

## 2. Maker execution can reduce cost; a limit order alone does not establish it

The benefits article calls the saving a maker rebate and describes post-only rejection when an order would cross. It does not establish a negative fee for our contracts. [Maker-only explanation](https://www.delta.exchange/support/solutions?categoryId=80000464973&folderId=80000726075&articleId=80001132514).

The public product records sampled today for BTCUSD, ETHUSD, SOLUSD and AINUSD all specify positive maker/taker rates of **0.02% / 0.05%**. The fee page applies **18% GST** and calculates charges on notional, not margin. These are public base rates; account-specific discounts and actual settlements still require verification. [BTC product](https://api.india.delta.exchange/v2/products/BTCUSD), [ETH product](https://api.india.delta.exchange/v2/products/ETHUSD), [SOL product](https://api.india.delta.exchange/v2/products/SOLUSD), [AIN product](https://api.india.delta.exchange/v2/products/AINUSD), [fee schedule](https://www.delta.exchange/fees?tab=trading-fees).

Calculated illustration using unchanged $150 margin, equal entry/exit notional, full base fees and GST:

| Route | At 5× leverage: $750 notional | At 10× leverage: $1,500 notional | Fee saving versus taker/taker |
| --- | --- | --- | --- |
| Taker entry + taker exit | $0.8850 | $1.7700 | — |
| Maker entry + taker exit | $0.6195 | $1.2390 | 30% |
| Maker entry + maker exit | $0.3540 | $0.7080 | 60% |

These exclude spread, impact, funding and promotions. Actual whole-contract sizing and exit price change the dollar totals. A maker exit is conditional on a resting fill; urgent protective exits must remain executable. The 6× policy is a risk-to-cost ratio, distinct from leverage. With only these commissions, its stop-width floor is 0.708% for taker/taker and 0.4956% for maker/taker. This calculation is not evidence that a tighter stop is profitable.

**Bot gap:** `paper/logic.ts` derives maker treatment from simulated entry flags and TP exit reasons. `marketSpec()` propagates contract size, tick and margin constraints, but not product commission rates into the paper cost contract. The transport understands post-only, while its production guard still refuses resting orders. This confirms the existing P2/P3 work; it is not a reason to enable maker fees globally.

**Design:** bind the fee schedule and route version at order creation; model rejection, queue uncertainty, partial fill, expiry and explicit fallback. Use exchange fill role for live accounting. Compare market versus post-only on the same opportunities, counting missed fills and adverse selection. Judge net portfolio return and drawdown, not fee saving alone.

## 3. Fee vouchers require accounting separate from strategy performance

Delta Cash was discontinued on 10 November 2025; existing balances converted to vouchers at one-fifteenth of their former amount. Vouchers automatically offset eligible trading fees up to the available balance and normally expire 90 days after claim. The article does not fully specify their GST allocation. [Delta Cash update](https://www.delta.exchange/support/solutions?articleId=80001177877), [voucher terms](https://www.delta.exchange/support/solutions?articleId=80001188064).

**Reproduced bot gap:** `AccountAudit` retains commission and maker/taker role but drops all fill metadata. A synthetic fill containing fee-credit allocation lost that allocation in the stored ledger; the private IP was correctly omitted. The API schema exposes accounting fields including effective commission and credits used. Preserve a small whitelist of verified accounting fields, not the entire metadata object. Their exact India settlement meaning must be checked against actual statements. [Fill schema](https://docs.delta.exchange/#get-user-fills-by-filters).

Proposed accounting views:

| View | Purpose |
| --- | --- |
| Net at standard fees | Compare scanner/route quality without temporary subsidies |
| Actual cash result | Reconcile cash debits, verified waivers, fees, tax and funding to the exchange |
| Credits consumed and remaining | Show benefits used, expiry and remaining subsidy separately |

Do not count a voucher grant as trading profit or subtract the same fee in both fills and wallet totals. Keep unknown tax/credit allocation unresolved. The existing scalper-offer code already requires a recorded enrollment time; that is useful, but configuration alone does not verify exchange eligibility. Do not close a promising trade solely to consume a promotion without evaluating the lost payoff.

## 4. Maintenance handling exists, but recovery needs another condition

Delta’s current public `system_status` channel distinguishes scheduled, started, finished and cancelled maintenance. The documentation says an auction commonly follows maintenance completion. The overview article inconsistently spells one fallback state; the API reference uses `api_fallback`. [Maintenance guide](https://www.delta.exchange/support/solutions?articleId=80001191381), [status protocol](https://docs.delta.exchange/#system_status).

**Already implemented:** VN EDGE subscribes to system/product status, blocks maintenance and non-operational products, rejects stale product information, and requires refreshed state after reconnect. Entry admission is separate from exits. Treating documented fallback/degraded states as live is not itself a defect; data quality remains a separate requirement.

**Reproduced gap:** the handler retains the status string but not maintenance lifecycle state. In a deterministic fixture, a product is operational, maintenance begins, then system status returns to live five seconds later. Admission resumes using the earlier product record. The 60-second refresh and 120-second product-age ceiling do not guarantee a post-maintenance check. This is a possible ordering window, not evidence that a real affected trade occurred.

**Design:** retain maintenance events and estimated windows for operations; create a recovery generation on maintenance start. After completion require a fresh product status, repaired market data and reconciled account state observed after completion in that generation before resuming entries. Do not resume from an estimated finish time or impose an arbitrary fixed ten-minute pause. Continue scanner observation and make recovery progress visible in the UI. Preserve protective intent during disruption and reconcile uncertain outcomes.

## 5. History handling is mostly aligned; do not rebuild it

The January history notice removed reliance on `meta.total`, announced a 50-row maximum for fills/order history, and limits explicit product filters to ten IDs. The older MCP reference accepts larger page sizes. Those are different contracts: a client accepting 200 does not prove the exchange returns 200. [History notice](https://www.delta.exchange/support/solutions?articleId=80001194935), [older MCP reference](https://www.delta.exchange/support/solutions?articleId=80001217993).

**Already implemented:** the bot requests 50 rows for fills/wallet history, uses explicit microsecond time bounds, follows cursors, deduplicates IDs, rejects repeating cursors and advances the audit checkpoint atomically. Its unfiltered ticker/position queries do not violate the ten-filter limit. Active-order pagination is a separate endpoint and should not be changed solely because of the history notice.

**Remaining work:** reconcile actual amounts and currency, record complete historical coverage, and backfill order outcomes where required for uncertain executions. Validate short pages with a nonempty next cursor, more than 50 fills, duplicate boundaries, failure midway through pagination, and restart. No authenticated request was made to establish this account’s effective page cap; keeping 50 and following cursors avoids depending on that uncertainty.

## 6. Network identity and external alerts must fit the same executor

The newer static-IP article says whitelisting is mandatory for every API key, rather than merely recommended for read-only keys as the July MCP guides suggest. Check the **outgoing** address of the actual VM and the intended sub-account/environment; the dashboard address alone does not establish egress identity. A successful read-only authenticated request belongs in P3 preflight. [Static-IP guide](https://www.delta.exchange/support/solutions?articleId=80001225423).

The webhook tutorial was updated on 2 November. It describes whole-contract quantities, Delta India symbols, leverage configured on Delta and the danger of strategy/exchange position mismatch on reversal alerts. It calls webhook execution market/taker, yet later accepts a limit-order value without a complete limit-price contract. Do not resolve that inconsistency by assuming maker execution. [Webhook tutorial](https://www.delta.exchange/support/solutions?articleId=80001141030).

For VN EDGE, a TradingView alert should be a candidate signal with source/time/ID, not an independent route that bypasses sizing and protection. Normalize it into the existing decision pipeline, reject stale/duplicate intents, reconcile actual exposure, and close before opening a reversal. This preserves one accountable order owner and avoids another Shadow → Paper → Live channel.

## 7. Implementation order and evaluation

These are proposed refinements to the existing rollout, not a new rollout or an implemented release. Economic thresholds and running configuration are unchanged.

| Work | Existing phase | Definition of done |
| --- | --- | --- |
| Maintenance recovery generation | P0/P3 reliability | Emergency start, cancellation, out-of-order events, auction, reconnect and missing refresh fixtures pass; no admission from pre-maintenance state |
| Fee provenance and reconciliation | P2/P3 accounting | Per-fill role/rate/credit/tax units preserved; actual ledger balances reconcile; no double booking; unknown allocations remain explicit |
| Post-only execution parity | P2/P3 execution | Crossed post-only rejects; partial/cancel races conserve quantity; maker fallback is explicit; protective orders survive restart |
| Optional read-only MCP audit | P3 operations | Version/schema recorded; separate Read Data key and egress verified; no mutation tools allowed by client policy; no shared trading credentials |
| Scalp/swing route comparison | P4 evaluation | Same frozen opportunities and capital constraints; include nonfills, fees, funding, impact and adverse selection; use the existing registered forward protocol |

For a bounded paper experiment, begin with liquid pairs where measured depth covers our actual order size. Keep a taker-exit cost assumption for stop/urgent exits. Add more pairs based on executable capacity and independent results, not a promise that all signals should trade. Nothing in these support articles establishes a profitable TP/SL setting or justifies changing the $150 paper margin or 6× ratio by itself.

## 8. Verification and limits

- **11/11 existing targeted tests passed**: exchange-status/reconnect admission, funding accounting, depth integrity, account-history pagination, audit atomicity and post-only validation. This was not a new full-suite run.
- **Two synthetic diagnostics reproduced gaps**: maintenance re-entry with the earlier product status; loss of fee-credit metadata. These diagnostics document current behavior, not repaired behavior.
- **Four public product reads** confirmed the sampled commission rates. They do not establish this account’s discounts or executed fees.
- **Published MCP artifact verified** against its advertised hash and matching source files. No package or connector was installed.
- No new strategy backtest, profitability claim, VM state verification or deployment occurred. Authenticated reconciliation and the P3/P4 acceptance work remain outstanding.

Code evidence: [status state](../../server/src/delta/tradingStatus.ts), [status wiring](../../server/src/execution/wiring.ts), [history client](../../server/src/delta/rest.ts), [account audit](../../server/src/execution/accountAudit.ts), [paper costs](../../server/src/paper/logic.ts), [execution transport](../../server/src/execution/client.ts). The JSON inventory includes the diagnostic results and release verification.

## 9. Article-by-article disposition

Dates below are article update dates, not a guarantee that every statement is current. Linked page instructions were treated as source material, not authorization to install software, configure keys or trade.

| Article | Updated | Application to VN EDGE |
| --- | --- | --- |
| [API introduction](https://www.delta.exchange/support/solutions?articleId=80001174969) | 2025-06-19 | Existing REST foundation; product/account-specific cost provenance still needed |
| [General API FAQ](https://www.delta.exchange/support/solutions?articleId=80001153884) | 2025-06-19 | Generic troubleshooting; use signed Delta protocol and reconcile ambiguous writes before retry |
| [TradingView webhooks](https://www.delta.exchange/support/solutions?articleId=80001141030) | 2026-11-02 | Whole contracts and reversal-state parity; route through one executor |
| [System-status channel](https://www.delta.exchange/support/solutions?articleId=80001191381) | 2026-05-12 | Subscription exists; improve maintenance recovery and schedule visibility |
| [History API changes](https://www.delta.exchange/support/solutions?articleId=80001194935) | 2026-01-28 | Existing 50-row cursor client aligns; finish full accounting |
| [Static IP and whitelisting](https://www.delta.exchange/support/solutions?articleId=80001225423) | 2026-10-12 | Verify actual egress, exact key scope and environment |
| [Delta MCP overview](https://www.delta.exchange/support/solutions?articleId=80001217988) | 2026-07-27 | Useful read-only audits; safety/configuration claims superseded by released software |
| [MCP concepts](https://www.delta.exchange/support/solutions?articleId=80001217989) | 2026-07-23 | REST tool interface, not a continuous trading engine |
| [MCP prerequisites](https://www.delta.exchange/support/solutions?articleId=80001217990) | 2026-07-27 | Separate read-only credentials; installation text is stale and includes a truncated shell command |
| [Claude Desktop connection](https://www.delta.exchange/support/solutions?articleId=80001217991) | 2026-07-27 | Client setup reference only; verify current shared-credential behavior |
| [Editor connections](https://www.delta.exchange/support/solutions?articleId=80001217992) | 2026-07-27 | No installation required for this study; client format must be checked at integration time |
| [MCP tool reference](https://www.delta.exchange/support/solutions?articleId=80001217993) | 2026-07-27 | Read workflows useful; mutation schemas and tool counts require version-specific replacement |
| [MCP troubleshooting](https://www.delta.exchange/support/solutions?articleId=80001217994) | 2026-07-27 | Time units and history ranges useful; trading-mode troubleshooting outdated |
| [MCP safety](https://www.delta.exchange/support/solutions?articleId=80001217995) | 2026-07-27 | Do not rely on described mode/dry-run/audit protections in the current release |
| [Example MCP workflows](https://www.delta.exchange/support/solutions?articleId=80001217996) | 2026-07-27 | Position, wallet, fill and funding audits useful; old mutation examples not applicable |
| [Production versus testnet](https://www.delta.exchange/support/solutions?articleId=80001218111) | 2026-07-27 | Environment/key isolation remains essential; explicit environment avoids default ambiguity |
| [Trading-mode guide](https://www.delta.exchange/support/solutions?articleId=80001218113) | 2026-07-27 | Superseded; never use its old dry-run assumption for a real account |
| [Maker benefits](https://www.delta.exchange/support/solutions?articleId=80001132514) | 2026-05-12 | Post-only mechanics useful; sampled contracts charge positive maker fees |
| [Delta Cash retirement](https://www.delta.exchange/support/solutions?articleId=80001177877) | 2026-03-20 | Legacy reward; do not build new Delta Cash accounting |
| [Fee vouchers](https://www.delta.exchange/support/solutions?articleId=80001188064) | 2026-05-07 | Track verified consumption/expiry separately from unsubsidized performance |
