# Dashboard architecture correction — 15 November 2026

The dashboard had overlapping component APIs, unbounded signal tables, a button per market, local financial formatters and independent refresh timers. This release consolidates their presentation without changing server execution, admission, promotion, sizing or risk configuration.

## Implemented

- Removed `components/ui.tsx`. The shared kit now owns page headers, sections, statistics, empty/error/loading states, filters, book badges and confirmation dialogs. Filters use pressed buttons; only actual tab panels use tab roles.
- Book badges use the canonical `Book` definition. Execution modes remain explicit, and historical account aggregates are labelled Account rather than being silently reclassified as live money.
- The shared table sorts the full result before paging, clamps pages when results shrink, resets on sort/filter changes, has loading and empty states, and can use explicit virtualization. Desktop signals render 25 rows per page; phone signals render at most 10 cards with secondary prices and messages behind an accessible disclosure. Grouped signals use one inspector. Open trades and hypothetical-exit trials use the same table.
- Replaced hundreds of trade-health buttons with a keyboard-operated heatmap, 48 pairs per page and one selected-pair inspector. Every pair remains searchable and reachable; advisory results stay separate from trading controls.
- Consolidated primary navigation to 12 destinations. Strategies, Signals, Performance, Research and Settings have child-view navigation. Old URLs redirect, preserving query strings, scanner IDs and anchors. Keyboard shortcuts and the command palette still reach individual views.
- Moved financial formatters into `lib/format.ts`, with a lint rule against new local money/percentage/R wrappers. Missing accounting observations remain distinct from measured zero. Negative values use the same sign conventions.
- Added named live/normal/slow refresh cadences, plus longer metadata/study cadences. SSE updates and invalidation drive appropriate caches; polling remains available after missed events. Continuous event bursts can no longer postpone invalidation indefinitely.
- Replaced scanner bulk `confirm()` with the shared dialog. Cancellation sends no requests. Mobile action menus now stay usable after browser-initiated scrolling, re-anchor when the page scrolls and allow scrolling within the menu.
- Raised small data text through shared typography tokens, made phone controls touch-sized, centralized remaining CSS color literals and canvas/theme colors, removed obsolete KPI/title style rules, and replaced static scanner spacing styles with classes. Runtime dimensions, chart geometry and calculated widths deliberately remain dynamic.
- Split the large API type file into domain modules and extracted scanner cards and fleet-summary logic. Compile-time checks now compare paper configuration, position responses and candles to server definitions. This caught the nullable R response: three views previously assumed a number and now handle unknown R safely.
- Established Prettier formatting and CI checks. The broad formatting changes are intentionally mechanical. Existing specialized comparison matrices retain semantic tables; the old shared CSS files still contain active controls/layouts and were not deleted wholesale.

## Validation

`npm run test:browser --workspace dashboard` type-checks browser fixtures and runs rendered Chromium tests at 1440 × 1000 and 375 × 812. Tests cover full-list sorting, paging, filter/back navigation, mobile detail disclosure, grouped inspection, heatmap keyboard navigation and reaching the final pair, legacy redirects, bulk cancellation, phone control sizes, page overflow and route error states. Heavy-page fixtures contain 206 distinct signal cells and 272 pairs. These are deterministic UI fixtures, not claims about current VM trade counts.

All 26 application destinations are exercised across the focused tests and route smoke test. Endpoint-unavailable smoke checks supplement populated Signals, Scanners and Trade health tests; they are not a full-data integration test of every API. All API calls are intercepted, the backend target is an unused local port, and browser tests cannot reach the VM or place trades. Screenshots and failure traces are available from Playwright artifacts. CI runs the browser suite in addition to lint, formatting, unit tests, dashboard build and the server suite on Node 22/24.

The type assertions cover the three named contracts, not every response schema. Historical book categories, scanner evidence and trading policies are unchanged. Deployment must preserve the full configuration and verify the served asset hashes and service health.
