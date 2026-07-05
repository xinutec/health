/**
 * Dwell-prior continuation (#259) — the prospective half of "rely on strong
 * history". When the phone goes quiet at a strong focus_place and there is NO
 * closing bracket (the current day, or no next-day data, or no sleep that
 * night), silence is still evidence: the user is most likely still there.
 *
 * Unlike the empty-day bracket (needs both neighbouring days) and sleep-
 * bridging (needs a sleep window), this leans only on the PLACE'S OWN history.
 * Each focus_place records `total_dwell_sec` over `visit_count` visits, so its
 * characteristic dwell time is
 *
 *     τ = total_dwell_sec / visit_count            (mean visit length)
 *
 * Model the chance the user is still there as an exponential survival curve in
 * the time elapsed since the last fix:
 *
 *     P(still here | Δ) = exp(-Δ / τ)
 *
 * Memoryless and conservative — it does not assume how long they had already
 * been there. Home's τ is many hours, so P stays high across an evening; a
 * café's τ is ~an hour, so P decays fast and we stop filling quickly. We
 * continue the stay only while P ≥ a floor; past that the time is left an
 * honest gap rather than a fabricated stay (honest low-confidence beats
 * fabricated precision).
 *
 * Pure module — no DB, no IO. The caller supplies the place's dwell stats and
 * the day bounds; the velocity layer applies the returned window.
 */

import type { DayState } from "../sleep/day-state.js";
import type { KnownPlaceProjection } from "./classification-inputs.js";
import type { EnrichedSegment } from "./enriched-segment.js";
import { haversineMeters } from "./place-snap.js";

/** Minimum establishment (distinct days seen) for a place to carry a usable
 *  dwell prior. Below this, `total_dwell_sec / visit_count` is too noisy to
 *  trust, so we decline and leave an honest gap. */
export const MIN_ESTABLISH_DAYS = 5;

/** The survival floor: continue the stay while P(still here) ≥ this, then
 *  stop. 0.5 = "more likely than not still here". */
export const CONFIDENCE_FLOOR = 0.5;

export interface DwellPlace {
	/** Sum of stay durations across all visits, seconds. */
	totalDwellSec: number;
	/** Number of distinct visits. */
	visitCount: number;
	/** Distinct days the place was seen — establishment. */
	uniqueDays: number;
}

/** Mean visit length (τ), seconds, or null when the stats can't support one. */
export function meanDwellSec(place: DwellPlace): number | null {
	if (place.visitCount <= 0 || place.totalDwellSec <= 0) return null;
	return place.totalDwellSec / place.visitCount;
}

/** P(still here) after `elapsedSec` at a place with mean dwell `tauSec`. */
export function dwellSurvival(elapsedSec: number, tauSec: number): number {
	if (tauSec <= 0) return 0;
	return Math.exp(-Math.max(0, elapsedSec) / tauSec);
}

export interface DwellContinuation {
	/** Local-day-clamped timestamp to continue the stay to. */
	endTs: number;
	/** τ used (mean dwell), seconds — for surfacing/telemetry. */
	tauSec: number;
}

/**
 * How far to continue a stay forward from its last observed end, given the
 * place's dwell history. Returns null when the place is too weakly established,
 * its stats are unusable, or there is no trailing room. The continuation runs
 * to where P(still here) hits {@link CONFIDENCE_FLOOR}, clamped to the day end.
 */
export function dwellContinuation(opts: {
	place: DwellPlace;
	lastEndTs: number;
	dayEndTs: number;
	floor?: number;
}): DwellContinuation | null {
	if (opts.place.uniqueDays < MIN_ESTABLISH_DAYS) return null;
	if (opts.lastEndTs >= opts.dayEndTs) return null;
	const tau = meanDwellSec(opts.place);
	if (tau === null) return null;

	const floor = opts.floor ?? CONFIDENCE_FLOOR;
	// Δ where exp(-Δ/τ) == floor  →  Δ = τ·ln(1/floor)
	const horizonSec = tau * Math.log(1 / floor);
	const endTs = Math.min(opts.dayEndTs, opts.lastEndTs + Math.round(horizonSec));
	if (endTs <= opts.lastEndTs) return null;
	return { endTs, tauSec: tau };
}

/** Max distance (m) to bind the day's last observed stay to a focus_place for
 *  the dwell prior. Falls back to the place's own radius when larger. */
const PLACE_MATCH_M = 120;

/**
 * Apply the dwell-prior continuation to a day's states: if the last observed
 * state is a stay that binds to an established focus_place, append one inferred
 * stay running forward to the survival horizon (or the day end). The trailing
 * time past the horizon is left blank — an honest gap, not a fabricated stay.
 *
 * Composes after sleep-bridging / empty-day inference: when those already
 * carried the stay to the day end there is no trailing room, so this is a
 * no-op. Pure — no DB, no clock.
 */
export function applyDwellContinuation(opts: {
	states: readonly DayState[];
	segments: readonly EnrichedSegment[];
	knownPlaces: readonly KnownPlaceProjection[];
	dayEndTs: number;
}): DayState[] {
	const { states, segments, knownPlaces, dayEndTs } = opts;
	if (states.length === 0) return [...states];

	// The trailing edge is the latest-ending state that STARTED within the day,
	// not the array's last element: day-state assembly brackets the day with
	// sleep windows, so the array can end with the next night's sleep (whose
	// timestamps are tomorrow's early hours) or a morning-sleep state, while
	// the true last thing that happened today is an earlier daytime stay.
	// Excluding states that start at/after dayEnd keeps that next-day bracket
	// out of the anchor choice; an evening stay that legitimately crosses
	// midnight still anchors (and then endTs ≥ dayEnd makes it a clean no-op,
	// the evening already covered).
	let anchorIdx = -1;
	for (let i = 0; i < states.length; i++) {
		if (states[i].startTs >= dayEndTs) continue;
		if (anchorIdx < 0 || states[i].endTs > states[anchorIdx].endTs) anchorIdx = i;
	}
	if (anchorIdx < 0) return [...states];
	const anchor = states[anchorIdx];
	if (anchor.mode !== "stationary" && anchor.mode !== "sleeping") return [...states];
	if (anchor.endTs >= dayEndTs) return [...states];

	const stay = [...segments].reverse().find((s) => s.centroidLat != null && s.centroidLon != null);
	if (stay?.centroidLat == null || stay.centroidLon == null) return [...states];

	let best: KnownPlaceProjection | null = null;
	let bestD = Number.POSITIVE_INFINITY;
	for (const p of knownPlaces) {
		const d = haversineMeters(stay.centroidLat, stay.centroidLon, p.centroidLat, p.centroidLon);
		const reach = Math.max(PLACE_MATCH_M, p.radiusM ?? 0);
		if (d <= reach && d < bestD) {
			best = p;
			bestD = d;
		}
	}
	if (best === null) return [...states];

	const cont = dwellContinuation({
		place: {
			totalDwellSec: best.totalDwellSec ?? 0,
			visitCount: best.visitCount ?? 0,
			uniqueDays: best.uniqueDays,
		},
		lastEndTs: anchor.endTs,
		dayEndTs,
	});
	if (cont === null) return [...states];

	const continuation: DayState = {
		startTs: anchor.endTs,
		endTs: cont.endTs,
		mode: "stationary",
		...(anchor.place ? { place: anchor.place } : {}),
		inferred: true,
		...(anchor.tz ? { tz: anchor.tz } : {}),
	};
	// Insert directly after the anchor so relative order is preserved.
	const out = [...states];
	out.splice(anchorIdx + 1, 0, continuation);
	return out;
}
