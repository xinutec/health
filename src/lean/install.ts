/**
 * Install the verified-core pass hooks into the pure map-match core.
 *
 * `map-match-core.ts` is import-free by design (the deterministic fixture
 * core), so it cannot reach the Lean bridge itself; it exposes injection
 * points instead. This module — a non-pure layer that may pull in the bridge
 * — wires those hooks to the `lean-passes` wrappers.
 *
 * The wrapper is a no-op when `LEAN_PASSES` is unset (`simplifyViaLean`
 * returns the TS result before any bridge call), so installing the hook keeps
 * the pipeline byte-identical by default; it only diverges to shadow/serve
 * when the flag is on. Idempotent — the first call wins.
 */

import { legFingerprint } from "../geo/leg-compare.js";
import { setSimplifyHook, setSpursHook, setTrajectoryLegHook } from "../geo/map-match-core.js";
import { removeSpursViaLean, simplifyViaLean } from "./lean-passes.js";
import { setLeanLeg } from "./run-scope.js";

let installed = false;

export function installLeanPasses(): void {
	if (installed) return;
	installed = true;
	setSimplifyHook((pts, toleranceM, ts) => simplifyViaLean(pts, toleranceM, ts));
	setSpursHook((pts, returnM, maxSpan, ts) => removeSpursViaLean(pts, returnM, maxSpan, ts));
	// Name the leg every matched trajectory belongs to, so the pass ledger can
	// attribute its divergences (#409). This covers ROAD legs as well as walk
	// ones — `matchTrajectory` is the single origin of the simplify and spurs
	// calls, and the first harvest run showed both of the corpus's standing
	// near-ties arriving from the road profile, unattributed and colliding on
	// one fingerprint. `matchWalkSegmentViaLean` sets the same leg again around
	// the whole walk call, which additionally covers trim and despike; they
	// derive from the same fixes, so the nested set is the same value.
	setTrajectoryLegHook((fixes) => setLeanLeg(legFingerprint(fixes)));
}
