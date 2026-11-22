# Open PR review — 16 November 2026

Review of the five open PRs at 17:25 UTC. Their feature changes are not included in the quote/layout correction. CI results below are observations of the PR heads, not a claim that each feature was deployed or rendered here.

## Changes to make before merging

1. **[PR 65](https://github.com/vikkl1990/vela_vnedge/pull/65), confidence badges — medium.** `stats()` computes `sqrt(sum(dayResidualSum²))/n` without the small-sample `G/(G-1)` variance correction while the UI calls the result a 95% t interval. With just five days this understates the standard error by about 11%. `tCritical()` also drops from 2.042 at 30 degrees of freedom to 1.96 at 31, instead of approximately 2.040. Near-zero lower bounds can change from “not proven” to “edge”. Use a consistent finite-sample interval and boundary tests before presenting those verdicts. Head `f6b45233e0a5b30d439fa3327835ae9a035ef093`; CI passes.

2. **[PR 66](https://github.com/vikkl1990/vela_vnedge/pull/66), shared market scope — medium.** Changing global scope changes `journalFilters(..., scope)` but keeps the existing URL `page` and therefore its offset. A user on page 8 who narrows to a class with one page gets an empty list until manually paging back. Page-level filter updates already reset pagination; global scope changes need the same behavior. Add a rendered test starting on a later page. Head `7924b304c1779fde592b90a207c9c98b54b80640`; successful server/dashboard checks, one duplicate ops run cancelled.

3. **[PR 64](https://github.com/vikkl1990/vela_vnedge/pull/64), movers — medium.** The server first keeps only the top 60 by the maximum change across *all* windows, then the browser sorts that subset by the chosen window. A leading five-minute mover can be omitted if 60 other symbols had larger one-hour moves. Rank by the requested window or return the union of each window's leaders. Also move the out-of-order guard before the coalescing branch in `MoverStore.record()`: a negative timestamp delta currently enters `delta < MIN_GAP_MS` and rewrites the most recent price. A refresh failure after a prior success retains React Query's old data, but the component has no stale/error indication despite the “Moving now” label. Head `fd93b60bdd98eacfc1e1fc1f284174ee51b3a5f6`; successful server/dashboard checks, one duplicate ops run cancelled.

## Other PRs

- **[PR 67](https://github.com/vikkl1990/vela_vnedge/pull/67), journal stepping:** no blocking defect found in the diff; CI passes. Head `d0cfed58e553ae14e91dddd9712341d0bb857f8e`. The tests cover the pure stepping/chord helpers; a rendered j/k versus g-k navigation test would give stronger integration coverage. Left open, not merged by this audit.
- **[PR 35](https://github.com/vikkl1990/vela_vnedge/pull/35), disabling entry guards:** draft and conflicting with main; changes cooldown, burst and regime policy. Its description and expectations predate the current capacity policy. It is outside this task's unchanged-risk scope and is not ready to merge as-is. Head `49b9e7bd1b5b40e890fb0ce8798d809c53f6da39`.
