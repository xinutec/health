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
 *   null  — no override: the deploy-time `LEAN_*` env flag for each tenant
 *           rules, unchanged. This is the state after every restart.
 *   true  — serve the verified Lean core for EVERY tenant that consults this,
 *           including ones still in `shadow`.
 *   false — pure TS for all of them.
 *
 * **`true` deliberately overrides a tenant's soak stage, and that is the
 * feature, not a hole in it.** The switch exists to build confidence on real
 * data BEFORE a flip; a version that only affected already-flipped tenants
 * would do nothing at the moment it is wanted. What the soak gates is the
 * DEFAULT — the env flag, which governs the nightly cron and every request
 * after a restart — and this never touches that.
 *
 * Three things make it containable, and all three are load-bearing:
 *   - in-memory and process-global, so it resets to the env default on restart;
 *   - the nightly decode cron is a SEPARATE process this never reaches, so the
 *     soak ledger stays driven purely by the env flags;
 *   - the request path does not persist decodes — `saveDecode` has exactly one
 *     caller, `cli/decode-day.ts` — so nothing a toggle produces outlives the
 *     pod. Adding a request-path write would break that, and would make this
 *     switch genuinely unsafe; check here first if you ever add one.
 *
 * Setting the override is NOT enough on its own: `/api/velocity` results are
 * cached in-process, and that cache assumes only a deploy changes the answer
 * (deploys restart the pod). The route therefore clears it on every real change
 * — without that the toggle silently does nothing for any day already viewed,
 * which is exactly the day you are looking at when you reach for it. See
 * `routes/velocity-cache.ts`. Anything else that memoises pipeline output must
 * do the same, so the setter stays a plain assignment and the invalidation is
 * the caller's job, in one place, where the caches are known.
 *
 * (An earlier version of this comment claimed a tenant "joins this switch only
 * once its own soak says `on` is safe". That was never true of the code —
 * Kalman consulted it from its first shadow day — and it contradicted the
 * paragraph above it. Recorded rather than quietly deleted, because the
 * mismatch is what an audit of this file will most likely turn up again.)
 *
 * Process-global rather than per-session because health is single-user: a global
 * toggle needs no per-user plumbing.
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
