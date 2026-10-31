/** SQL predicate for a positions table aliased p. Scope is frozen at order creation;
 * legacy scopes were inferred once at migration, never reconstructed as entry-time facts. */
export const ACCOUNT_AND_SHADOW_EVIDENCE = "(p.bt=0 OR (p.bt=2 AND p.evidence_scope IN ('shadow','legacy-shadow')))";
