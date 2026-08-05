#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `src/geo/transit-place.ts`, ported to
 * `Verified/Geo/TransitPlace.lean`.
 *
 * Both exports are `async` only because the OSM lookup is an injected
 * parameter (`osm: Pick<OsmAdapter, "nearbyStations">`) — the TubeHop shape.
 * Passing a plain object here reference-tests the private `bracketingTrain`
 * and `isShortWalk` through the public functions, with no test-only export.
 *
 * The two things worth pinning against V8 rather than reading: the nearest
 * reduce uses STRICT `<` (so a distance tie keeps the EARLIER station), and
 * `segments[i - 1]` at `i = 0` is `undefined` in JS while Lean's `Nat`
 * subtraction truncates to 0 and would read the stay itself.
 *
 * Run: npx tsx lean/experiments/transit-place-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as T from "../../src/geo/transit-place.js";
import type { TransportMode } from "../../src/geo/segments.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const q = (s: unknown) => JSON.stringify(s);

type Station = { name: string; subtype: string; distanceM: number };
const osmOf =
	(stations: Station[]) =>
	({ nearbyStations: async () => stations }) as never;
const NONE = osmOf([]);

console.log("-- constants");
console.log(`STATION_AT_ALIGHT_RADIUS_M    ${T.STATION_AT_ALIGHT_RADIUS_M}`);
console.log(`INTERCHANGE_WALK_MAX_S        ${T.INTERCHANGE_WALK_MAX_S}`);
console.log(`INTERCHANGE_DWELL_MAX_S       ${T.INTERCHANGE_DWELL_MAX_S}`);
console.log(`INTERCHANGE_FOCUS_GUARD_MIN_DAYS ${T.INTERCHANGE_FOCUS_GUARD_MIN_DAYS}`);

const S = (name: string, distanceM: number): Station => ({ name, subtype: "station", distanceM });
const TWO = osmOf([S("Far", 120), S("Near", 40)]);
const TIE = osmOf([S("First", 40), S("Second", 40)]);
const BEYOND = osmOf([S("Outside", 151)]);
const AT_RADIUS = osmOf([S("Edge", 150)]);

console.log("\n-- stationAtTrainAlight");
const alight = async (
	prev: { mode: TransportMode; refinedMode?: TransportMode } | undefined,
	osm: never,
	radiusM?: number,
): Promise<string | null> => T.stationAtTrainAlight(prev, 51.5, -0.2, osm, radiusM);

for (const [label, got] of [
	["noPrev", await alight(undefined, TWO)],
	["prevWalking", await alight({ mode: "walking" }, TWO)],
	["prevTrain", await alight({ mode: "train" }, TWO)],
	["refinedTrainOverMode", await alight({ mode: "driving", refinedMode: "train" }, TWO)],
	["refinedWalkingOverTrain", await alight({ mode: "train", refinedMode: "walking" }, TWO)],
	["noStations", await alight({ mode: "train" }, NONE)],
	["tieKeepsFirst", await alight({ mode: "train" }, TIE)],
	["nearestBeyondRadius", await alight({ mode: "train" }, BEYOND)],
	["nearestAtRadius", await alight({ mode: "train" }, AT_RADIUS)],
	["explicitRadiusAdmits", await alight({ mode: "train" }, BEYOND, 200)],
] as Array<[string, string | null]>) {
	console.log(`${label.padEnd(24)} ${q(got)}`);
}

console.log("\n-- stationAtTransitInterchange");
type Seg = { mode: TransportMode; refinedMode?: TransportMode; startTs: number; endTs: number };
const seg = (mode: TransportMode, startTs: number, endTs: number, refinedMode?: TransportMode): Seg => ({
	mode,
	startTs,
	endTs,
	...(refinedMode !== undefined ? { refinedMode } : {}),
});

// stay is index 1: train | stay | train
const DIRECT: Seg[] = [seg("train", 0, 600), seg("stationary", 600, 900), seg("train", 900, 1500)];
// stay is index 2: train | walk | stay | walk | train  (one short platform change each side)
const VIA_WALK: Seg[] = [
	seg("train", 0, 600),
	seg("walking", 600, 900),
	seg("stationary", 900, 1200),
	seg("walking", 1200, 1500),
	seg("train", 1500, 2100),
];
const withAt = (segs: Seg[], i: number, s: Seg): Seg[] => segs.map((x, j) => (j === i ? s : x));

const ix = async (segs: Seg[], i: number, osm: never, focusDays?: number): Promise<string | null> =>
	T.stationAtTransitInterchange(segs, i, 51.5, -0.2, osm, undefined, focusDays);

for (const [label, got] of [
	["directBothSides", await ix(DIRECT, 1, TWO)],
	["viaShortWalks", await ix(VIA_WALK, 2, TWO)],
	["walkExactly720", await ix(withAt(VIA_WALK, 1, seg("walking", 180, 900)), 2, TWO)],
	["walkOneOver720", await ix(withAt(VIA_WALK, 1, seg("walking", 179, 900)), 2, TWO)],
	["beyondWalkNotTrain", await ix(withAt(VIA_WALK, 0, seg("driving", 0, 600)), 2, TWO)],
	["walkAtArrayEdge", await ix(VIA_WALK.slice(1), 1, TWO)],
	["stayFirstNoBefore", await ix(DIRECT.slice(1), 0, TWO)],
	["stayLastNoAfter", await ix(DIRECT.slice(0, 2), 1, TWO)],
	["indexPastEnd", await ix(DIRECT, 9, TWO)],
	// Degenerate on purpose: the ONLY shape in which `segments[i - 1]` at i = 0
	// can differ from `segments[0]`, which is what a Nat index would read.
	["negIndexAtHead", await ix([seg("train", 0, 600), seg("train", 600, 1200)], 0, TWO)],
	["dwellExactly900", await ix(withAt(DIRECT, 1, seg("stationary", 600, 1500)), 1, TWO)],
	["dwellOneOver900", await ix(withAt(DIRECT, 1, seg("stationary", 599, 1500)), 1, TWO)],
	["focusDays2", await ix(DIRECT, 1, TWO, 2)],
	["focusDays3", await ix(DIRECT, 1, TWO, 3)],
	["refinedTrainCounts", await ix(withAt(DIRECT, 0, seg("driving", 0, 600, "train")), 1, TWO)],
	["refinedWalkingHidesTrain", await ix(withAt(DIRECT, 0, seg("train", 0, 600, "walking")), 1, TWO)],
	["noStations", await ix(DIRECT, 1, NONE)],
	["tieKeepsFirst", await ix(DIRECT, 1, TIE)],
	["nearestBeyondRadius", await ix(DIRECT, 1, BEYOND)],
] as Array<[string, string | null]>) {
	console.log(`${label.padEnd(26)} ${q(got)}`);
}
