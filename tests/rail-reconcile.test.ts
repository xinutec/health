/**
 * reconcileAdjacentRailLegs — a physical constraint: two train legs
 * that are back-to-back in the segment sequence, with nothing between
 * them, must share a station. You cannot step off one train and
 * instantly be on another at a different station. Where leg A's
 * alighting and leg B's boarding disagree, leg B is rewritten to board
 * where leg A alighted.
 */

import { describe, expect, it } from "vitest";
import { assembleRailJourney, parseRailWayName, reconcileAdjacentRailLegs } from "../src/geo/passes/rail-reconcile.js";
import type { EnrichedSegment } from "../src/geo/velocity.js";

/** Build an EnrichedSegment; times given in whole minutes for clarity. */
function seg(
	mode: EnrichedSegment["mode"],
	startMin: number,
	endMin: number,
	extra: Partial<EnrichedSegment> = {},
): EnrichedSegment {
	return {
		startTs: startMin * 60,
		endTs: endMin * 60,
		mode,
		refinedMode: mode,
		confidence: 0.9,
		confidenceMargin: 5,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 10,
		...extra,
	};
}

const ways = (segs: EnrichedSegment[]): (string | undefined)[] => segs.map((s) => s.wayName);

describe("parseRailWayName", () => {
	it("parses a bare station pair", () => {
		expect(parseRailWayName("Ashvale → Carfax")).toEqual({
			board: "Ashvale",
			alight: "Carfax",
		});
	});

	it("parses a station pair with a line suffix", () => {
		expect(parseRailWayName("St. John's Wood → Farvale · Jubilee Line")).toEqual({
			board: "St. John's Wood",
			alight: "Farvale",
			line: "Jubilee Line",
		});
	});

	it("returns null for a non-rail wayName", () => {
		expect(parseRailWayName("A406 North Circular Road")).toBeNull();
		expect(parseRailWayName(undefined)).toBeNull();
	});
});

describe("reconcileAdjacentRailLegs", () => {
	it("rewrites leg B to board where leg A alighted when they disagree", () => {
		// The real 2026-05-22 bug: leg A alights Carfax, leg B's
		// boarding was independently resolved to St. John's Wood — one
		// stop *behind* Carfax, an impossible backward jump.
		const segs = [
			seg("train", 0, 10, { wayName: "Ashvale → Carfax" }),
			seg("train", 10, 19, { wayName: "St. John's Wood → Farvale · Jubilee Line" }),
		];
		const out = reconcileAdjacentRailLegs(segs);
		expect(ways(out)).toEqual(["Ashvale → Carfax", "Carfax → Farvale · Jubilee Line"]);
	});

	it("leaves legs that already share a station untouched", () => {
		const segs = [
			seg("train", 0, 10, { wayName: "Ashvale → Carfax" }),
			seg("train", 10, 19, { wayName: "Carfax → Farvale · Jubilee Line" }),
		];
		expect(ways(reconcileAdjacentRailLegs(segs))).toEqual(["Ashvale → Carfax", "Carfax → Farvale · Jubilee Line"]);
	});

	it("does not touch legs separated by another segment — not back-to-back", () => {
		const segs = [
			seg("train", 0, 10, { wayName: "Ashvale → Carfax" }),
			seg("walking", 10, 25),
			seg("train", 25, 35, { wayName: "St. John's Wood → Farvale · Jubilee Line" }),
		];
		expect(ways(reconcileAdjacentRailLegs(segs))).toEqual([
			"Ashvale → Carfax",
			undefined,
			"St. John's Wood → Farvale · Jubilee Line",
		]);
	});

	it("propagates the correction along a chain of three legs", () => {
		const segs = [
			seg("train", 0, 10, { wayName: "A → B" }),
			seg("train", 10, 20, { wayName: "X → C" }),
			seg("train", 20, 30, { wayName: "Y → D" }),
		];
		expect(ways(reconcileAdjacentRailLegs(segs))).toEqual(["A → B", "B → C", "C → D"]);
	});

	it("skips a leg with a non-rail wayName", () => {
		const segs = [seg("train", 0, 10, { wayName: "Ashvale → Carfax" }), seg("train", 10, 19, { wayName: undefined })];
		expect(ways(reconcileAdjacentRailLegs(segs))).toEqual(["Ashvale → Carfax", undefined]);
	});

	it("respects refinedMode — an underground run upgraded to train still reconciles", () => {
		const segs = [
			seg("driving", 0, 10, { refinedMode: "train", wayName: "Ashvale → Carfax" }),
			seg("walking", 10, 19, { refinedMode: "train", wayName: "St. John's Wood → Farvale" }),
		];
		expect(ways(reconcileAdjacentRailLegs(segs))).toEqual(["Ashvale → Carfax", "Carfax → Farvale"]);
	});

	it("absorbs leg B as a phantom re-arrival when both legs alight at the same station", () => {
		// Leg A alights Carfax and leg B *also* alights Carfax,
		// boarding elsewhere with no travel between. You already arrived at
		// Carfax via leg A — you cannot ride to it again. Leg B is a
		// phantom (typically a coarse-fix underground reconstruction
		// duplicating leg A's tail), so it is absorbed into leg A rather than
		// left as an impossible "ride to a station you already reached".
		const segs = [
			seg("train", 0, 10, { wayName: "Ashvale → Carfax", pointCount: 12 }),
			seg("train", 10, 19, { wayName: "St. John's Wood → Carfax", pointCount: 3 }),
		];
		const out = reconcileAdjacentRailLegs(segs);
		expect(ways(out)).toEqual(["Ashvale → Carfax"]);
		// Leg A swallows leg B's window and fix count.
		expect(out[0].endTs).toBe(19 * 60);
		expect(out[0].pointCount).toBe(15);
	});

	it("absorbs the 2026-06-22 phantom: one Met ride emitted as two legs both alighting at Deepwell", () => {
		// The real bug. The 16-minute Ashvale → Deepwell ride, plus a
		// 4-minute coarse-fix reconstruction that re-arrives at Deepwell
		// boarding mid-route at Carfax. The reconstruction is absorbed;
		// one physically-coherent ride remains.
		const segs = [
			seg("train", 0, 16, { wayName: "Ashvale → Deepwell · Metropolitan Line" }),
			seg("train", 16, 20, {
				wayName: "Carfax → Deepwell · Circle, Hammersmith & City and Metropolitan Lines",
			}),
		];
		expect(ways(reconcileAdjacentRailLegs(segs))).toEqual(["Ashvale → Deepwell · Metropolitan Line"]);
	});

	it("does not mutate the input segments", () => {
		const segs = [
			seg("train", 0, 10, { wayName: "Ashvale → Carfax" }),
			seg("train", 10, 19, { wayName: "St. John's Wood → Farvale" }),
		];
		reconcileAdjacentRailLegs(segs);
		expect(segs[1].wayName).toBe("St. John's Wood → Farvale");
	});
});

describe("assembleRailJourney", () => {
	/** Minimal OsmAdapter slice: `linesAtPoint` is routed by the leg centroid's
	 *  integer latitude (a test tag), `stationsOnLine` from a name→stations map. */
	function osmStub(
		linesByLatTag: Record<number, string[]>,
		stationsByLine: Record<string, string[]>,
	): {
		linesAtPoint: (lat: number, lon: number, r?: number) => Promise<Set<string>>;
		stationsOnLine: (l: string) => Promise<{ name: string; lat: number; lon: number }[]>;
	} {
		return {
			linesAtPoint: async (lat) => new Set(linesByLatTag[Math.round(lat)] ?? []),
			stationsOnLine: async (line) => (stationsByLine[line] ?? []).map((name) => ({ name, lat: 0, lon: 0 })),
		};
	}

	const MET = ["Ashvale", "Brookden", "Carfax", "Deepwell"];

	it("collapses a one-line ride fragmented into 3 train legs + slivers into one leg", async () => {
		// Ashvale → Deepwell on the Metropolitan line, shattered by the
		// GPS surfacing mid-tunnel into three train legs with interchange slivers.
		const segs = [
			seg("train", 0, 10, { wayName: "Ashvale → Brookden", centroidLat: 1, centroidLon: 0 }),
			seg("walking", 10, 12, { centroidLat: 1, centroidLon: 0 }),
			seg("train", 12, 17, { wayName: "Brookden → Carfax", centroidLat: 1, centroidLon: 0 }),
			seg("walking", 17, 22, { centroidLat: 1, centroidLon: 0 }),
			seg("train", 22, 33, { wayName: "Carfax → Deepwell", centroidLat: 1, centroidLon: 0 }),
		];
		const osm = osmStub({ 1: ["Metropolitan Line"] }, { "Metropolitan Line": MET });
		const out = await assembleRailJourney([...segs], [], osm);
		const trains = out.filter((s) => s.mode === "train");
		expect(trains).toHaveLength(1);
		expect(trains[0].wayName).toBe("Ashvale → Deepwell · Metropolitan Line");
		expect(trains[0].startTs).toBe(0);
		expect(trains[0].endTs).toBe(33 * 60);
	});

	it("absorbs a mis-moded non-train middle (driving) into the one-line ride", async () => {
		// Without the tube-leg-recovery patch the surfaced middle is `driving`; the
		// topology (all four stations on one line) still recovers one tube ride.
		const segs = [
			seg("train", 0, 10, { wayName: "Ashvale → Brookden", centroidLat: 1, centroidLon: 0 }),
			seg("walking", 10, 12, { centroidLat: 1, centroidLon: 0 }),
			seg("driving", 12, 17, { centroidLat: 1, centroidLon: 0 }),
			seg("walking", 17, 22, { centroidLat: 1, centroidLon: 0 }),
			seg("train", 22, 33, { wayName: "Carfax → Deepwell", centroidLat: 1, centroidLon: 0 }),
		];
		const osm = osmStub({ 1: ["Metropolitan Line"] }, { "Metropolitan Line": MET });
		const out = await assembleRailJourney([...segs], [], osm);
		const trains = out.filter((s) => s.mode === "train" || s.refinedMode === "train");
		expect(trains).toHaveLength(1);
		expect(trains[0].wayName).toBe("Ashvale → Deepwell · Metropolitan Line");
	});

	it("does NOT merge a real line-change interchange (no single line serves all stations)", async () => {
		// Victoria → Elmford (Victoria line), change, Elmford → Deepwell
		// Square (Met). No single line serves {Victoria, Elmford, Deepwell Sq}.
		const segs = [
			seg("train", 0, 10, { wayName: "Victoria → Elmford · Victoria Line", centroidLat: 1, centroidLon: 0 }),
			seg("walking", 10, 14, { centroidLat: 2, centroidLon: 0 }),
			seg("train", 14, 20, {
				wayName: "Elmford → Deepwell · Metropolitan Line",
				centroidLat: 2,
				centroidLon: 0,
			}),
		];
		const osm = osmStub(
			{ 1: ["Victoria Line"], 2: ["Metropolitan Line"] },
			{ "Victoria Line": ["Victoria", "Elmford"], "Metropolitan Line": ["Elmford", "Deepwell"] },
		);
		const out = await assembleRailJourney([...segs], [], osm);
		expect(out.filter((s) => s.mode === "train")).toHaveLength(2);
	});

	it("partitions a multi-line journey at the interchange, merging each single-line sub-run", async () => {
		// Ashvale → … → Deepwell (Metropolitan), change at Elmford,
		// then Elmford → Highbury & Islington (Victoria). No single line serves
		// every station, but the Met legs are one ride and must merge into ONE leg
		// rather than staying shattered just because the run continues onto the
		// Victoria line. (The real 2026-06-28 Ashvale→Islington trip.)
		const segs = [
			seg("train", 0, 10, { wayName: "Ashvale → Brookden", centroidLat: 1, centroidLon: 0 }),
			seg("walking", 10, 12, { centroidLat: 1, centroidLon: 0 }),
			seg("train", 12, 17, {
				wayName: "Brookden → Carfax · Metropolitan Line",
				centroidLat: 1,
				centroidLon: 0,
			}),
			seg("train", 17, 27, {
				wayName: "Carfax → Deepwell · Circle, Hammersmith & City and Metropolitan Lines",
				centroidLat: 1,
				centroidLon: 0,
			}),
			seg("train", 27, 35, {
				wayName: "Elmford → Highbury & Islington · Victoria Line",
				centroidLat: 2,
				centroidLon: 0,
			}),
		];
		const osm = osmStub(
			{ 1: ["Metropolitan Line"], 2: ["Victoria Line"] },
			{
				"Metropolitan Line": ["Ashvale", "Brookden", "Carfax", "Deepwell", "Elmford"],
				"Victoria Line": ["Elmford", "Highbury & Islington"],
			},
		);
		const out = await assembleRailJourney([...segs], [], osm);
		const trains = out.filter((s) => s.mode === "train");
		expect(trains).toHaveLength(2);
		expect(trains[0].wayName).toBe("Ashvale → Deepwell · Metropolitan Line");
		expect(trains[0].startTs).toBe(0);
		expect(trains[0].endTs).toBe(27 * 60);
		expect(trains[1].wayName).toBe("Elmford → Highbury & Islington · Victoria Line");
	});

	it("does NOT merge two differently-labelled lines even when one line serves every station", async () => {
		// 2026-06-16: Ashvale → Carfax on the Metropolitan line, then a
		// real Carfax interchange (2-min walk) onto the Jubilee line to Green
		// Park. The Jubilee line happens to serve ALL THREE stations, so the
		// through-line test alone would merge them into one Jubilee leg and erase
		// the change. The legs carry distinct explicit lines (Met, Jubilee), so the
		// line-label gate must keep them split and preserve the interchange walk.
		const segs = [
			seg("train", 0, 9, {
				wayName: "Ashvale → Carfax · Metropolitan Line",
				centroidLat: 1,
				centroidLon: 0,
			}),
			seg("walking", 9, 11, { centroidLat: 1, centroidLon: 0 }), // Carfax interchange
			seg("train", 11, 15, { wayName: "Carfax → Farvale · Jubilee Line", centroidLat: 1, centroidLon: 0 }),
		];
		const osm = osmStub(
			{ 1: ["Jubilee Line", "Metropolitan Line"] },
			{
				"Jubilee Line": ["Ashvale", "Carfax", "Farvale"],
				"Metropolitan Line": ["Ashvale", "Carfax"],
			},
		);
		const out = await assembleRailJourney([...segs], [], osm);
		const trains = out.filter((s) => s.mode === "train");
		expect(trains).toHaveLength(2);
		expect(trains[0].wayName).toBe("Ashvale → Carfax · Metropolitan Line");
		expect(trains[1].wayName).toBe("Carfax → Farvale · Jubilee Line");
		// The interchange walk survives between the two legs.
		expect(out.some((s) => s.mode === "walking")).toBe(true);
	});

	it("does NOT merge across an interchange walk when the first leg is unlabelled (the real 2026-06-16)", async () => {
		// The real shape: "Ashvale → Carfax" has NO line label (the
		// underground reconstruction couldn't disambiguate Met vs Jubilee, which
		// both serve that pair), a "Carfax (interchange)" walk marks the
		// platform change, then "Carfax → Farvale · Jubilee Line". The
		// through-line test finds Jubilee serves all three and would merge; the
		// interchange-walk gate must split instead and keep the walk.
		const segs = [
			seg("train", 0, 9, { wayName: "Ashvale → Carfax", centroidLat: 1, centroidLon: 0 }),
			seg("walking", 9, 11, { wayName: "Carfax (interchange)", centroidLat: 1, centroidLon: 0 }),
			seg("train", 11, 15, { wayName: "Carfax → Farvale · Jubilee Line", centroidLat: 1, centroidLon: 0 }),
		];
		const osm = osmStub(
			{ 1: ["Jubilee Line", "Metropolitan Line"] },
			{
				"Jubilee Line": ["Ashvale", "Carfax", "Farvale"],
				"Metropolitan Line": ["Ashvale", "Carfax"],
			},
		);
		const out = await assembleRailJourney([...segs], [], osm);
		const trains = out.filter((s) => s.mode === "train");
		expect(trains).toHaveLength(2);
		expect(trains[0].wayName).toBe("Ashvale → Carfax");
		expect(trains[1].wayName).toBe("Carfax → Farvale · Jubilee Line");
		expect(out.some((s) => s.mode === "walking" && s.wayName === "Carfax (interchange)")).toBe(true);
	});

	it("DOES merge a same-line ride even with an interchange-labelled sliver when both legs name that line", async () => {
		// Same-station GPS surfacing on ONE Metropolitan ride can be mis-scored as a
		// short walk and relabelled "(interchange)" because the legs share Carfax
		// Street. Explicit matching line labels prove the marker spurious — merge.
		const segs = [
			seg("train", 0, 9, {
				wayName: "Brookden → Carfax · Metropolitan Line",
				centroidLat: 1,
				centroidLon: 0,
			}),
			seg("walking", 9, 10, { wayName: "Carfax (interchange)", centroidLat: 1, centroidLon: 0 }),
			seg("train", 10, 18, {
				wayName: "Carfax → Deepwell · Metropolitan Line",
				centroidLat: 1,
				centroidLon: 0,
			}),
		];
		const osm = osmStub({ 1: ["Metropolitan Line"] }, { "Metropolitan Line": MET });
		const out = await assembleRailJourney([...segs], [], osm);
		const trains = out.filter((s) => s.mode === "train");
		expect(trains).toHaveLength(1);
		expect(trains[0].wayName).toBe("Brookden → Deepwell · Metropolitan Line");
	});

	it("does NOT merge across a long stop (a real stopover, not a surfacing sliver)", async () => {
		const segs = [
			seg("train", 0, 10, { wayName: "Ashvale → Brookden", centroidLat: 1, centroidLon: 0 }),
			seg("stationary", 10, 40, { centroidLat: 1, centroidLon: 0 }), // 30-min stop — got off
			seg("train", 40, 50, { wayName: "Brookden → Carfax", centroidLat: 1, centroidLon: 0 }),
		];
		const osm = osmStub({ 1: ["Metropolitan Line"] }, { "Metropolitan Line": MET });
		const out = await assembleRailJourney([...segs], [], osm);
		expect(out.filter((s) => s.mode === "train")).toHaveLength(2);
	});

	it("absorbs a long mis-moded transit middle (motorised peak) into the one-line ride", async () => {
		// 2026-06-24 Ashvale → Deepwell: the Brookden → Carfax tunnel
		// surfaced as a 13-min "walking" segment — over the 10-min sliver cap, so the
		// duration rule alone leaves the ride fragmented. But its peak is tube speed
		// (84 km/h), not a street walk. The single through-line serving all four
		// stations recovers one ride; the motorised peak is what tells a mis-moded
		// tunnel apart from a genuine walk between two separate rides.
		const segs = [
			seg("train", 0, 10, { wayName: "Ashvale → Brookden", centroidLat: 1, centroidLon: 0 }),
			seg("walking", 10, 23, { centroidLat: 1, centroidLon: 0, maxSpeed: 84 }),
			seg("train", 23, 28, { wayName: "Carfax → Deepwell", centroidLat: 1, centroidLon: 0 }),
		];
		const osm = osmStub({ 1: ["Metropolitan Line"] }, { "Metropolitan Line": MET });
		const out = await assembleRailJourney([...segs], [], osm);
		const trains = out.filter((s) => s.mode === "train");
		expect(trains).toHaveLength(1);
		expect(trains[0].wayName).toBe("Ashvale → Deepwell · Metropolitan Line");
	});

	it("does NOT absorb a long walking-pace middle (a real walk between two separate rides)", async () => {
		// Same shape, but the 13-min middle peaks at walking pace — the rider got off,
		// walked on the street between two same-line stations, and boarded again. Two
		// distinct rides; the run must break despite a single line serving all stations.
		const segs = [
			seg("train", 0, 10, { wayName: "Ashvale → Brookden", centroidLat: 1, centroidLon: 0 }),
			seg("walking", 10, 23, { centroidLat: 1, centroidLon: 0, maxSpeed: 8 }),
			seg("train", 23, 28, { wayName: "Carfax → Deepwell", centroidLat: 1, centroidLon: 0 }),
		];
		const osm = osmStub({ 1: ["Metropolitan Line"] }, { "Metropolitan Line": MET });
		const out = await assembleRailJourney([...segs], [], osm);
		expect(out.filter((s) => s.mode === "train")).toHaveLength(2);
	});

	it("leaves a single train leg untouched", async () => {
		const segs = [
			seg("train", 0, 20, {
				wayName: "Ashvale → Deepwell · Metropolitan Line",
				centroidLat: 1,
				centroidLon: 0,
			}),
		];
		const osm = osmStub({ 1: ["Metropolitan Line"] }, { "Metropolitan Line": MET });
		const out = await assembleRailJourney([...segs], [], osm);
		expect(out).toHaveLength(1);
		expect(out[0].wayName).toBe("Ashvale → Deepwell · Metropolitan Line");
	});
});

/**
 * A merged ride's ALIGHT must be resolved from the ride's own end, not inherited
 * from the last fragment — whose label stops wherever the GPS last surfaced.
 *
 * The 2026-06-28 Metropolitan ride went dark one stop short of its destination.
 * The last fragment could only name the last station the phone saw, so the ride
 * was labelled as ending there — contradicting the Victoria leg that boarded at
 * the real destination, and leaving a physically impossible worldline.
 */
describe("assembleRailJourney — the ride's alight comes from the ride's end", () => {
	/** Four stations 692 m apart along one line, west to east. */
	const MET_STATIONS = [
		{ name: "Ashvale", lat: 51.5, lon: 0.0 },
		{ name: "Brookden", lat: 51.5, lon: 0.01 },
		{ name: "Carfax", lat: 51.5, lon: 0.02 },
		{ name: "Deepwell", lat: 51.5, lon: 0.03 },
	];

	const osm = {
		linesAtPoint: async () => new Set<string>(["Metropolitan Line"]),
		stationsOnLine: async (line: string) => (line === "Metropolitan Line" ? MET_STATIONS : []),
	};

	const fix = (minute: number, lat: number, lon: number, speed_kmh: number) => ({
		ts: minute * 60,
		lat,
		lon,
		speed_kmh,
		bearing: 90,
	});

	/** Ashvale → Brookden, then Brookden → Carfax: GPS surfaced twice, then went
	 *  dark for the final Carfax → Deepwell hop. `last.alight` is Carfax — a
	 *  mid-ride waypoint. The rider got off at Deepwell. */
	const darkRide = [
		seg("train", 0, 10, { wayName: "Ashvale → Brookden · Metropolitan Line", centroidLat: 51.5, centroidLon: 0.0 }),
		seg("train", 10, 17, { wayName: "Brookden → Carfax · Metropolitan Line", centroidLat: 51.5, centroidLon: 0.015 }),
	];

	it("carries the ride past its last GPS-seen station to where the rider actually got off", async () => {
		// GPS returns at 25 min, walking pace, 7 m from Deepwell — the real alight.
		const points = [fix(5, 51.5, 0.005, 60), fix(15, 51.5, 0.015, 60), fix(25, 51.5, 0.0301, 2)];
		const out = await assembleRailJourney([...darkRide], points, osm);
		const trains = out.filter((s) => s.mode === "train");
		expect(trains).toHaveLength(1);
		expect(trains[0].wayName).toBe("Ashvale → Deepwell · Metropolitan Line");
	});

	it("keeps the fragment's label when the ride's end is never observed", async () => {
		// No fix after the last fragment: we do not know where they got off, so we
		// must not invent a station — the honest answer is the one we had.
		const points = [fix(5, 51.5, 0.005, 60), fix(15, 51.5, 0.015, 60)];
		const out = await assembleRailJourney([...darkRide], points, osm);
		expect(out.filter((s) => s.mode === "train")[0].wayName).toBe("Ashvale → Carfax · Metropolitan Line");
	});

	it("keeps the fragment's label when the ride ends nowhere near the line", async () => {
		// The post-ride fix is ~3.5 km off the line's stations (beyond
		// JOURNEY_ALIGHT_MAX_M). Naming the nearest station anyway would be a
		// fabrication.
		const points = [fix(5, 51.5, 0.005, 60), fix(15, 51.5, 0.015, 60), fix(25, 51.53, 0.08, 2)];
		const out = await assembleRailJourney([...darkRide], points, osm);
		expect(out.filter((s) => s.mode === "train")[0].wayName).toBe("Ashvale → Carfax · Metropolitan Line");
	});

	it("never collapses the ride to a degenerate 'X → X'", async () => {
		// The rider returns to where they boarded (GPS reacquires at Ashvale).
		// Re-resolving would name the board station as the alight; keep the
		// fragment's label rather than emit a zero-length ride.
		const points = [fix(5, 51.5, 0.005, 60), fix(15, 51.5, 0.015, 60), fix(25, 51.5, 0.0001, 2)];
		const out = await assembleRailJourney([...darkRide], points, osm);
		expect(out.filter((s) => s.mode === "train")[0].wayName).toBe("Ashvale → Carfax · Metropolitan Line");
	});

	it("is not fooled by a mid-ride station dwell — the train stopped, the rider did not get off", async () => {
		// A slow fix at Carfax (the train standing at the platform) followed by a
		// return to transit speed is a dwell, not an alight. findRunAlightFix must
		// walk past it to the sustained slow fix at Deepwell.
		const points = [
			fix(5, 51.5, 0.005, 60),
			fix(15, 51.5, 0.015, 60),
			fix(18, 51.5, 0.02, 1), // standing at Carfax…
			fix(19, 51.5, 0.022, 55), // …and moving again
			fix(25, 51.5, 0.0301, 2),
		];
		const out = await assembleRailJourney([...darkRide], points, osm);
		expect(out.filter((s) => s.mode === "train")[0].wayName).toBe("Ashvale → Deepwell · Metropolitan Line");
	});
});
