/**
 * Constraint repair: the day-grammar's vehicle-handoff law, enforced.
 *
 * The grammar (`src/infer/day-grammar.ts`) says two *different* vehicles cannot
 * hand off directly — you can't step from one moving vehicle into another
 * without alighting. This pass is the critic that *repairs* that violation in
 * the timeline rather than merely flagging it.
 *
 * The case it fixes: a contiguous vehicle leg that is NOT itself an identified
 * rail journey, handing straight off to (or from) an identified `train` journey
 * (one with a resolved board→alight station pair), with no walk/stop between.
 * That is not two journeys — it is one rail journey, part of which was
 * mislabelled. Two shapes:
 *   - a non-train vehicle leg: the underground stretch where a tube runs *under*
 *     a road, snapped to "driving" (the 2026-06-18 "driving on Euston Underpass"
 *     flush against "Euston Square → Wembley Park");
 *   - a bare-line train fragment with no station pair, line-attributed on local
 *     proximity to a *parallel* line the journey can't actually be on (the
 *     2026-06-18 "Jubilee Line" fragment of that same Euston Square → Wembley
 *     Park ride — the Jubilee does not serve Euston Square, only the
 *     Metropolitan does, but Met and Jubilee share the Baker St → Finchley Rd
 *     corridor, so the gap alone can't tell them apart).
 * Absorb the non-journey leg into the identified train.
 *
 * Conservative by construction: it fires ONLY on a contiguous hand-off (a real
 * park-and-ride has a walk or a GPS gap between car and platform, so it is
 * never contiguous) and ONLY into a train with a resolved board→alight
 * identity. It cannot invent a rail journey, only reclaim minutes flush against
 * one. Pure.
 */

import type { EnrichedSegment } from "../enriched-segment.js";
import { effectiveMode } from "../segment-util.js";
import type { TransportMode } from "../segments.js";

/** Modes in which the user is aboard a vehicle (segment-level `TransportMode`;
 *  bus is a `vehicleKind` refinement of driving, not a base mode here). */
const VEHICLE_MODES: ReadonlySet<TransportMode> = new Set(["driving", "train", "cycling", "plane"]);

/** Max end→start gap for two legs to count as a contiguous hand-off. A wider
 *  gap is unobserved time the alighting could have happened in (see the grammar
 *  module's matching constant). */
const CONTIGUITY_MAX_GAP_S = 120;

/** A train leg with a resolved board→alight identity ("Board → Alight …"). */
function isIdentifiedTrain(seg: EnrichedSegment): boolean {
	return effectiveMode(seg) === "train" && (seg.wayName ?? "").includes(" → ");
}

/** Whether `a` immediately followed by `b` is an absorbable hand-off into a
 *  rail journey: contiguous, both aboard a vehicle, and exactly one of them an
 *  *identified* train (a resolved board→alight journey). The other side — a
 *  non-train vehicle (driving), or a bare-line train fragment with no station
 *  pair — is absorbed into it. Two identified trains (a real interchange) are
 *  left alone; so are two un-identified legs (no journey to absorb into). */
function isAbsorbableHandoff(a: EnrichedSegment, b: EnrichedSegment): boolean {
	const ma = effectiveMode(a);
	const mb = effectiveMode(b);
	if (!VEHICLE_MODES.has(ma) || !VEHICLE_MODES.has(mb)) return false;
	if (b.startTs - a.endTs > CONTIGUITY_MAX_GAP_S) return false;
	// Exactly one side is an identified train: absorb the other into it.
	return isIdentifiedTrain(a) !== isIdentifiedTrain(b);
}

/** Merge a non-train vehicle leg into the train leg it hands off to/from,
 *  keeping the train's identity and extending its span to cover both. */
function absorbIntoTrain(a: EnrichedSegment, b: EnrichedSegment): EnrichedSegment {
	const train = isIdentifiedTrain(a) ? a : b;
	const other = train === a ? b : a;
	const otherMode = effectiveMode(other);
	const reason = `absorbed contiguous ${otherMode} leg (impossible vehicle hand-off — same rail journey)`;
	return {
		...train,
		startTs: Math.min(a.startTs, b.startTs),
		endTs: Math.max(a.endTs, b.endTs),
		pointCount: a.pointCount + b.pointCount,
		refinedReason: train.refinedReason ? `${train.refinedReason}; ${reason}` : reason,
	};
}

/**
 * Repair contiguous vehicle hand-offs by absorbing the non-train leg into the
 * adjacent identified train journey. A single left-to-right fold handles runs
 * (driving → train → driving collapses to one train). Returns the input
 * unchanged when there is nothing to repair.
 */
export function repairVehicleHandoff(segments: EnrichedSegment[]): EnrichedSegment[] {
	const out: EnrichedSegment[] = [];
	for (const seg of segments) {
		const prev = out[out.length - 1];
		if (prev && isAbsorbableHandoff(prev, seg)) {
			out[out.length - 1] = absorbIntoTrain(prev, seg);
			continue;
		}
		out.push(seg);
	}
	return out;
}
