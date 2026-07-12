/**
 * Don't call a ride a car while it is still happening.
 *
 * `driving` does double duty in this pipeline. It is both the name of a real
 * mode (a car) and the *placeholder* every pass uses for "a vehicle-speed run I
 * have not identified yet": `splitWalksOnVehicleLeg` carves a ride out of a walk
 * and hard-codes `mode = "driving"` with the way name deliberately cleared, so
 * that the rail passes (`annotateRailRuns`, underground reconstruction,
 * `tubeHop`) and the bus passes (`annotateBusEvidence`, `annotateBusRoutes`) can
 * each claim it in turn. That is a sound way to run the cascade — but it means
 * an *unclaimed* placeholder reaches the UI wearing the name of a car.
 *
 * That is the 2026-07-12 bug. One minute into a Metropolitan Line ride, the rail
 * passes had too little track to identify the line, nothing else claimed the
 * leg, and the timeline rendered a confident "driving" — a car, on rails, on no
 * street. Two minutes later the same ride became `train on Metropolitan Line`.
 * The label had never been a finding, only a default nobody had overwritten yet.
 *
 * ## Why the obvious rule is wrong
 *
 * The tempting fix is "a road vehicle with no road under it is not a car" —
 * demote any `driving` leg with no `matchedPath`, no `wayName` and no
 * `vehicleKind`. The golden corpus refutes it. Two *user-confirmed* taxi rides
 * carry no road evidence at all:
 *
 *   - 2026-05-20 23:16–23:22, the taxi home from Varley;
 *   - 2026-05-25 12:41–12:55, "the short vehicle leg back home", whose tail
 *     (12:52–12:55) the segmenter splits off unnamed.
 *
 * The road matcher fails for its own reasons — a short leg, sparse fixes, a
 * fragmented graph — so *absence of a road match is not evidence of absence of a
 * road*. A rule built on it quietly renames real drives.
 *
 * ## The signal that actually separates them
 *
 * The tube ride was not distinguished by lacking evidence. It was distinguished
 * by being **unfinished**: one minute old, still accruing fixes, with the passes
 * that would name it still starved of track. The taxis were over and done.
 *
 * So the rule keys on incompleteness, not ignorance: demote only the ride that
 * is still unfolding — the last segment in the day, with nothing after it to
 * close it off — and only when no pass has managed to claim it. A finished ride,
 * however thinly evidenced, keeps whatever the pipeline concluded about it.
 *
 * This stays a pure function of the inputs (no clock), so the golden corpus
 * replays byte-identically: on a completed day the final segment is a stay or a
 * sleep, and this pass does nothing at all.
 */

import type { EnrichedSegment } from "../enriched-segment.js";
import { effectiveMode } from "../segment-util.js";

export function resolveVehicleIdentity<T extends EnrichedSegment>(segments: readonly T[]): T[] {
	if (segments.length === 0) return [...segments];

	const lastIdx = segments.length - 1;
	return segments.map((seg, i) => {
		// Only the trailing leg — the ride still in progress. Anything with a
		// segment after it has finished, and its label is the cascade's final
		// word, not a placeholder awaiting more data.
		if (i !== lastIdx) return seg;
		if (effectiveMode(seg) !== "driving") return seg;
		// Any claim at all — a matched road, a named street, an identified bus
		// route — and some pass *has* placed this ride. Only the untouched
		// placeholder is a guess.
		if (seg.matchedPath?.length || seg.wayName || seg.vehicleKind) return seg;
		return {
			...seg,
			refinedMode: "vehicle",
			refinedReason:
				"unidentified vehicle: a ride still in progress — vehicle speed, but no pass has yet placed it on a road, a bus route or a rail line, so a car cannot be asserted",
		};
	});
}
