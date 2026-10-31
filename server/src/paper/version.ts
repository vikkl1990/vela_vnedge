/** Increment when fill/signal semantics invalidate cached backtests and learning labels. */
// 5 (decision 191): the backtests take the books' entry model, limit fill rule, reversal order and script-exit protection
// 6: explicit fee/crossing cost semantics and optional exact funding settlements.
// 7: script TP notifications execute at the current market with crossing costs, never at a retrospective target.
// 8: account backtests enforce the same native/mixed-stop restriction as account execution.
export const SIMULATION_VERSION = 9;
