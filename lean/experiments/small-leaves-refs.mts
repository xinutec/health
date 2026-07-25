/**
 * V8 reference values for the last small pure leaves before the orchestration
 * tier:
 *
 *   `passes/repair-handoff.ts`      — `repairVehicleHandoff`
 *   `passes/vehicle-identity.ts`    — `resolveVehicleIdentity`
 *   `current-place.ts`              — `placeLabel` / `isNamedPlace` / `pickCurrentPlace`
 *   `focus-places-identity.ts`      — `matchClusters`
 *   `route-graph.ts` (leftovers)    — `isUnderground` / `geometryLengthM`
 *
 * The first four are exported and drive directly. The route-graph pair is
 * module-PRIVATE — the same situation as episode-geometry's three helpers — so
 * they are driven through `buildRouteGraph`, whose per-edge `attrs.underground`
 * and `attrs.lengthM` are exactly their outputs. Each raw line below is shaped
 * to isolate ONE underground convention (tunnel / layer / covered / subway tag /
 * subway subtype), plus the controls that make the gate meaningful — including a
 * THIRD value for `covered`/`subway`, which is the only input separating their
 * `=== "yes"` test from `tunnel`'s `!== "no"`.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/small-leaves-refs.mts
 */

import type { EnrichedSegment } from "../../src/geo/enriched-segment.js";
import { pickCurrentPlace, placeLabel, isNamedPlace } from "../../src/geo/current-place.js";
import { matchClusters } from "../../src/geo/focus-places-identity.js";
import { repairVehicleHandoff } from "../../src/geo/passes/repair-handoff.js";
import { resolveVehicleIdentity } from "../../src/geo/passes/vehicle-identity.js";
import { buildRouteGraph, type RawOsmLine } from "../../src/geo/route-graph.js";
import type { TransportMode } from "../../src/geo/segments.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

/* ------------------------------------------------------------------ */
/* 1. repairVehicleHandoff                                            */
/* ------------------------------------------------------------------ */

/** Minimal EnrichedSegment: only the fields the two passes read. */
function seg(
	startTs: number,
	endTs: number,
	mode: TransportMode,
	extra: Partial<EnrichedSegment> = {},
): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode,
		confidence: 1,
		distanceM: 0,
		avgSpeedKmh: 0,
		maxSpeedKmh: 0,
		pointCount: 5,
		...extra,
	} as EnrichedSegment;
}

const TRAIN = "Euston Square → Wembley Park · Metropolitan Line";

/** Every case is described by what it should prove, then dumped. */
function handoffCases(): Record<string, EnrichedSegment[]> {
	return {
		// The 2026-06-18 case: an underpass stretch snapped to driving, flush
		// against the identified ride. Absorbed forward into the train.
		drivingThenTrain: [seg(100, 200, "driving"), seg(200, 400, "train", { wayName: TRAIN })],
		// Mirror image — absorbed backward. The train keeps its identity and its
		// span grows to cover both.
		trainThenDriving: [seg(100, 300, "train", { wayName: TRAIN }), seg(300, 380, "driving")],
		// A run: driving → train → driving collapses to ONE train in a single
		// left-to-right fold, because the fold re-tests the already-merged head.
		run: [
			seg(100, 200, "driving"),
			seg(200, 400, "train", { wayName: TRAIN }),
			seg(400, 500, "driving", { pointCount: 3 }),
		],
		// A bare-line train fragment (no " → " pair) is NOT identified, so it is
		// the side absorbed — the Jubilee-fragment case.
		bareLineFragment: [
			seg(100, 200, "train", { wayName: "Jubilee Line" }),
			seg(200, 400, "train", { wayName: TRAIN }),
		],
		// Two identified trains = a real interchange. Left alone.
		twoIdentified: [
			seg(100, 200, "train", { wayName: "A → B · Line" }),
			seg(200, 400, "train", { wayName: TRAIN }),
		],
		// Neither identified: no journey to absorb into.
		neitherIdentified: [seg(100, 200, "driving"), seg(200, 400, "driving")],
		// A 121 s gap is one second past the contiguity bar — the alighting could
		// have happened in it, so this is park-and-ride, not a hand-off.
		gapJustOver: [seg(100, 200, "driving"), seg(321, 400, "train", { wayName: TRAIN })],
		// 120 s exactly is still contiguous (the test is `>`).
		gapExactlyAtBar: [seg(100, 200, "driving"), seg(320, 400, "train", { wayName: TRAIN })],
		// Walking is not a vehicle mode, so the pair never qualifies.
		walkBetween: [seg(100, 200, "walking"), seg(200, 400, "train", { wayName: TRAIN })],
		// `refinedMode` wins over `mode` (effectiveMode), so a leg the classifier
		// called stationary but a pass refined to driving DOES absorb.
		refinedModeWins: [
			seg(100, 200, "stationary", { refinedMode: "driving" }),
			seg(200, 400, "train", { wayName: TRAIN }),
		],
		// An existing refinedReason is preserved and the new one appended.
		existingReason: [
			seg(100, 200, "driving"),
			seg(200, 400, "train", { wayName: TRAIN, refinedReason: "earlier note" }),
		],
		// …but an EMPTY one is falsy, so no "; " separator is emitted.
		emptyReason: [seg(100, 200, "driving"), seg(200, 400, "train", { wayName: TRAIN, refinedReason: "" })],
		// `vehicle` — what `resolveVehicleIdentity` emits — is deliberately NOT in
		// VEHICLE_MODES, so an unidentified ride is never absorbed into a train.
		// (Nor is `bus`, which is a `driving` + vehicleKind refinement anyway.)
		vehicleNotAbsorbed: [seg(100, 200, "vehicle"), seg(200, 400, "train", { wayName: TRAIN })],
		// Cycling and plane are vehicle modes too.
		cyclingIntoTrain: [seg(100, 200, "cycling"), seg(200, 400, "train", { wayName: TRAIN })],
		empty: [],
		single: [seg(100, 200, "driving")],
	};
}

for (const [name, input] of Object.entries(handoffCases())) {
	const out = repairVehicleHandoff(input);
	show(
		`handoff.${name}`,
		out.map((s) => ({
			startTs: s.startTs,
			endTs: s.endTs,
			mode: s.mode,
			refinedMode: s.refinedMode ?? null,
			wayName: s.wayName ?? null,
			pointCount: s.pointCount,
			refinedReason: s.refinedReason ?? null,
		})),
	);
}

/* ------------------------------------------------------------------ */
/* 2. resolveVehicleIdentity                                          */
/* ------------------------------------------------------------------ */

function identityCases(): Record<string, EnrichedSegment[]> {
	const claimedPath = [{ lat: 51.52, lon: -0.13, ts: 100 }];
	return {
		// The 2026-07-12 bug: the trailing unclaimed placeholder is demoted.
		trailingUnclaimed: [seg(0, 100, "stationary"), seg(100, 200, "driving")],
		// A finished ride — something follows it — keeps whatever the cascade
		// concluded, however thinly evidenced (the two confirmed taxis).
		notTrailing: [seg(100, 200, "driving"), seg(200, 300, "stationary")],
		// Any claim at all exempts it: a matched road…
		claimedByPath: [seg(100, 200, "driving", { matchedPath: claimedPath })],
		// …a named street…
		claimedByWayName: [seg(100, 200, "driving", { wayName: "Euston Road" })],
		// …or an identified bus route.
		claimedByVehicleKind: [seg(100, 200, "driving", { vehicleKind: "bus" })],
		// An EMPTY matchedPath is not a claim (`?.length` is 0, falsy).
		emptyMatchedPath: [seg(100, 200, "driving", { matchedPath: [] })],
		// An EMPTY wayName is not a claim either ("" is falsy).
		emptyWayName: [seg(100, 200, "driving", { wayName: "" })],
		// Non-driving trailing legs are untouched — this pass only doubts the
		// `driving` placeholder.
		trailingTrain: [seg(100, 200, "train", { wayName: TRAIN })],
		trailingWalking: [seg(100, 200, "walking")],
		// effectiveMode again: a leg refined TO driving is a candidate…
		refinedToDriving: [seg(100, 200, "stationary", { refinedMode: "driving" })],
		// …and one refined AWAY from driving is not.
		refinedAwayFromDriving: [seg(100, 200, "driving", { refinedMode: "train" })],
		// An existing refinedReason is REPLACED, not appended to (unlike the
		// hand-off pass) — the whole record is respread with a fresh reason.
		existingReason: [seg(100, 200, "driving", { refinedReason: "earlier note" })],
		empty: [],
	};
}

for (const [name, input] of Object.entries(identityCases())) {
	const out = resolveVehicleIdentity(input);
	show(
		`identity.${name}`,
		out.map((s) => ({
			startTs: s.startTs,
			mode: s.mode,
			refinedMode: s.refinedMode ?? null,
			refinedReason: s.refinedReason ?? null,
		})),
	);
}

/* ------------------------------------------------------------------ */
/* 3. current-place                                                   */
/* ------------------------------------------------------------------ */

const LABEL_CASES: [string | null, string | null][] = [
	["Home", "Gym"], // a specific auto-name wins outright
	["Stay", "PureGym Wembley"], // the generic "Stay" must not mask a venue
	["Stay", null], // nothing better — "Stay" comes back through the ?? chain
	[null, "Sainsbury's"],
	[null, null], // the "Place" last resort
	["", null], // "" is not the STAY sentinel, so it wins as a displayName
];
for (const [dn, al] of LABEL_CASES) {
	show(`placeLabel(${JSON.stringify(dn)},${JSON.stringify(al)})`, placeLabel(dn, al));
	show(`isNamedPlace(${JSON.stringify(dn)},${JSON.stringify(al)})`, isNamedPlace(dn, al));
}

const PLACES = [
	{ id: 1, displayName: "Home", amenityLabel: null, centroidLat: 51.52, centroidLon: -0.13 },
	// ~78 m east of Home — inside the radius, so the two compete on distance.
	{ id: 2, displayName: "Stay", amenityLabel: "PureGym", centroidLat: 51.52, centroidLon: -0.1288749 },
	{ id: 3, displayName: null, amenityLabel: null, centroidLat: 51.6, centroidLon: -0.13 },
];

const FIX_CASES: Record<string, { lat: number; lon: number }> = {
	// Dead on Home.
	atHome: { lat: 51.52, lon: -0.13 },
	// Between the two: nearer the gym, so the gym wins on distance even though
	// Home is a "better" label — this is a NEAREST rule, not a rank rule.
	nearerGym: { lat: 51.52, lon: -0.1291 },
	// Everything out of range.
	nowhere: { lat: 51.4, lon: -0.4 },
	// Just inside 100 m of Home and nothing else — pins the rounding of
	// `distanceM` (Math.round) as well as the radius test.
	edgeOfHome: { lat: 51.5208, lon: -0.13 },
	// Just outside.
	pastEdgeOfHome: { lat: 51.5210, lon: -0.13 },
};
for (const [name, fix] of Object.entries(FIX_CASES)) {
	show(`pickCurrentPlace.${name}`, pickCurrentPlace(fix, PLACES));
}
show("pickCurrentPlace.noPlaces", pickCurrentPlace({ lat: 51.52, lon: -0.13 }, []));
// EXACTLY 100 m from Home — the radius test is `d > radius`, so the boundary is
// INCLUDED. Real coordinates almost never land on it (adjacent doubles here
// straddle 100.0 by ~8e-10 m), so this pair was found by search; without it the
// `>` vs `>=` choice is unpinned. Home only, so nothing else can win.
show(
	"pickCurrentPlace.exactlyAtRadius",
	pickCurrentPlace({ lat: 51.52089857309002, lon: -0.129941044 }, [PLACES[0]]),
);

/* ------------------------------------------------------------------ */
/* 4. matchClusters                                                   */
/* ------------------------------------------------------------------ */

const OLD = [
	{ id: 10, centroidLat: 51.52, centroidLon: -0.13, firstSeenTs: 1000 },
	{ id: 11, centroidLat: 51.53, centroidLon: -0.13, firstSeenTs: 2000 },
	{ id: 12, centroidLat: 51.7, centroidLon: 0.4, firstSeenTs: 500 },
];

const CLUSTER_CASES: Record<string, { old: typeof OLD; nw: { centroidLat: number; centroidLon: number }[] }> = {
	// Straight one-to-one: two survive, the far one is deleted.
	simple: {
		old: OLD,
		nw: [
			{ centroidLat: 51.5201, centroidLon: -0.1301 },
			{ centroidLat: 51.5299, centroidLon: -0.13 },
		],
	},
	// SPLIT: one old place, two new clusters both in range. Greedy takes the
	// closer; the other becomes a fresh insert.
	split: {
		old: [OLD[0]],
		nw: [
			{ centroidLat: 51.5205, centroidLon: -0.13 },
			{ centroidLat: 51.5201, centroidLon: -0.13 },
		],
	},
	// MERGE: two old places, one new cluster between them. The nearer old id is
	// preserved, the other deleted.
	merge: {
		old: [OLD[0], { id: 11, centroidLat: 51.5210, centroidLon: -0.13, firstSeenTs: 2000 }],
		nw: [{ centroidLat: 51.5205, centroidLon: -0.13 }],
	},
	// TIEBREAK: the secondary sort key is only observable on an EXACT float tie,
	// so the two old places sit on the SAME coordinates. Mirroring them
	// north/south would NOT do it — `51.5205 - 51.52` and `51.52 - 51.5195` are
	// different doubles, so that pair is decided on distance, not age.
	tiebreak: {
		old: [
			{ id: 20, centroidLat: 51.5201, centroidLon: -0.13, firstSeenTs: 9000 },
			{ id: 21, centroidLat: 51.5201, centroidLon: -0.13, firstSeenTs: 1 },
		],
		nw: [{ centroidLat: 51.52, centroidLon: -0.13 }],
	},
	// The reverse order, to prove the winner is the OLDER place and not simply
	// the first-generated pair (which a stable sort alone would give).
	tiebreakReversed: {
		old: [
			{ id: 20, centroidLat: 51.5201, centroidLon: -0.13, firstSeenTs: 1 },
			{ id: 21, centroidLat: 51.5201, centroidLon: -0.13, firstSeenTs: 9000 },
		],
		nw: [{ centroidLat: 51.52, centroidLon: -0.13 }],
	},
	// Same coords AND same firstSeenTs: a total tie, decided by the stable sort
	// keeping generation order (old-index outer), so the FIRST old id wins.
	totalTie: {
		old: [
			{ id: 20, centroidLat: 51.5201, centroidLon: -0.13, firstSeenTs: 500 },
			{ id: 21, centroidLat: 51.5201, centroidLon: -0.13, firstSeenTs: 500 },
		],
		nw: [{ centroidLat: 51.52, centroidLon: -0.13 }],
	},
	// The mirrored pair from the first attempt, kept as what it actually is: a
	// DISTANCE decision on two near-but-unequal doubles, where the younger place
	// wins because it is (barely) closer.
	nearMirrorNotATie: {
		old: [
			{ id: 20, centroidLat: 51.5205, centroidLon: -0.13, firstSeenTs: 9000 },
			{ id: 21, centroidLat: 51.5195, centroidLon: -0.13, firstSeenTs: 1 },
		],
		nw: [{ centroidLat: 51.52, centroidLon: -0.13 }],
	},
	// Everything out of radius: all new, all old deleted.
	allFresh: { old: OLD, nw: [{ centroidLat: 40, centroidLon: 0 }] },
	// EXACTLY 150 m apart — the radius test is `d <= radius`, so the boundary
	// MATCHES. Same story as the presence radius: found by search, because the
	// doubles either side of 150.0 are ~8e-10 m apart.
	exactlyAtRadius: {
		old: [{ id: 30, centroidLat: 51.52, centroidLon: -0.13, firstSeenTs: 1 }],
		nw: [{ centroidLat: 51.5213489816655, centroidLon: -0.129997724 }],
	},
	noOld: { old: [], nw: [{ centroidLat: 51.52, centroidLon: -0.13 }] },
	noNew: { old: OLD, nw: [] },
};
for (const [name, c] of Object.entries(CLUSTER_CASES)) {
	show(`matchClusters.${name}`, matchClusters(c.old, c.nw));
}

/* ------------------------------------------------------------------ */
/* 5. route-graph: isUnderground + geometryLengthM                    */
/* ------------------------------------------------------------------ */

let nextId = 1n;
function line(subtype: string | null, tags: Record<string, string>, coords: [number, number][]): RawOsmLine {
	return {
		osm_id: nextId++,
		osm_type: "way",
		feature_type: "railway",
		subtype,
		name: null,
		tags_json: JSON.stringify(tags),
		// WKT is `lon lat`.
		geom: `LINESTRING(${coords.map(([lat, lon]) => `${lon} ${lat}`).join(",")})`,
	};
}

// A 3-vertex track so `geometryLengthM` sums more than one leg.
const TRACK: [number, number][] = [
	[51.52, -0.13],
	[51.53, -0.13],
	[51.53, -0.11],
];

const LINES: RawOsmLine[] = [
	line(null, { tunnel: "yes" }, TRACK),
	line(null, { tunnel: "building_passage" }, TRACK), // any non-"no" tunnel value
	line(null, { tunnel: "no" }, TRACK), // control
	line(null, { layer: "-1" }, TRACK),
	line(null, { layer: "1" }, TRACK), // control
	line(null, { layer: "not-a-number" }, TRACK), // Number() → NaN, not < 0
	line(null, { covered: "yes" }, TRACK),
	line(null, { covered: "no" }, TRACK), // control — only "yes" counts
	// Neither "yes" nor "no": the case that separates `=== "yes"` from
	// `!== "no"`. Without it, `covered`/`subway` would be indistinguishable from
	// the `tunnel` rule.
	line(null, { covered: "roof" }, TRACK),
	line(null, { subway: "yes" }, TRACK),
	line(null, { subway: "maybe" }, TRACK),
	line("subway", {}, TRACK), // subtype alone
	line(null, {}, TRACK), // nothing at all
	// Length edge cases: a single-vertex way (no legs) and a two-vertex way.
	line(null, {}, [[51.52, -0.13]]),
	line(null, {}, [
		[51.52, -0.13],
		[51.52, -0.129],
	]),
];

const graph = buildRouteGraph(LINES, []);
for (const l of LINES) {
	const e = graph.edges.get(`${l.osm_type}:${l.osm_id}`);
	show(`routeGraph.${l.osm_id}`, {
		subtype: l.subtype,
		tags: l.tags_json,
		underground: e?.attrs.underground ?? null,
		lengthM: e?.attrs.lengthM ?? null,
	});
}
