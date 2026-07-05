/**
 * The pipeline's central segment type.
 *
 * `EnrichedSegment` is the unit every classification pass reads and rewrites:
 * a raw {@link TrackSegment} plus the place / way / mode / biometric / geometry
 * annotations the cascade attaches as it runs. It lives in its own module —
 * rather than in `velocity.ts` where the cascade is orchestrated — so the
 * individual passes (`./passes/*`) can depend on the *shape* of a segment
 * without importing the 2700-line orchestrator (which in turn imports them).
 * That keeps the dependency graph a DAG: passes → enriched-segment, orchestrator
 * → passes, with no back-edge.
 *
 * Types only; no runtime code.
 */

import type { BiometricEnrichment } from "./biometrics.js";
import type { SnappedPoint } from "./rail-snap.js";
import type { TrackSegment, TransportMode } from "./segments.js";

export interface EnrichedSegment extends TrackSegment {
	place?: string; // human-readable place name (for stationary segments)
	/** Provenance: the focus place whose posterior won this stay's label
	 *  (`pickBestPlace` winner). Absent when the label came from OSM
	 *  lookup at a place the prior didn't recognise. Lets late passes
	 *  tell an established personal destination from an incidental stop —
	 *  the interchange labeller must not rename a stay at a many-visit
	 *  focus place after a nearby station (the 2026-07-02 UCLH →
	 *  "Warren Street" case, user-confirmed). Typed like `KnownPlace.id`. */
	focusPlaceId?: string | number;
	city?: string; // city/town/village (for stationary segments) — frontend groups consecutive same-city segments
	/** Mean lat/lon of this stay's GPS fixes. Attached for stationary
	 *  segments by `attachStayCentroids` so the co-location merge can compare
	 *  stays and re-resolve a merged stay's place from its combined centre. */
	centroidLat?: number;
	centroidLon?: number;
	wayName?: string; // road/rail name (for moving segments)
	/** Stop-pattern refinement of a driving segment (task #247): "bus"
	 *  when the leg's boarding wait + mid-leg dwells coincide with
	 *  bus_stop nodes. The mode stays "driving" internally; the
	 *  day-state layer renders the kind. */
	vehicleKind?: "bus";
	refinedMode?: TransportMode; // OSM-refined transport mode (may differ from heuristic mode)
	refinedReason?: string;
	displayTz?: string; // IANA tz to render the segment's timestamps in (frontend uses this instead of browser tz)
	biometrics?: BiometricEnrichment;
	snappedPath?: SnappedPoint[]; // derived: this train segment drawn on the OSM rail track — see annotateSnappedPaths
	/** Derived: this road-vehicle leg (driving / bus / cycling) snapped onto
	 *  the OSM street network so the map draws it on the road instead of the
	 *  raw GPS zigzag through buildings. Attached by `annotateRoadMatches`
	 *  (#261); `undefined` when the leg could not be confidently matched, in
	 *  which case the map falls back to the raw track. Each point carries an
	 *  interpolated timestamp like `snappedPath`. */
	matchedPath?: SnappedPoint[];
	/** Derived: this WALKING leg map-matched onto the OSM walkable network
	 *  (footway / path / pedestrian / residential…) so the map draws it on the
	 *  pavement instead of the soft-smoothed line cutting across buildings.
	 *  Attached by `annotateWalkMatches` (pedestrian-match); `undefined` when the
	 *  leg is off-network or the graph is too fragmented to route, in which case
	 *  the map falls back to the raw track. Each point carries an interpolated
	 *  timestamp like `matchedPath`. */
	walkMatchedPath?: SnappedPoint[];
	/** Fraction of the moving segment's sampled points whose nearest
	 *  drivable road is closer than any rail-only way (a sample with a
	 *  road but no rail in range counts as road-nearest — there is no
	 *  track there). Computed at enrichment from the same `nearbyWays`
	 *  samples the OSM lookup already takes, so it costs no extra query.
	 *  `undefined` when too few samples carry usable proximity. The HSMM
	 *  movement→train override weighs this against the HSMM's line
	 *  support — a road-following trace makes a train improbable, not
	 *  impossible. See `decideHsmmTrainOverride`. */
	roadCorridorFraction?: number;
}
