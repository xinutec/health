/**
 * Runtime master override for serving the verified Lean core, driven by the
 * settings UI (`PUT /api/verified-core`).
 *
 * A TRANSITION affordance — deliberately not a permanent product feature — that
 * lets the live app switch the whole verified core between Lean and TS without a
 * redeploy: to build confidence on real data before the matcher flip, and as a
 * one-click fallback while Lean is young in production. Once TS is retired it
 * comes out.
 *
 *   null  — no override: the deploy-time env flags (`LEAN_PASSES` /
 *           `LEAN_MATCH`) rule, unchanged.
 *   true  — serve the verified Lean core for BOTH the geometry passes AND the
 *           walk matcher.
 *   false — pure TS for both.
 *
 * In-memory and process-global: health is single-user, so a global toggle needs
 * no per-user plumbing. It resets to the env default on restart (a safe property
 * for a viewing override), and the nightly decode cron is a SEPARATE process
 * this never touches — so the soak / ledger stay driven purely by the env flags.
 */
let override: boolean | null = null;

/** The current master override (`null` = follow the deploy-time env flags). */
export function verifiedCoreOverride(): boolean | null {
	return override;
}

/** Set (`true`/`false`) or clear (`null`) the master override. */
export function setVerifiedCoreOverride(value: boolean | null): void {
	override = value;
}
