/**
 * Underground rail-run reconstruction.
 *
 * When a tube journey leaves only coarse cell-network fixes, the
 * reconstructor must (a) recognise the line from the coarse fixes and
 * (b) carve the tube ride out of the walking segment that swallowed it.
 *
 * All coordinates are synthetic, anchored at (50.0, 5.0). The fake
 * station network: Line 1 runs Alpha-Beta-Gamma-Delta; Line 2 runs
 * Alpha-Delta only (a parallel line that connects the same endpoints
 * but does not pass Beta/Gamma). The whole point of the coarse fixes
 * is to disambiguate those two.
 */

import { describe, expect, it } from "vitest";
import type { NearbyStation } from "../src/geo/osm.js";
import {
	annotateUndergroundRuns,
	type CoarseFix,
	reconstructUndergroundJourney,
	reconstructUndergroundRun,
} from "../src/geo/underground-rail.js";
import type { EnrichedSegment } from "../src/geo/velocity.js";

const LAT_DEG_PER_M = 1 / 111_000;
const LON_DEG_PER_M = 1 / (111_000 * Math.cos((50 * Math.PI) / 180));

/** A point `metresNorth`/`metresEast` from the synthetic anchor. */
function at(metresNorth: number, metresEast: number): { lat: number; lon: number } {
	return { lat: 50.0 + metresNorth * LAT_DEG_PER_M, lon: 5.0 + metresEast * LON_DEG_PER_M };
}

function metres(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const dLat = (lat2 - lat1) / LAT_DEG_PER_M;
	const dLon = (lon2 - lon1) / LON_DEG_PER_M;
	return Math.sqrt(dLat * dLat + dLon * dLon);
}

interface FakeStation {
	name: string;
	north: number;
	east: number;
	lines: string[];
}

/** Build station/line lookups from a synthetic station network. A
 *  lookup at a point returns whatever stations sit within `radiusM`. */
function lookupsFor(stations: FakeStation[], radiusM = 400) {
	const stationsLookup = async (lat: number, lon: number): Promise<NearbyStation[]> =>
		stations
			.map((s) => {
				const p = at(s.north, s.east);
				return { name: s.name, subtype: "subway", distanceM: metres(lat, lon, p.lat, p.lon) };
			})
			.filter((s) => s.distanceM <= radiusM)
			.sort((a, b) => a.distanceM - b.distanceM);

	const linesLookup = async (lat: number, lon: number): Promise<Set<string>> => {
		const near = await stationsLookup(lat, lon);
		const nearNames = new Set(near.map((s) => s.name));
		return new Set(stations.filter((s) => nearNames.has(s.name)).flatMap((s) => s.lines));
	};

	return { stationsLookup, linesLookup };
}

const NETWORK: FakeStation[] = [
	{ name: "Alpha", north: 0, east: 0, lines: ["Line 1", "Line 2"] },
	{ name: "Beta", north: 1000, east: 500, lines: ["Line 1"] },
	{ name: "Gamma", north: 2000, east: 1000, lines: ["Line 1"] },
	{ name: "Delta", north: 3000, east: 1500, lines: ["Line 1", "Line 2"] },
];

function coarseFix(ts: number, north: number, east: number, accuracy = 120): CoarseFix {
	return { ts, ...at(north, east), accuracy };
}

function seg(partial: Partial<EnrichedSegment> & { startTs: number; endTs: number }): EnrichedSegment {
	return {
		mode: "walking",
		confidence: 0.8,
		confidenceMargin: 3,
		avgSpeed: 5,
		maxSpeed: 7,
		linearity: 0.6,
		pointCount: 20,
		...partial,
	};
}

describe("reconstructUndergroundRun", () => {
	it("identifies the line, excluding a parallel line the journey did not take", async () => {
		const { stationsLookup, linesLookup } = lookupsFor(NETWORK);
		// Coarse fixes hug Beta and Gamma — stations only Line 1 serves.
		const fixes = [coarseFix(1700, 1020, 510), coarseFix(2000, 2010, 1010)];
		const run = await reconstructUndergroundRun(
			fixes,
			at(30, 15), // boarding by Alpha (served by Line 1 AND Line 2)
			at(2980, 1490), // alighting by Delta (also Line 1 AND Line 2)
			stationsLookup,
			linesLookup,
		);
		expect(run).not.toBeNull();
		// Both lines connect Alpha↔Delta, but only Line 1 passes the
		// coarse fixes — that is what breaks the tie.
		expect(run?.line).toBe("Line 1");
		expect(run?.boardingStation).toBe("Alpha");
		expect(run?.alightingStation).toBe("Delta");
		expect(run?.startTs).toBe(1700);
		expect(run?.endTs).toBe(2000);
	});

	it("returns null when there are too few coarse fixes", async () => {
		const { stationsLookup, linesLookup } = lookupsFor(NETWORK);
		// One coarse fix is a blip, not a journey; the rest are real GPS.
		const fixes = [coarseFix(1700, 1020, 510), coarseFix(2000, 2010, 1010, 20)];
		const run = await reconstructUndergroundRun(fixes, at(30, 15), at(2980, 1490), stationsLookup, linesLookup);
		expect(run).toBeNull();
	});

	it("returns null when both ends resolve to the same station (a platform wait, not a journey)", async () => {
		const { stationsLookup, linesLookup } = lookupsFor(NETWORK);
		// Coarse fixes near Beta, but the user never left Alpha's
		// vicinity — boarding and alighting both snap to Alpha.
		const fixes = [coarseFix(1700, 1020, 510), coarseFix(2000, 2010, 1010)];
		const run = await reconstructUndergroundRun(fixes, at(20, 10), at(40, 25), stationsLookup, linesLookup);
		expect(run).toBeNull();
	});

	it("returns null when no single line connects both ends via the coarse fixes", async () => {
		// Alighting end is served only by Line 2, which the coarse fixes
		// (on Line 1) never touch — no line is both endpoint-connecting
		// and coarse-fix-supported.
		const network: FakeStation[] = [
			{ name: "Alpha", north: 0, east: 0, lines: ["Line 1", "Line 2"] },
			{ name: "Beta", north: 1000, east: 500, lines: ["Line 1"] },
			{ name: "Gamma", north: 2000, east: 1000, lines: ["Line 1"] },
			{ name: "Omega", north: 3000, east: 1500, lines: ["Line 2"] },
		];
		const { stationsLookup, linesLookup } = lookupsFor(network);
		const fixes = [coarseFix(1700, 1020, 510), coarseFix(2000, 2010, 1010)];
		const run = await reconstructUndergroundRun(fixes, at(30, 15), at(2980, 1490), stationsLookup, linesLookup);
		expect(run).toBeNull();
	});
});

describe("reconstructUndergroundJourney", () => {
	// A line network with two single-line legs meeting at an interchange:
	// Alpha→Beta on Line 1, change at Beta, Beta→Omega on Line 3. No single
	// line serves Alpha↔Omega. Mid1 / Mid2 give each leg a station its coarse
	// fixes can hug.
	const IX_NETWORK: FakeStation[] = [
		{ name: "Alpha", north: 0, east: 0, lines: ["Line 1"] },
		{ name: "Mid1", north: 500, east: 0, lines: ["Line 1"] },
		{ name: "Beta", north: 1000, east: 0, lines: ["Line 1", "Line 3"] },
		{ name: "Mid2", north: 1500, east: 0, lines: ["Line 3"] },
		{ name: "Omega", north: 2000, east: 0, lines: ["Line 3"] },
	];

	it("splits a multi-line run at the interchange into two single-line legs", async () => {
		const { stationsLookup, linesLookup } = lookupsFor(IX_NETWORK);
		// Coarse fixes hug Mid1 (Line 1) then Mid2 (Line 3); good GPS surfaced
		// at Beta in between (the platform change).
		const coarse = [
			coarseFix(1700, 500, 0),
			coarseFix(1800, 510, 0),
			coarseFix(2300, 1500, 0),
			coarseFix(2400, 1510, 0),
		];
		const interchange = [coarseFix(2000, 1000, 0, 15), coarseFix(2100, 1010, 0, 15)];
		const legs = await reconstructUndergroundJourney(
			coarse,
			interchange,
			at(20, 0), // boarding near Alpha
			at(1980, 0), // alighting near Omega
			stationsLookup,
			linesLookup,
		);
		expect(legs).toHaveLength(2);
		expect(legs[0]).toMatchObject({ boardingStation: "Alpha", alightingStation: "Beta", line: "Line 1" });
		expect(legs[1]).toMatchObject({ boardingStation: "Beta", alightingStation: "Omega", line: "Line 3" });
	});

	it("returns the single through-line unchanged when one line serves both ends", async () => {
		const { stationsLookup, linesLookup } = lookupsFor(NETWORK);
		const fixes = [coarseFix(1700, 1020, 510), coarseFix(2000, 2010, 1010)];
		const legs = await reconstructUndergroundJourney(
			fixes,
			[],
			at(30, 15),
			at(2980, 1490),
			stationsLookup,
			linesLookup,
		);
		expect(legs).toHaveLength(1);
		expect(legs[0].line).toBe("Line 1");
	});

	it("does NOT split a single line whose OSM relation names differ (parallel-corridor guard)", async () => {
		// The 2026-06-23 false positive: one Metropolitan ride whose halves the
		// per-fix lookup labels "Metropolitan Line" then the shared-track relation
		// "Circle, Hammersmith & City and Metropolitan Lines". Different strings,
		// SAME physical line — must not be read as an interchange.
		const network: FakeStation[] = [
			{ name: "Alpha", north: 0, east: 0, lines: ["Metropolitan Line"] },
			{ name: "MidA", north: 500, east: 0, lines: ["Metropolitan Line"] },
			{
				name: "Beta",
				north: 1000,
				east: 0,
				lines: ["Metropolitan Line", "Circle, Hammersmith & City and Metropolitan Lines"],
			},
			{ name: "MidB", north: 1500, east: 0, lines: ["Circle, Hammersmith & City and Metropolitan Lines"] },
			{ name: "Omega", north: 2000, east: 0, lines: ["Circle, Hammersmith & City and Metropolitan Lines"] },
		];
		const { stationsLookup, linesLookup } = lookupsFor(network);
		const coarse = [
			coarseFix(1700, 500, 0),
			coarseFix(1800, 510, 0),
			coarseFix(2300, 1500, 0),
			coarseFix(2400, 1510, 0),
		];
		const interchange = [coarseFix(2000, 1000, 0, 15), coarseFix(2100, 1010, 0, 15)];
		const legs = await reconstructUndergroundJourney(
			coarse,
			interchange,
			at(20, 0),
			at(1980, 0),
			stationsLookup,
			linesLookup,
		);
		expect(legs).toHaveLength(0);
	});

	it("returns nothing when no interchange reconciles the two ends", async () => {
		// Alpha→Omega with no common line and no Beta-style interchange good
		// fixes — cannot honestly reconstruct.
		const network: FakeStation[] = [
			{ name: "Alpha", north: 0, east: 0, lines: ["Line 1"] },
			{ name: "Mid1", north: 500, east: 0, lines: ["Line 1"] },
			{ name: "Omega", north: 2000, east: 0, lines: ["Line 3"] },
		];
		const { stationsLookup, linesLookup } = lookupsFor(network);
		const coarse = [coarseFix(1700, 480, 0), coarseFix(1800, 510, 0)];
		const legs = await reconstructUndergroundJourney(coarse, [], at(20, 0), at(1980, 0), stationsLookup, linesLookup);
		expect(legs).toHaveLength(0);
	});
});

describe("annotateUndergroundRuns", () => {
	it("splits a walking host into walk → train → walk around an underground run", async () => {
		const { stationsLookup, linesLookup } = lookupsFor(NETWORK);
		// One walking segment that secretly contains a tube ride.
		const host = seg({ startTs: 1000, endTs: 4600, wayName: "High Street" });
		const rawFixes: CoarseFix[] = [
			// good GPS, walking near Alpha
			{ ts: 1100, ...at(20, 10), accuracy: 12 },
			{ ts: 1500, ...at(40, 25), accuracy: 14 },
			// coarse cell-network fixes underground, hugging Beta then Gamma
			coarseFix(1750, 1010, 505),
			coarseFix(2050, 1980, 1010),
			// good GPS again, walking near Delta
			{ ts: 2450, ...at(2980, 1490), accuracy: 13 },
			{ ts: 3000, ...at(2960, 1470), accuracy: 15 },
		];
		const result = await annotateUndergroundRuns([host], rawFixes, stationsLookup, linesLookup, async () => []);

		expect(result.map((s) => s.mode)).toEqual(["walking", "train", "walking"]);
		const train = result[1];
		expect(train.wayName).toBe("Alpha → Delta · Line 1");
		// The train spans the GPS-dark window: from the last good fix
		// before the coarse run (ts 1500) to the first one after (2450).
		expect(train.startTs).toBe(1500);
		expect(train.endTs).toBe(2450);
		// The walk segments bracket the train with no gaps or overlap.
		expect(result[0].startTs).toBe(1000);
		expect(result[0].endTs).toBe(1500);
		expect(result[2].startTs).toBe(2450);
		expect(result[2].endTs).toBe(4600);
	});

	it("leaves a segment with no coarse-fix run untouched", async () => {
		const { stationsLookup, linesLookup } = lookupsFor(NETWORK);
		const host = seg({ startTs: 1000, endTs: 2800 });
		// All real GPS — an ordinary walk, nothing underground.
		const rawFixes: CoarseFix[] = [
			{ ts: 1100, ...at(20, 10), accuracy: 12 },
			{ ts: 1800, ...at(600, 300), accuracy: 14 },
			{ ts: 2500, ...at(1200, 600), accuracy: 13 },
		];
		const result = await annotateUndergroundRuns([host], rawFixes, stationsLookup, linesLookup, async () => []);
		expect(result).toEqual([host]);
	});
});
