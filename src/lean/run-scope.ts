/**
 * Which run the current verified-core calls belong to.
 *
 * A single decode of one day makes SEVERAL passes over the same legs: the
 * decode whose output is persisted and served, plus the observational
 * harnesses (`runLeanShadow`, and `runWalkShadow`'s extra velocity run with
 * its per-leg A/B) that re-process those legs purely to measure. Summed into
 * one tally, a divergence in throwaway measurement code is indistinguishable
 * from one in served output — and telling those apart is the ledger's whole
 * job.
 *
 * The scope lives here, shared by the pass ledger (`lean-passes.ts`) and the
 * matcher ledger (`lean-match.ts`), rather than once per ledger: they are set
 * by the same call site at the same moment, so a second copy could only ever
 * drift out of step with the first and mislabel one ledger's divergences.
 */

export type LeanRunScope = "decode" | "shadow";

let scope: LeanRunScope = "decode";

/** Label subsequent verified-core calls. Callers that never set it stay in
 *  `decode`, so any path that has not been taught about scopes attributes its
 *  calls to served output — the conservative direction. */
export function setLeanRunScope(s: LeanRunScope): void {
	scope = s;
}

export function leanRunScope(): LeanRunScope {
	return scope;
}

/** Return to `decode`, so a new day starts attributing afresh. Called by each
 *  ledger's reset. */
export function resetLeanRunScope(): void {
	scope = "decode";
}

/** LEAN_SHADOW=1 — run the expensive observational A/B replays (currently the
 *  walk-matcher shadow's extra per-day velocity pass, ~74s/day). Off by default
 *  so the daily serve cron pays only for what it serves; the served path's own
 *  matcher/pass calls are still tallied and reported by the ledgers regardless.
 *  A periodic `LEAN_SHADOW=1` audit run re-exercises the full replay. */
export function leanShadowEnabled(): boolean {
	return process.env.LEAN_SHADOW === "1";
}
