/**
 * Factor framework — shared types for the scored-classification
 * refactor.
 *
 * See `docs/proposals/2026-05-scored-classification.md` for the
 * architectural context. Each factor is a pure function: given a
 * `ModeCandidate` (one of the alternative interpretations the
 * candidate-generator emitted) and a `FactorContext` (everything
 * the factor might look at — window features, segment biometrics,
 * OSM near-results, journey-pattern priors), it returns a
 * `FactorScore` carrying its name, a log-likelihood in nats, and a
 * short human-readable rationale.
 *
 * Returning `null` means "this factor does not apply to this
 * candidate / context" — the consumer drops it from the candidate's
 * score sum without penalty. Distinguishing null from a very
 * negative score matters: a missing biometric signature should not
 * dock score, only a clearly-disagreeing biometric signature should.
 */

import type { MinuteObservation, ModeStats } from "../mode-biometrics.js";
import type { TransportMode, WindowFeatures } from "../segments.js";

/** A single candidate interpretation of a segment. The candidate
 *  generator (rebuild of `refineMode` and `annotateRailRuns` in
 *  Phase 1) emits multiple candidates per segment; factors score
 *  them; the highest-total wins.
 *
 *  This shape will grow as factors that need more candidate-level
 *  detail get added (e.g. station-line-intersection wants both
 *  endpoint stations). Optional fields are added at the leaves; the
 *  base shape stays small. */
export interface ModeCandidate {
	mode: TransportMode;
	/** Free-form label for the way the candidate is "on" — typically
	 *  a road name, line name, or station-pair string. Optional
	 *  because some candidates (e.g. "stationary" without a known
	 *  amenity) don't carry one. */
	wayName?: string;
	/** Distance from the GPS trajectory to the way's geometry, in
	 *  metres. Set by the candidate generator when it picks a
	 *  specific OSM way to represent. Read by the osm-distance
	 *  factor; null/undefined means "no distance to score against"
	 *  and the factor returns null. */
	wayDistanceM?: number;
	/** OSM way subtype the candidate is attached to, in OSM's
	 *  vocabulary: highway subtype ("motorway", "primary",
	 *  "footway", "cycleway", ...), railway subtype ("rail",
	 *  "subway", "light_rail", "tram", ...), waterway subtype
	 *  ("river", "canal", ...), aeroway subtype ("runway",
	 *  "taxiway", "aerodrome", ...). Read by the mode-coherence
	 *  factor for mode↔way-class consistency. */
	waySubtype?: string;
}

/** Everything a factor might want to consult. Each field is optional
 *  because most factors only need a few of them; the consumer fills
 *  in what's available and the factor returns null if its required
 *  inputs are missing. */
export interface FactorContext {
	/** Per-window scoring features (the inputs to the existing
	 *  Gaussian range-score in segments.ts). Preferred input for
	 *  the speed-emission factor when available. */
	windowFeatures?: WindowFeatures;
	/** Aggregate segment speed in km/h. Fallback for speed-emission
	 *  when WindowFeatures isn't available — e.g. when refineMode
	 *  is called with just (originalMode, speedKmh, ways) and the
	 *  full feature set is upstream. Coarser than WindowFeatures but
	 *  enough to discriminate walking from vehicular modes. */
	speedKmh?: number;
	/** Aggregated per-segment biometric observation (hr/cadence/speed).
	 *  Required by the biometric-ll factor. */
	biometricObs?: MinuteObservation;
	/** Per-user per-mode biometric signatures from `mode_biometrics`.
	 *  Required by the biometric-ll factor; loaded once per call to
	 *  the consumer and passed unchanged through context. */
	modeStats?: readonly ModeStats[];
	/** The segment's pre-refinement mode — what the GPS-feature
	 *  classifier in `segments.ts` decided before refineMode ran.
	 *  Read by the classifier-prior factor to award stickiness to
	 *  the original classification scaled by the upstream
	 *  `confidenceMargin`. Optional because non-velocity-pipeline
	 *  consumers may not have a meaningful "original" mode. */
	originalMode?: TransportMode;
	/** The upstream classifier's margin between the chosen mode and
	 *  the runner-up, in nats (segments.ts records 0 when ambiguous
	 *  and a large finite number when the classifier was clearly
	 *  preferring one mode). Read by the classifier-prior factor —
	 *  high margin → strong stickiness bonus on the original mode. */
	confidenceMargin?: number;
	/** Mean distance (metres) from segment sample-points to the nearest
	 *  rail-only OSM way (railway with subtype in rail / subway /
	 *  light_rail; tram excluded — mixed traffic). Null when no sample
	 *  point had any rail-only way in range. Read by the rail-corridor
	 *  factor to score train candidates against driving candidates
	 *  when both could fit the speed profile. */
	meanRailDistM?: number | null;
	/** Mean distance (metres) from segment sample-points to the
	 *  nearest drivable highway (motorway through unclassified +
	 *  living_street; cycleway/footway/path excluded). Null when no
	 *  sample point had any drivable road in range. Companion to
	 *  meanRailDistM for the rail-corridor log-ratio. */
	meanDrivableRoadDistM?: number | null;
}

export interface FactorScore {
	/** Stable identifier so the consumer can group/log/attribute
	 *  contributions. Matches the file name in the factors/ directory
	 *  by convention. */
	name: string;
	/** Log-likelihood in nats. Positive = candidate is consistent
	 *  with this factor's evidence; negative = inconsistent. The
	 *  sum across all factors for a candidate is the candidate's
	 *  total log-posterior, up to a normalising constant. */
	score: number;
	/** Human-readable explanation suitable for the Phase 3 UI
	 *  detail panel. Should describe *why* the factor scored this
	 *  way, not just the score value. */
	rationale: string;
}

/** A factor is a pure function. Async factors are not yet supported
 *  — if a factor needs DB or network data, the data should be
 *  pre-fetched and stuffed into `FactorContext` by the consumer. */
export type Factor = (candidate: ModeCandidate, ctx: FactorContext) => FactorScore | null;

/** A ModeCandidate that has been run through the factor stack. The
 *  `factors` array carries every factor that contributed (non-null
 *  returns); `totalScore` is their sum. Forward-load-bearing for the
 *  Phase 3 explanation UI — the panel reads this exact shape. */
export interface ScoredCandidate extends ModeCandidate {
	factors: FactorScore[];
	totalScore: number;
}

/** Aggregator output. The `best` is the highest-total scored
 *  candidate; `alternatives` is the remaining candidates sorted
 *  descending by total score. `margin` is `best.totalScore -
 *  alternatives[0].totalScore` (or +Infinity if no alternatives) —
 *  used by downstream confidence reporting and by the (eventual)
 *  uncertainty-aware UI badge.
 *
 *  Distinct from the legacy `ModeRefinement` in `osm.ts` (mode +
 *  confidence + reason + wayName) which `refineMode` currently
 *  returns. The cutover described in
 *  `docs/proposals/2026-05-scored-classification.md` Phase 1 has
 *  refineMode return this shape instead. */
export interface ScoredRefinement {
	best: ScoredCandidate;
	alternatives: ScoredCandidate[];
	margin: number;
}
