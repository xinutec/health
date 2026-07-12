/**
 * Venue-decision trace: an opt-in tap on the venue-plausibility ranking, so a
 * referee can measure what the scorer did without changing what it does.
 *
 * `bestPlace` ranks every candidate for a stay and then keeps (or rejects)
 * the winner. That decision is invisible from the outside: the pipeline emits
 * a place NAME, not the evidence behind it. Tuning against names alone is how
 * #341 happened — two geometry changes that looked right on one anecdote and
 * silently cost two user-confirmed venue labels elsewhere.
 *
 * The sink is null by default and the tap is a single optional call, so the
 * production path pays nothing. Only the referee (`score-venues`) installs
 * one; the traces it collects are the input to the venue-attribution report.
 */

import type { StayShape, VenueCandidateScore } from "./venue-prior.js";

export interface VenueDecisionTrace {
	/** Stay centroid the ranking was run at. */
	lat: number;
	lon: number;
	/** Stay window + timezone, when the caller supplied one (the venue-
	 *  plausibility path). Absent for the context-free `pickBestLandmark`
	 *  path, which is not what this referee measures. */
	stay: StayShape | null;
	/** Every candidate, best first — exactly what `rankVenues` returned. */
	ranked: readonly VenueCandidateScore[];
	/** True when the top candidate cleared `VENUE_RANK_FLOOR_NATS` (or was an
	 *  enclosing institution) and so became the stay's label. False means the
	 *  scorer honestly declined and `bestPlace` fell through to the
	 *  residential / area chain — a non-answer, not a wrong answer. */
	accepted: boolean;
}

type Sink = (trace: VenueDecisionTrace) => void;

let sink: Sink | null = null;

/** Install a trace sink (the referee). Returns a disposer that restores the
 *  previous sink, so nested/parallel harnesses can't leak into each other. */
export function setVenueTraceSink(next: Sink | null): () => void {
	const prev = sink;
	sink = next;
	return () => {
		sink = prev;
	};
}

/** Emit a decision, if anyone is listening. Called from `bestPlace`. */
export function traceVenueDecision(trace: VenueDecisionTrace): void {
	sink?.(trace);
}
