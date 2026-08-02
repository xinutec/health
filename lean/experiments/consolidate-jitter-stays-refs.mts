#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `consolidateJitterStays`
 * (`src/geo/passes/stays.ts`), ported into `Verified/Geo/SegmentMerge.lean`.
 *
 * `planJitterStayRuns` — the plan this pass consumes — is already ported and
 * pinned; this covers the collapse itself: the point-count-weighted centroid,
 * the longest-leg base, the two string fields, and the index rewrite that
 * replaces a run with one stay.
 *
 * Unlike the rest of the tranche the OSM call here is NOT an injected function:
 * `bestPlace` is a direct import that takes the adapter, so it cannot be
 * stubbed from outside. Instead the fake adapter answers a landmark whose NAME
 * encodes the coordinate it was asked about, and `enclosing: true` makes
 * `bestPlace` accept it. The resolved `place` string therefore reveals which
 * coordinate the pass asked about — the combined centroid is pinned end to end
 * through the real venue path rather than asserted.
 *
 * Run: npx tsx lean/experiments/consolidate-jitter-stays-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const S = await import(path.join(repo, "src/geo/passes/stays.ts"));

const asked: string[] = [];

/** Answers one enclosing landmark named after the query coordinate, so the
 *  place label that comes back names the point the pass asked about. */
const osm = {
	nearbyLandmarks: async (lat: number, lon: number, radiusM?: number) => {
		asked.push(`nearbyLandmarks(${lat.toFixed(7)}, ${lon.toFixed(7)}, ${radiusM})`);
		return [
			{
				name: `V@${lat.toFixed(5)},${lon.toFixed(5)}`,
				type: "amenity" as const,
				subtype: "restaurant",
				distanceM: 5,
				enclosing: true,
			},
		];
	},
	reverseGeocode: async (lat: number, lon: number, zoom?: number) => {
		asked.push(`reverseGeocode(${lat.toFixed(7)}, ${lon.toFixed(7)}, ${zoom})`);
		return null;
	},
	nearbyWays: async () => [],
	nearbyStations: async () => [],
	linesAtPoint: async () => new Set<string>(),
	nearbyTransitStops: async () => [],
	stationsOnLine: async () => [],
	drivableRoads: async () => [],
	walkableRoads: async () => [],
	buildingsNear: async () => [],
	// biome-ignore lint/suspicious/noExplicitAny: a test double for the adapter
} as any;

type Seg = Record<string, unknown>;

/** A stationary fragment at `(lat, lon)`. `jitter` tags it the way
 *  `demoteJitterWalkToStationary` does — the run needs at least one. */
const stay = (
	startTs: number,
	endTs: number,
	lat: number,
	lon: number,
	pointCount: number,
	over: Seg = {},
): Seg => ({
	startTs,
	endTs,
	mode: "stationary",
	confidence: 0.8,
	confidenceMargin: 2,
	avgSpeed: 0,
	maxSpeed: 0,
	linearity: 0.5,
	pointCount,
	centroidLat: lat,
	centroidLon: lon,
	...over,
});

const JIT = { refinedKinds: ["gps-jitter"] };

/** Three co-located fragments: the MIDDLE one is longest (so the base pick is
 *  not the first), and the point counts differ (so the weighted centroid is not
 *  the plain mean). */
const runOf3 = [
	stay(0, 600, 51.5, -0.14, 10, { ...JIT, city: "Edge", confidence: 0.1 }),
	stay(600, 1500, 51.5002, -0.1401, 40, {
		place: "Middle",
		city: "London",
		wayName: "Wilton Rd",
		refinedReason: "earlier note",
		confidence: 0.55,
		avgSpeed: 1.25,
	}),
	stay(1500, 1800, 51.5004, -0.1402, 50, { place: "Last", city: "Edge", confidence: 0.9 }),
];

const dump = async (label: string, segs: Seg[]) => {
	asked.length = 0;
	const out = await S.consolidateJitterStays(segs as never, osm, null);
	console.log(`--- ${label}`);
	for (const s of out as Seg[]) {
		console.log(
			`   [${s.startTs},${s.endTs}] n=${s.pointCount} c=${s.centroidLat},${s.centroidLon}` +
				` conf=${s.confidence} avg=${s.avgSpeed}` +
				` place=${s.place} city=${s.city} way=${s.wayName} reason=${s.refinedReason}`,
		);
	}
	for (const a of asked) console.log(`   asked: ${a}`);
};

console.log("=== consolidateJitterStays ===");
await dump("three co-located fragments, middle longest", runOf3);
await dump("no jitter tag anywhere — untouched", [
	stay(0, 600, 51.5, -0.14, 10),
	stay(600, 1500, 51.5002, -0.1401, 40),
]);
await dump("a moving segment survives around the run", [
	{ startTs: -300, endTs: 0, mode: "walking", pointCount: 5, place: "Before" },
	...runOf3,
	{ startTs: 1800, endTs: 2100, mode: "walking", pointCount: 5, place: "After" },
]);
await dump("two runs in one day", [
	...runOf3,
	{ startTs: 1800, endTs: 2100, mode: "walking", pointCount: 5 },
	stay(2100, 2700, 51.6, -0.2, 10, JIT),
	stay(2700, 3300, 51.6001, -0.2001, 30, { place: "Second run" }),
]);
await dump("zero point counts — the || 1 guard", [
	stay(0, 600, 51.5, -0.14, 0, JIT),
	stay(600, 1500, 51.5002, -0.1401, 0),
]);
await dump("tie on duration keeps the EARLIER leg as base", [
	stay(0, 600, 51.5, -0.14, 10, { ...JIT, city: "EarlierBase", confidence: 0.11 }),
	stay(600, 1200, 51.5002, -0.1401, 10, { city: "LaterBase", confidence: 0.99 }),
]);
await dump("base carries no refinedReason", [
	stay(0, 600, 51.5, -0.14, 10, JIT),
	stay(600, 1500, 51.5002, -0.1401, 40, { place: "Middle" }),
]);
