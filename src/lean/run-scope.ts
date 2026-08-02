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

/**
 * Which LEG the current verified-core calls belong to — its `legFingerprint`,
 * or `""` when they arise outside any leg.
 *
 * The matcher ledger has always recorded this, because it is handed the leg's
 * fixes directly. The geometry passes are not: they run as hooks fired from
 * inside `matchTrajectory` and `matchWalkSegment`, several frames below anyone
 * who knows which leg is being processed, so `lean-passes.ts` could only ever
 * describe a divergence by the shape of the pass input — `op|n|note`.
 *
 * That is not an identity, and #406 showed what it costs. A change to the
 * candidate cut lengthened two matched paths by one vertex; `n` and the flipped
 * indices moved with them, two signed-off near-ties in `accepted-deltas.ts` no
 * longer matched their manifest keys, and the gate reported them as new. The
 * near-ties had not changed at all. Worse in the other direction: with no
 * identity, a genuinely new divergence that happened to land on an old
 * `op|n|note` would have been accepted silently.
 *
 * A fingerprint of the leg's own GPS fixes is stable exactly where the pass
 * input is not — the matcher can redraw the path all it likes; the fixes it was
 * given are the same fixes. It is also the key the matcher manifest already
 * uses, so both manifests now name a leg the same way.
 *
 * Ambient rather than a parameter for the same reason `scope` is: threading it
 * would mean teaching `map-match-core` — deliberately arm-neutral geometry —
 * about Lean ledgers, and every intermediate frame besides.
 */
let leg = "";

/** Label subsequent verified-core calls. Callers that never set it stay in
 *  `decode`, so any path that has not been taught about scopes attributes its
 *  calls to served output — the conservative direction. */
export function setLeanRunScope(s: LeanRunScope): void {
	scope = s;
}

export function leanRunScope(): LeanRunScope {
	return scope;
}

/**
 * Label subsequent verified-core calls with the leg they belong to, and return
 * a restorer. Restore rather than clear: `matchWalkSegmentViaLean` can be
 * entered while another leg is current (the walk shadow re-matches legs from
 * inside a run that is itself processing one), and clearing would leave the
 * outer leg's later calls unattributed.
 *
 * Callers that never set it leave the leg empty, which the manifests treat as
 * unattributable and therefore never auto-accept — the conservative direction,
 * matching how an unset scope attributes to served output.
 */
export function setLeanLeg(fingerprint: string): () => void {
	const prev = leg;
	leg = fingerprint;
	return () => {
		leg = prev;
	};
}

/** The leg current verified-core calls belong to; `""` if none is in scope. */
export function leanLeg(): string {
	return leg;
}

/** Return to `decode` and no leg, so a new day starts attributing afresh.
 *  Called by each ledger's reset. */
export function resetLeanRunScope(): void {
	scope = "decode";
	leg = "";
}

/** LEAN_SHADOW=1 — run the expensive observational A/B replays (currently the
 *  walk-matcher shadow's extra per-day velocity pass, ~74s/day). Off by default
 *  so the daily serve cron pays only for what it serves; the served path's own
 *  matcher/pass calls are still tallied and reported by the ledgers regardless.
 *  A periodic `LEAN_SHADOW=1` audit run re-exercises the full replay. */
export function leanShadowEnabled(): boolean {
	return process.env.LEAN_SHADOW === "1";
}
