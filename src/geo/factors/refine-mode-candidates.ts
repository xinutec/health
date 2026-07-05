/**
 * Candidate generator for `refineMode`.
 *
 * Minimum-viable Phase 1 generator (per
 * `docs/proposals/2026-05-scored-classification.md`): turns the
 * existing `NearbyWay[]` + segment's classifier `originalMode`
 * into a list of `ModeCandidate` for the factor aggregator.
 *
 * Design:
 *
 *   - For each NearbyWay, emit one candidate per *plausibly
 *     compatible* mode. A primary road is compatible with driving,
 *     walking, and cycling; a footway is compatible with walking
 *     only; a railway is compatible with train only; etc.
 *   - Always include a fallback candidate carrying `originalMode`
 *     with no way info, so the consumer never receives an empty list
 *     and the labeller falls back gracefully when no OSM way is in
 *     range (the "in the middle of an unmapped square" case).
 *   - The generator does NOT decide which candidate wins — that's
 *     the factor aggregator's job. The generator is dumb about
 *     speed and other context; it just enumerates the candidate
 *     space.
 *
 * Not handled here (intentionally):
 *
 *   - `annotateRailRuns` candidate enumeration (alternative
 *     boarding/alighting station pairs). Harder problem and
 *     today's rail-run rule fixes already constrain it; per the
 *     third opus review, defer until refineMode cutover is proven.
 *   - Boat / waterway modes — not in the production mode set yet.
 *     waterway ways are currently dropped.
 */

import { isCadenceImplausibleForMode, type MinuteObservation, type ModeStats } from "../mode-biometrics.js";
import type { NearbyWay } from "../osm.js";
import type { TransportMode } from "../segments.js";
import type { ModeCandidate } from "./types.js";

const DRIVEABLE_HIGHWAY_SUBTYPES = new Set([
	"motorway",
	"trunk",
	"primary",
	"secondary",
	"tertiary",
	"residential",
	"service",
	"unclassified",
	"track",
	"living_street",
]);
const PEDESTRIAN_HIGHWAY_SUBTYPES = new Set(["footway", "path", "pedestrian", "bridleway", "steps"]);

function modesForWay(way: NearbyWay): TransportMode[] {
	if (way.type === "railway") return ["train"];
	if (way.type === "aeroway") {
		if (way.subtype === "runway" || way.subtype === "taxiway") return ["plane"];
		return ["stationary"];
	}
	if (way.type === "highway") {
		if (way.subtype === "cycleway") return ["cycling"];
		if (PEDESTRIAN_HIGHWAY_SUBTYPES.has(way.subtype)) return ["walking"];
		if (DRIVEABLE_HIGHWAY_SUBTYPES.has(way.subtype)) return ["driving", "walking", "cycling"];
	}
	return [];
}

/**
 * Enumerate the plausible labelling space for one set of nearby ways.
 *
 * The returned list always contains at least the `originalMode`
 * fallback candidate (so downstream code can rely on a non-empty
 * result).
 *
 * Per-mode dedup: when both a named and an unnamed candidate of the
 * same mode exist, the unnamed one is dropped. This handles the OSM-
 * data-duplication case where a footway (often unnamed) and the road
 * it parallels (named) are geographically the same physical location
 * — a user walking on the pavement of Barn Rise is on both ways at
 * once in OSM's model. Without the filter, the unnamed footway wins
 * the factor sum (mode-coherence +1 walking-on-footway vs 0
 * walking-on-residential), but produces an empty wayName in the
 * rendered timeline. The named road, when present, is the meaningful
 * human-readable label. When only unnamed candidates exist (e.g., a
 * footpath through a park with no nearby named road within range),
 * they're kept — falling back gracefully to no label rather than
 * mis-labelling with a distant road.
 */
/** Optional per-segment biometric context. When supplied, the
 *  generator drops way-attached candidates whose mode is
 *  biologically implausible given the user's per-mode cadence
 *  distribution — the candidate-filter form of the legacy
 *  `vetoImplausibleCadence` cascade gate. The fallback candidate
 *  is always kept regardless of biometric veto (it's the consumer's
 *  last-resort guess and must always exist).
 *
 *  HR-implausibility is **not** filtered here. The legacy
 *  `vetoImplausibleHr` rule applied to all non-stationary modes,
 *  but it over-fires on sitting modes (driving / train / plane):
 *  the user's mined per-mode HR distribution for driving/train
 *  reflects mildly-elevated HR during active commuting, while a
 *  relaxed tube ride sits in resting-HR territory. The 2026-05-23
 *  debug surfaced this as the morning-tube-as-walking regression:
 *  every driving / train candidate was being filtered out by HR,
 *  leaving only catastrophically-poor walking candidates to win.
 *  The `biometric-ll` factor handles the discriminating-by-HR work
 *  as a soft signal, weighted against the joint speed + cadence
 *  evidence — at 61 km/h, walking scores ~-1300 nats biometric-LL
 *  vs driving/train near 0, which the aggregator picks up cleanly
 *  without a binary pre-filter. See
 *  [[feedback-weighted-over-binary]] and [[feedback-model-impossibilities-as-constraints]].
 *
 *  The cadence filter stays because it is scoped (only applies
 *  when speed is below the walking-plausible ceiling) and catches
 *  the specific "walking with cycling label" case where cadence
 *  ~100 spm at walking speed unambiguously means walking. */
export interface BiometricContext {
	obs: MinuteObservation;
	stats: readonly ModeStats[];
}

export function generateRefineModeCandidates(
	originalMode: TransportMode,
	ways: readonly NearbyWay[],
	biometric?: BiometricContext,
): ModeCandidate[] {
	const candidates: ModeCandidate[] = [];
	for (const way of ways) {
		const modes = modesForWay(way);
		for (const mode of modes) {
			candidates.push({
				mode,
				wayName: way.name,
				waySubtype: way.subtype,
				wayDistanceM: way.distanceM,
			});
		}
	}
	// Cadence implausibility filter: drop way-attached candidates whose
	// mode is biologically impossible given the segment's cadence
	// observation at walking-plausible speeds. Scoped narrowly — only
	// fires when the speed-veto premise (this could be walking) holds
	// AND cadence is above the walking-band floor for a low-cadence
	// mode. The HR side of the legacy biometric-veto is intentionally
	// not filtered here; see the doc comment above for the
	// over-filtering case that motivated the change.
	const biometricFiltered = biometric
		? candidates.filter(
				(c) => !isCadenceImplausibleForMode(c.mode, biometric.obs.cadence, biometric.obs.speed, biometric.stats),
			)
		: candidates;
	// Drop unnamed candidates of any mode that has at least one named
	// candidate. Same-mode named/unnamed in OSM is overwhelmingly
	// pavement-vs-road or cycleway-vs-road; the named one is what we
	// want to show.
	const modesWithName = new Set<TransportMode>(
		biometricFiltered.filter((c) => c.wayName !== undefined && c.wayName.length > 0).map((c) => c.mode),
	);
	const filtered = biometricFiltered.filter((c) => (c.wayName && c.wayName.length > 0) || !modesWithName.has(c.mode));
	// Fallback: the segment classifier's chosen mode with no way info.
	// Always emitted, never filtered — it's the consumer's last-resort
	// guess and must exist even when biometrics veto its mode (the
	// factor scorer can still apply other factors to discriminate).
	filtered.push({ mode: originalMode });
	return filtered;
}
