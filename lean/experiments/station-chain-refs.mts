/**
 * V8 reference values for `src/hmm/station-chain.ts` — the C4.3 chained-triple
 * station resolver (#672).
 *
 * # Why the whole function, and not its parts
 *
 * `resolveStationChain` is the module's ONLY export. Every scoring term —
 * `slopZPenalty`, `theilSen`, `trajectoryPenalty`, `durationPenalty`,
 * `terminalDwellPenalty`, `chainPenalty` — and every graph helper is private, so
 * the repo's standing technique applies: pin a private helper THROUGH its
 * exported caller rather than adding a test-only export. That is how
 * `episode-geometry`'s three leaves and `tube-hop`'s `findBlackoutHop` were
 * done.
 *
 * The cost is that each case has to be SHAPED so exactly one term decides it,
 * with every other gate passing. `underground-rail` is the warning here: nine of
 * twelve probes came back empty first time because one rejection case failed
 * several conjuncts at once and therefore pinned none of them individually.
 *
 * # The synthetic line
 *
 * A straight west-to-east tube line at lat 51.5 with five evenly-spaced
 * stations, built through the REAL `buildRouteGraph` from WKT — not a
 * hand-assembled `RouteGraph` — so the node keys, the ~150 m station-merge
 * radius, `parseLineMemberships` and `geometryLengthM` are the production ones.
 * A hand-built graph would be a second implementation of the very boundary the
 * roadmap calls a parity hazard.
 *
 * Note `parseLineMemberships` strips the ` Line` suffix to split combined names
 * and then RE-APPENDS it, so an edge named "Test Line" carries the membership
 * "Test Line" — not "Test". Read the tail of that function, not its middle: the
 * first version of this harness used "Test", and all eleven cases below came
 * back empty at once. An empty probe is the cheapest possible finding and the
 * easiest to mistake for a passing one.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/station-chain-refs.mts
 */

import { buildRouteGraph, type RawOsmLine, type RawOsmPoint } from "../../src/geo/route-graph.js";
import type { Observation } from "../../src/hmm/observation.js";
import type { HmmSegment } from "../../src/hmm/persist.js";
import { resolveStationChain } from "../../src/hmm/station-chain.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

/* ------------------------------------------------------------------ */
/* The line                                                            */
/* ------------------------------------------------------------------ */

const LAT = 51.5;
/** Metres per degree of longitude at `LAT`, to the precision this needs. */
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);
/** Station spacing (m) — a realistic central-London inter-station hop, and
 *  comfortably past `MIN_PATH_M` (400) so adjacent pairs are real rides. */
const SPACING_M = 1500;
const lonAt = (i: number): number => (i * SPACING_M) / M_PER_DEG_LON;

const STATIONS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];

const line = (i: number): RawOsmLine => ({
	osm_id: BigInt(1000 + i),
	osm_type: "way",
	feature_type: "rail",
	subtype: "subway",
	name: "Test Line",
	tags_json: JSON.stringify({ railway: "subway", tunnel: "yes" }),
	geom: `LINESTRING(${lonAt(i)} ${LAT}, ${lonAt(i + 1)} ${LAT})`,
});

const stationPoint = (i: number): RawOsmPoint => ({
	osm_id: BigInt(2000 + i),
	osm_type: "node",
	name: STATIONS[i],
	tags_json: JSON.stringify({ railway: "station" }),
	lat: LAT,
	lon: lonAt(i),
});

const rawLines: RawOsmLine[] = [0, 1, 2, 3].map(line);
const rawPoints: RawOsmPoint[] = [0, 1, 2, 3, 4].map(stationPoint);
const graph = buildRouteGraph(rawLines, rawPoints);

// The graph is the substrate for every case below, so its own shape is a
// reference value: a Lean port reading a different node set is not comparable,
// and that difference must be visible here rather than inferred from a
// downstream mismatch.
const named = [...graph.nodes.values()].filter((n) => n.stationName !== undefined);
show(
	"graph.stations",
	named.map((n) => ({ name: n.stationName, lat: n.point.lat, lon: Number(n.point.lon.toFixed(8)) })),
);
show("graph.edgeCount", graph.edges.size);
show("graph.nodeCount", graph.nodes.size);
show(
	"graph.edgeLengthsM",
	[...graph.edges.values()].map((e) => Number(e.attrs.lengthM.toFixed(6))),
);
show(
	"graph.lineMemberships",
	[...new Set([...graph.edges.values()].flatMap((e) => [...e.attrs.lineMemberships]))].sort(),
);

/* ------------------------------------------------------------------ */
/* Observations                                                        */
/* ------------------------------------------------------------------ */

const T0 = 1_750_000_000;
const minute = (i: number): number => T0 + i * 60;

/** An observation row with only the fields the resolver reads carrying signal.
 *  `prevGpsFix` / `nextGpsFix` are the BOOKENDS the anchors fall back to when
 *  no in-band fix exists, so they are set explicitly per case rather than
 *  defaulted — a bookend that appears by accident would silently supply an
 *  anchor the case meant to withhold. */
function obs(
	i: number,
	gps: { lat: number; lon: number } | null,
	bookends: { prev?: { ts: number; lat: number; lon: number }; next?: { ts: number; lat: number; lon: number } } = {},
): Observation {
	return {
		ts: minute(i),
		gps: gps === null ? null : { lat: gps.lat, lon: gps.lon, speedKmh: 0 },
		hr: null,
		cadence: null,
		hourLocal: 9,
		dayOfWeekLocal: 3,
		inBed: false,
		prevGpsFix: bookends.prev ?? null,
		nextGpsFix: bookends.next ?? null,
	};
}

const at = (i: number): { lat: number; lon: number } => ({ lat: LAT, lon: lonAt(i) });

/** A train leg over `[startMin, endMin)` on the synthetic line. */
const trainSeg = (startMin: number, endMin: number): HmmSegment => ({
	startTs: minute(startMin),
	endTs: minute(endMin),
	mode: "train",
	placeId: null,
	lineName: "Test Line",
});

const resolve = (segments: HmmSegment[], observations: Observation[]): unknown =>
	[...resolveStationChain({ segments, observations, routeGraph: graph }).entries()].map(([i, r]) => [
		i,
		r.board,
		r.alight,
	]);

/* ------------------------------------------------------------------ */
/* 1. The clean ride — every term agrees                               */
/* ------------------------------------------------------------------ */

// Alpha → Delta is 4500 m: expected (4.5/32)*60 + 0.8 = 9.24 min, so a 9-minute
// leg sits within a fraction of σ. Fixes at the platform on both sides give
// fresh anchors, and the in-leg fixes ride the track so the trajectory fit
// lands on the boundary stations.
const cleanObs: Observation[] = [
	obs(0, at(0)),
	obs(1, at(0)),
	obs(2, at(0.35)),
	obs(3, at(0.7)),
	obs(4, at(1.05)),
	obs(5, at(1.4)),
	obs(6, at(1.75)),
	obs(7, at(2.1)),
	obs(8, at(2.45)),
	obs(9, at(2.8)),
	obs(10, at(3)),
	obs(11, at(3)),
];
show("clean.ride", resolve([trainSeg(2, 11)], cleanObs));

/* ------------------------------------------------------------------ */
/* 2. Duration DECIDES between two equally-anchored candidates         */
/* ------------------------------------------------------------------ */

// The first attempt at this case just shortened the clean ride and changed
// nothing: a fresh anchor sitting ON Delta scores ~0 while every rival clamps
// at ANCHOR_CLAMP, so the anchor term outweighs any duration difference and the
// probe pinned nothing. Isolating duration means making the anchor INDIFFERENT.
//
// The alight anchor sits midway between Bravo and Charlie — 750 m from each, so
// both take the identical anchor penalty — and one minute stale, which widens σ
// to sqrt(200² + 500²) ≈ 538 m. Staleness is doing real work here: at the fresh
// σ of 200 m both candidates clamp to ANCHOR_CLAMP, and a clamped side fails
// `sidePlausible`'s ABS_ANCHOR_FLOOR, so the margin would never be consulted.
//
// The leg is dark inside, so there are no trajectory or dwell terms, and the
// board side is forced to Alpha. That leaves duration as the only term that can
// separate Alpha→Bravo (1498 m, expected 3.6 min) from Alpha→Charlie (2997 m,
// expected 6.4 min) against an observed 3 minutes.
const durationObs: Observation[] = [
	obs(0, at(0)),
	obs(1, at(0)),
	obs(2, null),
	obs(3, null),
	obs(4, null),
	obs(5, null),
	obs(6, at(1.5)),
];
show("duration.decides", resolve([trainSeg(2, 5)], durationObs));

/* ------------------------------------------------------------------ */
/* 3. Terminal dwell: an in-leg fix parked at the alight candidate     */
/* ------------------------------------------------------------------ */

// The ride reaches Delta at minute 4 of an 11-minute leg and the fixes prove
// it, so Delta as the ALIGHT implies a through-station dwell of 7 minutes.
// `TERMINAL_DWELL_TOL_MIN` is 3 and the z-scale is 1 minute, so this is deep
// past `DWELL_DISQUALIFY`.
const dwellObs: Observation[] = [
	obs(0, at(0)),
	obs(1, at(0)),
	obs(2, at(1)),
	obs(3, at(2)),
	obs(4, at(3)),
	obs(5, at(3)),
	obs(6, at(3)),
	obs(7, at(3)),
	obs(8, at(3)),
	obs(9, at(3)),
	obs(10, at(3)),
	obs(11, at(3)),
	obs(12, at(3)),
	obs(13, at(3)),
];
show("dwell.passedMidLeg", resolve([trainSeg(2, 13)], dwellObs));

/* ------------------------------------------------------------------ */
/* 4. No anchors at all — bookends absent, the leg is fully dark       */
/* ------------------------------------------------------------------ */

// Every candidate on the line is admitted with a flat 0 anchor penalty, so the
// margin gate has nothing to separate the field with and both sides must stay
// null. This is the "wrong is worse than missing" arm.
const darkObs: Observation[] = [obs(0, null), obs(1, null), obs(2, null), obs(3, null), obs(4, null), obs(5, null)];
show("dark.noEvidence", resolve([trainSeg(1, 5)], darkObs));

/* ------------------------------------------------------------------ */
/* 5 & 6. The chain term DECIDES, and CHAIN_GAP_MAX_S switches it off  */
/* ------------------------------------------------------------------ */

// These two are one probe in two halves, and the first attempt at them was
// worthless: both legs were unambiguously anchored, so chained and split
// produced identical answers and neither pinned the chain term or the split.
//
// The shape that discriminates puts leg 2's BOARD beyond what its own evidence
// can settle. Leg 1 (Alpha → Charlie) is forced on both sides. Leg 2's board
// anchor sits midway between Charlie and Delta, so anchor cannot choose, and
// leg 2's own duration prefers Charlie by only ~0.7 nats — under MARGIN_NATS,
// so on its own evidence leg 2's board must stay silent.
//
// The handover is what breaks the tie: leg 1 alights at Charlie, so
// Charlie → Charlie is free while Charlie → Delta demands 1500 m in the gap and
// clamps at CHAIN_CLAMP. Chained, that is 8 nats of separation and the board
// emits; split, the term is absent and the same leg says nothing.
const chainLeg1: Observation[] = [obs(0, at(0)), obs(1, at(0)), obs(2, null), obs(3, null), obs(4, null), obs(5, null),
	obs(6, null), obs(7, null), obs(8, null), obs(9, at(2))];

/** Leg 2, starting at `start`: a board anchor between Charlie and Delta one
 *  minute before, six dark minutes, then an alight anchor at Echo. */
const chainLeg2 = (start: number): Observation[] => [
	obs(start - 1, at(2.5)),
	...Array.from({ length: 6 }, (_, k) => obs(start + k, null)),
	obs(start + 6, at(4)),
];

// Gap = 2 min, inside CHAIN_GAP_MAX_S (12 min).
const chainObs: Observation[] = [...chainLeg1, obs(10, at(2.5)), ...chainLeg2(11).slice(1)];
show("chain.decidesBoard", resolve([trainSeg(2, 8), trainSeg(11, 17)], chainObs));

// Gap = 12 min, PAST CHAIN_GAP_MAX_S. Identical geometry and identical leg
// durations — only the dark stretch between them is longer — so any difference
// in the answer is the split and nothing else.
const splitObs: Observation[] = [
	...chainLeg1,
	...Array.from({ length: 10 }, (_, k) => obs(10 + k, null)),
	...chainLeg2(21),
];
show("chain.splitByGap", resolve([trainSeg(2, 8), trainSeg(21, 27)], splitObs));

/* ------------------------------------------------------------------ */
/* 7. Non-train and unknown_rail legs are skipped entirely             */
/* ------------------------------------------------------------------ */

// Three ways to be out of scope, each on its own so a single case cannot pass
// by satisfying a different guard than the one it names.
show(
	"skip.notTrain",
	resolve([{ ...trainSeg(2, 11), mode: "walking" } as HmmSegment], cleanObs),
);
show("skip.nullLine", resolve([{ ...trainSeg(2, 11), lineName: null }], cleanObs));
show("skip.unknownRail", resolve([{ ...trainSeg(2, 11), lineName: "unknown_rail" }], cleanObs));

/* ------------------------------------------------------------------ */
/* 8. Empty observations short-circuits                                */
/* ------------------------------------------------------------------ */

show("empty.observations", resolve([trainSeg(2, 11)], []));
