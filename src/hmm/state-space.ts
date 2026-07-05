/**
 * HMM state-space enumeration.
 *
 * The hidden state at each minute is a `(mode, place, line)` tuple
 * with structural constraints — not every combination is valid:
 *
 *   - `mode = stationary`: `placeId` is a `focus_places.id` or `null`
 *     (off-network); `lineName` is always `null`.
 *   - `mode = train`: `lineName` is a named rail line or
 *     `"unknown_rail"` (catch-all for rides outside known lines);
 *     `placeId` is `null` (the rail run is in transit).
 *   - `mode ∈ {walking, cycling, driving, plane}`: `placeId` and
 *     `lineName` both `null`.
 *   - `mode = unknown`: `placeId` and `lineName` both `null` —
 *     carryover from the segment-level honest-gaps mode for
 *     unobserved minutes.
 *
 * For an MVP user the reachable subspace is ~20-25 states (top-10
 * focus places + 5-6 named lines + 5 movement modes + the
 * unknown_rail / off-network backbone). Bootstrap discovery
 * (mining the user's actual visited places + travelled lines from
 * heuristic-pipeline labels) happens in the caller; this module
 * just enumerates the cartesian product with constraints.
 *
 * Pure function. No DB, no I/O, no globals.
 */

import type { TransportMode } from "../geo/segments.js";

/** A single HMM state. */
export interface State {
	mode: TransportMode;
	/** `focus_places.id` when `mode === "stationary"` and the user is
	 *  at a known place; `null` for off-network stationary or for any
	 *  moving mode. */
	placeId: number | null;
	/** Named rail line when `mode === "train"`; `"unknown_rail"` for
	 *  the catch-all rail-but-not-in-known-set state; `null` for any
	 *  non-train mode.
	 *
	 *  In Phase 1 of the route-aware decoder, train states can also
	 *  carry a specific edge id (see `trainEdgeId`). When `trainEdgeId`
	 *  is non-null, `lineName` is the derived display label (the most
	 *  prominent line membership of that edge, or null for unknown
	 *  rail-on-an-unnamed-way cases). */
	lineName: string | null;
	/** When `mode === "train"`, the specific OSM rail-way id the user
	 *  is traversing (composite `${osm_type}:${osm_id}` from
	 *  RouteGraph). `null` for the legacy line-only train states and
	 *  for all non-train modes. Phase 1 introduces this to ground
	 *  train classification in track geometry — emissions can then
	 *  use the edge's underground attribute, transitions enforce
	 *  graph-adjacency, and route-rail-evidence becomes a structural
	 *  property of the state rather than a per-line lookup. */
	trainEdgeId: string | null;
}

/** Minimal focus-place identity needed for state enumeration. The
 *  HMM doesn't care about coordinates here — those come in via the
 *  emission model, which looks them up by id. */
export interface FocusPlaceRef {
	id: number;
	displayName: string | null;
}

/** Minimal route-edge identity needed for state enumeration. The
 *  HMM doesn't care about coordinates / geometry / underground
 *  status here — those come in via the emission and transition
 *  models, which look them up by id. */
export interface RouteEdgeRef {
	id: string;
	/** Display line name derived from the edge's
	 *  `lineMemberships`. The caller picks the convention — typically
	 *  the most prominent / first membership, or null if the edge
	 *  has no line tag. */
	lineName: string | null;
}

export interface BuildStateSpaceInput {
	focusPlaces: readonly FocusPlaceRef[];
	/** Legacy: line-only train states. One `train @ lineName` state
	 *  per entry, plus an `unknown_rail` catch-all. Used when
	 *  `railEdges` is empty. */
	knownLines: readonly string[];
	/** Phase 1 route-aware train states. One `train @ edgeId` state
	 *  per entry (carrying lineName as a derived display label). When
	 *  this is non-empty, the line-only train states from
	 *  `knownLines` are skipped — the edge-grained states subsume
	 *  them. The `unknown_rail` catch-all is still emitted regardless,
	 *  since it represents "rail-but-no-specific-edge-evidence." */
	railEdges?: readonly RouteEdgeRef[];
}

/** Stable string key for a state — used as a Map key or
 *  transition/emission lookup index. Same key in, same string out;
 *  distinct states produce distinct keys. */
export function stateKey(s: State): string {
	if (s.mode === "stationary") return `stationary|${s.placeId ?? "none"}`;
	if (s.mode === "train") {
		if (s.trainEdgeId !== null) return `train|${s.trainEdgeId}`;
		return `train|${s.lineName ?? "unknown_rail"}`;
	}
	return s.mode;
}

const MOVEMENT_MODES: readonly TransportMode[] = ["walking", "cycling", "driving", "plane", "unknown"];

export function buildStateSpace(input: BuildStateSpaceInput): State[] {
	const states: State[] = [];
	const seen = new Set<string>();

	function push(s: State): void {
		const key = stateKey(s);
		if (seen.has(key)) return;
		seen.add(key);
		states.push(s);
	}

	// Movement modes (no place, no line, no edge).
	for (const mode of MOVEMENT_MODES) {
		push({ mode, placeId: null, lineName: null, trainEdgeId: null });
	}

	// Off-network stationary (the user is stationary somewhere not in
	// their focus_places set — an unfamiliar café, a friend's flat).
	push({ mode: "stationary", placeId: null, lineName: null, trainEdgeId: null });

	// One stationary state per focus place.
	for (const p of input.focusPlaces) {
		push({ mode: "stationary", placeId: p.id, lineName: null, trainEdgeId: null });
	}

	// Train states: prefer per-edge states (Phase 1 route-aware
	// decoder) when railEdges is supplied; fall back to per-line
	// states otherwise. The unknown_rail catch-all is always emitted.
	const edges = input.railEdges ?? [];
	if (edges.length > 0) {
		for (const e of edges) {
			push({ mode: "train", placeId: null, lineName: e.lineName, trainEdgeId: e.id });
		}
	} else {
		for (const lineName of input.knownLines) {
			push({ mode: "train", placeId: null, lineName, trainEdgeId: null });
		}
	}
	push({ mode: "train", placeId: null, lineName: "unknown_rail", trainEdgeId: null });

	return states;
}
