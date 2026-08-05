/**
 * Venue-attribution referee (proposal `docs/proposals/2026-07-venue-
 * measurement-model.md`, phase V0).
 *
 * The venue scorer is currently tuned against anecdotes: a stay is named
 * wrong, someone (me) reasons about the geometry, changes the ranking, and
 * checks the one stay that prompted it. That is exactly how #341 happened —
 * two changes that fixed Urban Social and silently cost the confirmed
 * Starbucks (05-18) and Pret A Manger (06-15) labels.
 *
 * This module turns "is the venue scorer any good?" into a number, over the
 * whole golden corpus, before any ranking change. It answers three questions:
 *
 *  1. **Accuracy** — of the stays whose ground-truth narrative names a venue,
 *     how many does the scorer name correctly?
 *  2. **Near-field** — how often does `NEAR_FIELD_DECISIVE_M` short-circuit
 *     the score, and when it does, is it right? A short-circuit that fires on
 *     a wrong venue is a decision the evidence never got to make.
 *  3. **Recoverability** — when the scorer is wrong, was the true venue even
 *     a candidate, where did it rank, and how many nats behind? A truth that
 *     ranks #2 by 0.3 nats is a tuning problem; a truth absent from the
 *     candidate set is a mirror/geometry problem, and no amount of scoring
 *     will fix it.
 *
 * Pure: the caller (`score-venues`) replays the fixtures and joins the traces
 * to the narratives; everything here is arithmetic over that join.
 */

import { VENUE_RANK_FLOOR_NATS, type VenueCandidateScore } from "../geo/venue-prior.js";

/** How the pipeline did on one stay that the ground truth names. The verdict
 *  is on the label the TIMELINE shows — not on the venue scorer's opinion,
 *  which a later layer may override. */
export type VenueVerdict =
	/** The timeline names the venue the narrative names. */
	| "correct"
	/** The timeline names a venue, and it is not the one the narrative names. */
	| "wrong"
	/** The timeline names no venue at all — every candidate fell below the
	 *  honest-label floor and the stay carries an area/address label. Not a
	 *  wrong answer: a non-answer, and a different bug. */
	| "declined";

/**
 * Which layer produced the label the user sees. The venue scorer is only one
 * of them, and NOT the last word: a mined focus place overrides it. That
 * matters more than it sounds — the Urban Social stay is labelled by a focus
 * place ("The Library") that was itself mined from an earlier venue-scorer
 * mistake, so the scorer is not even consulted and no change to `rankVenues`
 * can reach it. A referee that only tapped the scorer would not see this.
 */
export type VenueLayer =
	/** `rankVenues` ran and its winner survived to the timeline. */
	| "scorer"
	/** A mined focus place (`known_places`) named the stay, overriding or
	 *  pre-empting the scorer. */
	| "focus-place"
	/** Neither — a Nominatim area/address label, a station, or nothing. */
	| "other";

/** One stay's worth of evidence, assembled by the CLI. */
export interface VenueCase {
	date: string;
	/** Local HH:MM–HH:MM of the stay, for the report. */
	window: string;
	/** Stay duration in seconds. */
	durationSec: number;
	/** The venue the ground-truth narrative names for this stay. */
	truthPlace: string;
	/** The label the TIMELINE ends up showing — the user-visible answer, after
	 *  every override. Null when the stay carries no venue label. */
	finalPlace: string | null;
	/** Which layer produced `finalPlace`. */
	layer: VenueLayer;
	/** The full ranking the venue scorer produced, best first. EMPTY when the
	 *  scorer never ran on this stay — which is itself the finding. */
	ranked: readonly VenueCandidateScore[];
	/** Whether the scorer's top candidate cleared the floor. */
	accepted: boolean;
	/** Spread of the stay's own GPS fixes (metres, 90th-percentile distance
	 *  from the centroid) — the "how smeared is this sit" number the scorer is
	 *  currently blind to, and the gate V1 proposes. */
	fixSpreadM: number | null;
	/** Median reported accuracy of the stay's fixes (metres). */
	medianAccM: number | null;
}

export interface VenueCaseResult {
	readonly case: VenueCase;
	verdict: VenueVerdict;
	/** The name the timeline shows (null when no venue was named). */
	chosen: string | null;
	/** True when the venue scorer's winner won by near-field distance
	 *  dominance rather than by score — i.e. the summed evidence never decided
	 *  it. Meaningless (false) when the scorer never ran. */
	wonByNearField: boolean;
	/** Where the true venue ranked among the candidates (0-based), or null
	 *  when it was not a candidate at all. */
	truthRank: number | null;
	/** How many nats of summed evidence separate the winner from the truth.
	 *  Positive = the winner scores higher. Null when the truth is not a
	 *  candidate. NOTE: when `wonByNearField` is set this gap is *not* why the
	 *  winner won — a negative gap here means the score already preferred the
	 *  truth and the short-circuit overrode it. That is the V1 case. */
	truthGapNats: number | null;
	/** The truth scored HIGHER than the winner, and lost only to the
	 *  near-field short-circuit. These stays are fixed by V1 alone. */
	blockedByNearField: boolean;
	/** The short-circuit elected a candidate the summed evidence ranked BELOW
	 *  another one — i.e. the rule overrode the score.
	 *
	 *  Deliberately NOT conditioned on the verdict, the layer, or on the truth
	 *  being a candidate, and that is the whole point. {@link blockedByNearField}
	 *  requires `verdict === "wrong"`, so it can only fire once the damage is
	 *  already user-visible; a stay where a later layer rescues the label is
	 *  invisible to it. Measured 2026-08-05 over 62 cases: `blockedByNearField`
	 *  counted 0 while this counted 6. A metric that can only see a defect the
	 *  moment it stops being masked cannot tell you the mask is load-bearing. */
	nearFieldOverrodeScore: boolean;
	/** By how many nats the highest-scoring non-near-field candidate led the
	 *  elected one. Null when the rule did not override.
	 *
	 *  The MAGNITUDE is the finding, not the count: a rule that breaks ties is
	 *  doing its job, a rule that beats evidence is not. Measured 2026-08-05,
	 *  the corpus-worst override is 1.26 nats — tie-breaking territory. #345 was
	 *  filed claiming 4.03 nats on a 2026-06-15 stay; no such case survives in
	 *  the corpus, and the narrative for that window has since changed. Re-read
	 *  this number before arguing the rule needs replacing. */
	nearFieldOverrodeByNats: number | null;
	/** The short-circuit elected a candidate scoring below
	 *  {@link VENUE_RANK_FLOOR_NATS}, so `bestPlace` declines to name it and the
	 *  stay falls through to an area/address label. Here the rule does not
	 *  misdirect the answer, it DESTROYS one: a nameable stay becomes a
	 *  non-answer while a candidate above the floor sat lower in the ranking. */
	nearFieldBelowFloor: boolean;
}

export interface VenueReport {
	total: number;
	correct: number;
	wrong: number;
	declined: number;
	/** Cases by the layer that produced the label, each with its own accuracy.
	 *  A layer that is often WRONG is where the next fix belongs — and a layer
	 *  that answers stays the venue scorer never sees is a layer no change to
	 *  `rankVenues` can reach. */
	byLayer: Record<VenueLayer, { total: number; correct: number }>;
	/** Cases the venue scorer never even ran on. */
	scorerNeverRan: number;
	/** Of the cases the scorer DID decide, how many the near-field rule
	 *  short-circuited. */
	nearFieldDecided: number;
	/** Of those, how many it decided WRONGLY. */
	nearFieldWrong: number;
	/** Wrong cases where the truth outscored the winner and lost only to the
	 *  short-circuit — the V1 target. */
	blockedByNearField: number;
	/** Stays where the short-circuit overrode the summed evidence, WHATEVER the
	 *  final label turned out to be. Always ≥ `blockedByNearField`; the excess
	 *  is the set of rankings a later layer is currently masking. */
	nearFieldOverrodeScore: number;
	/** The largest such override, in nats. A big number here means the rule is
	 *  beating evidence, not breaking ties. */
	worstNearFieldOverrideNats: number | null;
	/** Stays where the short-circuit elected a below-floor candidate, turning a
	 *  nameable stay into an area/address label. */
	nearFieldBelowFloor: number;
	/** Wrong/declined cases where the true venue was not among the scorer's
	 *  candidates at all — unreachable by any change to the ranking. */
	truthMissing: number;
	results: readonly VenueCaseResult[];
}

/**
 * Does a candidate name refer to the venue the narrative names?
 *
 * The narrative is written by a human ("Urban Social"); OSM carries the full
 * signage ("Urban Social Coffee"). Requiring an exact match would score the
 * right answer as wrong. Matching on containment of the *whole* normalized
 * name (not per-token) keeps that forgiveness without letting "Library"
 * swallow "The Library Pub" by accident of a shared word: one side must be a
 * word-aligned prefix/suffix-anchored substring of the other.
 */
export function venueNameMatches(truth: string, candidate: string): boolean {
	const a = normalizeVenueName(truth);
	const b = normalizeVenueName(candidate);
	if (!a || !b) return false;
	if (a === b) return true;
	// Word-aligned containment: "urban social" ⊂ "urban social coffee".
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	return long.startsWith(`${short} `) || long.endsWith(` ${short}`) || long.includes(` ${short} `);
}

/** Lowercase, drop punctuation and a leading article, collapse whitespace. */
export function normalizeVenueName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^the /, "");
}

/** Adjudicate one stay against the label the timeline actually shows. */
export function judgeVenueCase(c: VenueCase): VenueCaseResult {
	const top = c.ranked[0] ?? null;
	const chosen = c.finalPlace;
	const truthIdx = c.ranked.findIndex((r) => venueNameMatches(c.truthPlace, r.landmark.name));
	const truthRank = truthIdx >= 0 ? truthIdx : null;
	const truth = truthIdx >= 0 ? c.ranked[truthIdx] : null;
	const truthGapNats = top && truth ? top.total - truth.total : null;
	// Only meaningful when the scorer's winner is the label that survived.
	const wonByNearField = c.layer === "scorer" && c.accepted && top?.nearField === true;
	const verdict: VenueVerdict = !chosen ? "declined" : venueNameMatches(c.truthPlace, chosen) ? "correct" : "wrong";
	// The two RANKING pathologies. Computed from the ranking alone — no verdict,
	// no layer, no truth — so a stay whose label another layer rescues still
	// reports the defect underneath it.
	//
	// `bestOther` is taken as a MAX rather than the first non-near-field entry:
	// the ranking is sorted near-field-first, and reading position for score
	// would bake that sort order into the metric measuring it.
	const nonNearField = c.ranked.filter((r) => !r.nearField);
	const bestOther = nonNearField.length ? nonNearField.reduce((a, b) => (b.total > a.total ? b : a)) : null;
	const nearFieldOverrodeScore = top?.nearField === true && bestOther !== null && bestOther.total > top.total;
	return {
		case: c,
		verdict,
		chosen,
		wonByNearField,
		truthRank,
		truthGapNats,
		nearFieldOverrodeScore,
		nearFieldOverrodeByNats: nearFieldOverrodeScore && bestOther && top ? bestOther.total - top.total : null,
		nearFieldBelowFloor: top?.nearField === true && top.total < VENUE_RANK_FLOOR_NATS,
		// The score preferred the truth (gap ≤ 0) but the short-circuit put a
		// lower-scoring candidate on top anyway. These, and only these, are the
		// stays that gating the short-circuit (V1) would fix.
		blockedByNearField:
			verdict === "wrong" && wonByNearField && truth !== null && !truth.nearField && (truthGapNats ?? 1) <= 0,
	};
}

export function reportVenues(cases: readonly VenueCase[]): VenueReport {
	const results = cases.map(judgeVenueCase);
	const count = (p: (r: VenueCaseResult) => boolean): number => results.filter(p).length;
	const byLayer = {} as Record<VenueLayer, { total: number; correct: number }>;
	for (const layer of ["scorer", "focus-place", "other"] as const) {
		byLayer[layer] = {
			total: count((r) => r.case.layer === layer),
			correct: count((r) => r.case.layer === layer && r.verdict === "correct"),
		};
	}
	const decidedByScorer = (r: VenueCaseResult): boolean => r.case.ranked.length > 0;
	return {
		total: results.length,
		correct: count((r) => r.verdict === "correct"),
		wrong: count((r) => r.verdict === "wrong"),
		declined: count((r) => r.verdict === "declined"),
		byLayer,
		scorerNeverRan: count((r) => !decidedByScorer(r)),
		nearFieldDecided: count((r) => r.wonByNearField),
		nearFieldWrong: count((r) => r.wonByNearField && r.verdict === "wrong"),
		blockedByNearField: count((r) => r.blockedByNearField),
		nearFieldOverrodeScore: count((r) => r.nearFieldOverrodeScore),
		worstNearFieldOverrideNats: results.reduce<number | null>(
			(worst, r) =>
				r.nearFieldOverrodeByNats !== null && (worst === null || r.nearFieldOverrodeByNats > worst)
					? r.nearFieldOverrodeByNats
					: worst,
			null,
		),
		nearFieldBelowFloor: count((r) => r.nearFieldBelowFloor),
		truthMissing: count((r) => r.verdict !== "correct" && decidedByScorer(r) && r.truthRank === null),
		results,
	};
}

/** 90th-percentile distance of a stay's fixes from their centroid: how far the
 *  sensor smeared this sit. A clean outdoor stay is a few metres; the Urban
 *  Social sit is ~30 m. This is the quantity `rankVenues` cannot currently
 *  see, and the one V1 proposes to gate the near-field short-circuit on. */
export function fixSpreadM(fixes: readonly { lat: number; lon: number }[]): number | null {
	if (fixes.length < 2) return null;
	const cLat = fixes.reduce((s, f) => s + f.lat, 0) / fixes.length;
	const cLon = fixes.reduce((s, f) => s + f.lon, 0) / fixes.length;
	const mPerDegLat = 111_320;
	const mPerDegLon = 111_320 * Math.cos((cLat * Math.PI) / 180);
	const d = fixes
		.map((f) => Math.hypot((f.lat - cLat) * mPerDegLat, (f.lon - cLon) * mPerDegLon))
		.sort((a, b) => a - b);
	return d[Math.min(d.length - 1, Math.floor(0.9 * d.length))];
}

export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
