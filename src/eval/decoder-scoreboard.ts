/**
 * C4.0 shadow scoreboard — the journey-structure dimensions the
 * per-minute and journey scorers don't measure (`2026-07-continuity-c4.md`).
 *
 * Two additions over `journey-score.ts`:
 *
 *   - **Station correctness.** Where a narrative row asserts a board and
 *     alight (`From → To` on a definite row), did the decoder emit the
 *     same pair? Today the decoder emits no stations at all, so the
 *     honest baseline is `missing` — a third outcome distinct from
 *     wrong. C4.3 (chained train triples) exists to move missing →
 *     matching; a wrong station is a lie and scores worse than none.
 *
 *   - **Phantom rides.** A decoder vehicle leg whose time is mostly
 *     covered by enforceable truth asserting a NON-vehicle mode (a ride
 *     invented inside a confirmed stay or walk). Per-minute mode scoring
 *     dilutes these across the day; the count keeps each one visible.
 *
 * Pure functions. No DB, no IO, no globals. Consumes the same
 * `GroundTruthRow[]` / `Journey[]` shapes as the existing scorers.
 */

import { type GroundTruthRow, isEnforceableTruth } from "./ground-truth.js";
import type { Journey, Leg } from "./journey-score.js";
import { canonicalMode } from "./score-day.js";

export interface StationScore {
	/** Ground-truth transit legs asserting both board and alight. */
	stationsAsserted: number;
	/** Decoder emitted the same board AND alight (case-insensitive). */
	stationsMatching: number;
	/** Decoder emitted no stations for the leg (or no same-mode leg
	 *  overlapped at all). The remainder — asserted − matching − missing —
	 *  is legs where the decoder named a WRONG station. */
	stationsMissing: number;
}

/** Score board/alight fidelity: each ground-truth transit leg that
 *  asserts stations is checked against the best-overlapping decoder leg
 *  of the same canonical mode across all decoder journeys. */
export function scoreStations(gtJourneys: readonly Journey[], decJourneys: readonly Journey[]): StationScore {
	const decLegs: Leg[] = decJourneys.flatMap((j) => j.legs);
	let stationsAsserted = 0;
	let stationsMatching = 0;
	let stationsMissing = 0;
	for (const gtJ of gtJourneys) {
		for (const leg of gtJ.legs) {
			if (leg.board === null || leg.alight === null) continue;
			stationsAsserted++;
			const match = bestOverlappingLeg(leg, decLegs);
			if (match === null || match.board === null || match.alight === null) {
				stationsMissing++;
				continue;
			}
			if (
				match.board.toLowerCase() === leg.board.toLowerCase() &&
				match.alight.toLowerCase() === leg.alight.toLowerCase()
			) {
				stationsMatching++;
			}
		}
	}
	return { stationsAsserted, stationsMatching, stationsMissing };
}

/** The same-mode decoder leg with the most temporal overlap, or null.
 *  The overlap must cover a MAJORITY of the truth leg — a neighbouring
 *  ride brushing the boundary by a minute does not represent this leg,
 *  and matching it would convict its stations on pure boundary slop
 *  (the same rationale as `countPhantomRides`' majority rule). */
function bestOverlappingLeg(gt: Leg, decLegs: readonly Leg[]): Leg | null {
	let best: Leg | null = null;
	let bestOv = 0;
	for (const d of decLegs) {
		if (d.mode !== gt.mode) continue;
		const ov = Math.max(0, Math.min(gt.endTs, d.endTs) - Math.max(gt.startTs, d.startTs));
		if (ov > bestOv) {
			bestOv = ov;
			best = d;
		}
	}
	return bestOv * 2 > gt.endTs - gt.startTs ? best : null;
}

/** Vehicle modes — a phantom "ride" is one of these; walking is not a
 *  ride, and a phantom walk is already visible as a missed ride on the
 *  journey shape. */
function isVehicleMode(mode: string): boolean {
	return mode === "train" || mode === "bus" || mode === "driving" || mode === "cycling" || mode === "plane";
}

/** Count decoder vehicle legs contradicted by the ground truth: more
 *  than half the leg's duration lies inside enforceable rows asserting a
 *  non-vehicle mode. Majority (not any-overlap) so boundary slop against
 *  an adjacent stay/walk row doesn't convict a real ride; unaudited time
 *  asserts nothing and cannot convict. */
export function countPhantomRides(rows: readonly GroundTruthRow[], decJourneys: readonly Journey[]): number {
	const contradicting = rows.filter(
		(r) => isEnforceableTruth(r) && r.truth !== null && !isVehicleMode(canonicalMode(r.truth.mode)),
	);
	let phantoms = 0;
	for (const j of decJourneys) {
		for (const leg of j.legs) {
			if (!isVehicleMode(leg.mode)) continue;
			let contradictedS = 0;
			for (const r of contradicting) {
				contradictedS += Math.max(0, Math.min(leg.endTs, r.endTs) - Math.max(leg.startTs, r.startTs));
			}
			if (contradictedS > (leg.endTs - leg.startTs) / 2) phantoms++;
		}
	}
	return phantoms;
}
