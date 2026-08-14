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
	/** Lines whose tracks pass near this station — what `linesAtPoint`
	 *  reports. */
	lines: string[];
	/** Lines that actually STOP here — what `stationsOnLine` reports.
	 *  Defaults to `lines`; they differ only where a line passes a station
	 *  it does not serve (the Finchley Road / North London Line case). */
	servedBy?: string[];
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

	/** The membership direction: which stations does this line serve? */
	const servedLookup = async (line: string): Promise<Array<{ name: string }>> =>
		stations.filter((s) => (s.servedBy ?? s.lines).includes(line)).map((s) => ({ name: s.name }));

	return { stationsLookup, linesLookup, servedLookup };
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
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(NETWORK);
		// Coarse fixes hug Beta and Gamma — stations only Line 1 serves.
		const fixes = [coarseFix(1700, 1020, 510), coarseFix(2000, 2010, 1010)];
		const run = await reconstructUndergroundRun(
			fixes,
			at(30, 15), // boarding by Alpha (served by Line 1 AND Line 2)
			at(2980, 1490), // alighting by Delta (also Line 1 AND Line 2)
			stationsLookup,
			linesLookup,
			servedLookup,
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
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(NETWORK);
		// One coarse fix is a blip, not a journey; the rest are real GPS.
		const fixes = [coarseFix(1700, 1020, 510), coarseFix(2000, 2010, 1010, 20)];
		const run = await reconstructUndergroundRun(
			fixes,
			at(30, 15),
			at(2980, 1490),
			stationsLookup,
			linesLookup,
			servedLookup,
		);
		expect(run).toBeNull();
	});

	it("returns null when both ends resolve to the same station (a platform wait, not a journey)", async () => {
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(NETWORK);
		// Coarse fixes near Beta, but the user never left Alpha's
		// vicinity — boarding and alighting both snap to Alpha.
		const fixes = [coarseFix(1700, 1020, 510), coarseFix(2000, 2010, 1010)];
		const run = await reconstructUndergroundRun(
			fixes,
			at(20, 10),
			at(40, 25),
			stationsLookup,
			linesLookup,
			servedLookup,
		);
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
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(network);
		const fixes = [coarseFix(1700, 1020, 510), coarseFix(2000, 2010, 1010)];
		const run = await reconstructUndergroundRun(
			fixes,
			at(30, 15),
			at(2980, 1490),
			stationsLookup,
			linesLookup,
			servedLookup,
		);
		expect(run).toBeNull();
	});

	it("rejects a line that merely PASSES the alighting station (the 06-28 North London line)", async () => {
		// The 2026-06-28 shape. A freight/Overground line runs past both ends —
		// it stops at the boarding station, and near the alighting one its
		// tracks only pass through on the way to a different station. Endpoint
		// proximity alone therefore singles it out, and the coarse fixes hug it
		// too (it parallels the tube for miles). Only membership knows better.
		const network: FakeStation[] = [
			{ name: "Islington", north: 0, east: 0, lines: ["Victoria Line", "Ghost line"] },
			{ name: "Midtown", north: 1500, east: 0, lines: ["Ghost line"] },
			{
				name: "Finchley",
				north: 3000,
				east: 0,
				lines: ["Metropolitan Line", "Ghost line"],
				servedBy: ["Metropolitan Line"], // the Ghost passes; it does not stop
			},
		];
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(network);
		const fixes = [coarseFix(1700, 1480, 0), coarseFix(2000, 1520, 0)];
		const run = await reconstructUndergroundRun(
			fixes,
			at(20, 0),
			at(2980, 0),
			stationsLookup,
			linesLookup,
			servedLookup,
		);
		expect(run).toBeNull();
	});

	it("reads through OSM's shared-track relation name when asked to (the split's halves)", async () => {
		// One end is tagged with the combined relation, the other with the plain
		// line. Same physical line — the intersection must see through the
		// naming, and the label must come out as the physical line. Off by
		// default: expanding the through-line question only ever ADDS a reading
		// the raw names denied, which is how a change of line becomes one ride.
		// `reconstructUndergroundJourney` owns when it is turned on.
		const network: FakeStation[] = [
			{
				name: "Cross",
				north: 0,
				east: 0,
				lines: ["Circle, Hammersmith & City and Metropolitan Lines"],
				servedBy: ["Metropolitan Line"],
			},
			{ name: "Midtown", north: 1500, east: 0, lines: ["Metropolitan Line"] },
			{ name: "Finchley", north: 3000, east: 0, lines: ["Metropolitan Line"] },
		];
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(network);
		const fixes = [coarseFix(1700, 1480, 0), coarseFix(2000, 1520, 0)];
		const args = [fixes, at(20, 0), at(2980, 0), stationsLookup, linesLookup, servedLookup] as const;
		expect(await reconstructUndergroundRun(...args)).toBeNull();
		expect(await reconstructUndergroundRun(...args, true)).toMatchObject({
			boardingStation: "Cross",
			alightingStation: "Finchley",
			line: "Metropolitan Line",
		});
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
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(IX_NETWORK);
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
			servedLookup,
		);
		expect(legs).toHaveLength(2);
		expect(legs[0]).toMatchObject({ boardingStation: "Alpha", alightingStation: "Beta", line: "Line 1" });
		expect(legs[1]).toMatchObject({ boardingStation: "Beta", alightingStation: "Omega", line: "Line 3" });
	});

	it("reconciles OSM's shared-track naming only after no change of line fits (the 05-22 ride)", async () => {
		// King's Cross tags the Metropolitan as the combined relation and
		// Finchley Road as the plain name, so the raw through-line question
		// answers "no line reaches both ends" about a ride that was Metropolitan
		// end to end. No interchange fits either — every mid-run surfacing is on
		// the same line — so the last resort reads through the naming (#185).
		const network: FakeStation[] = [
			{
				name: "Cross",
				north: 0,
				east: 0,
				lines: ["Circle, Hammersmith & City and Metropolitan Lines"],
				servedBy: ["Metropolitan Line"],
			},
			{ name: "Midtown", north: 1500, east: 0, lines: ["Metropolitan Line"] },
			{ name: "Finchley", north: 3000, east: 0, lines: ["Metropolitan Line"] },
		];
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(network);
		const coarse = [
			coarseFix(1700, 1450, 0),
			coarseFix(1800, 1480, 0),
			coarseFix(2000, 1520, 0),
			coarseFix(2100, 1550, 0),
		];
		const legs = await reconstructUndergroundJourney(
			coarse,
			[coarseFix(1900, 1500, 0, 15)], // a lone mid-ride surfacing at Midtown
			at(20, 0),
			at(2980, 0),
			stationsLookup,
			linesLookup,
			servedLookup,
		);
		expect(legs).toHaveLength(1);
		expect(legs[0]).toMatchObject({
			boardingStation: "Cross",
			alightingStation: "Finchley",
			line: "Metropolitan Line",
		});
	});

	it("returns the single through-line unchanged when one line serves both ends", async () => {
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(NETWORK);
		const fixes = [coarseFix(1700, 1020, 510), coarseFix(2000, 2010, 1010)];
		const legs = await reconstructUndergroundJourney(
			fixes,
			[],
			at(30, 15),
			at(2980, 1490),
			stationsLookup,
			linesLookup,
			servedLookup,
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
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(network);
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
			servedLookup,
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
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(network);
		const coarse = [coarseFix(1700, 480, 0), coarseFix(1800, 510, 0)];
		const legs = await reconstructUndergroundJourney(
			coarse,
			[],
			at(20, 0),
			at(1980, 0),
			stationsLookup,
			linesLookup,
			servedLookup,
		);
		expect(legs).toHaveLength(0);
	});

	it("keeps two surfacings apart even when they are seconds apart in time", async () => {
		// GPS that comes up mid-ride emits fixes seconds apart, so a time-only
		// clustering rule welds every surfacing along the route into one blob
		// whose centroid sits mid-track at no station at all. Here the ride
		// surfaces at the interchange (Beta) and again one stop later (Mid2):
		// the change is still at Beta.
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(IX_NETWORK);
		const coarse = [
			coarseFix(1700, 500, 0),
			coarseFix(1800, 510, 0),
			coarseFix(2300, 1500, 0),
			coarseFix(2400, 1510, 0),
		];
		const surfacings = [
			coarseFix(2000, 1000, 0, 15),
			coarseFix(2014, 1010, 0, 15),
			coarseFix(2150, 1500, 0, 15), // one stop on, still well inside MAX_COARSE_GAP_S
			coarseFix(2164, 1510, 0, 15),
		];
		const legs = await reconstructUndergroundJourney(
			coarse,
			surfacings,
			at(20, 0),
			at(1980, 0),
			stationsLookup,
			linesLookup,
			servedLookup,
		);
		expect(legs).toHaveLength(2);
		expect(legs[0]).toMatchObject({ alightingStation: "Beta", line: "Line 1" });
		expect(legs[1]).toMatchObject({ boardingStation: "Beta", line: "Line 3" });
	});

	it("splits the 06-28 return once the passing line stops masquerading as a through-line", async () => {
		// The whole 2026-06-28 defect in one network. A Ghost line touches both
		// ends by proximity, so the single-through-line branch used to answer
		// first and the change at Cross was never looked for. With membership
		// vetoing the Ghost, the two real legs surface — and the second one
		// needs the shared-track relation name to resolve at all.
		const network: FakeStation[] = [
			{ name: "Islington", north: 0, east: 0, lines: ["Victoria Line", "Ghost line"] },
			{ name: "Mid1", north: 500, east: 0, lines: ["Victoria Line", "Ghost line"] },
			{
				name: "Cross",
				north: 1000,
				east: 0,
				lines: ["Victoria Line", "Circle, Hammersmith & City and Metropolitan Lines"],
				servedBy: ["Victoria Line", "Metropolitan Line"],
			},
			{ name: "Mid2", north: 1500, east: 0, lines: ["Metropolitan Line"] },
			{
				name: "Finchley",
				north: 2000,
				east: 0,
				lines: ["Metropolitan Line", "Ghost line"],
				servedBy: ["Metropolitan Line"], // the Ghost passes on its way elsewhere
			},
		];
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(network);
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
			servedLookup,
		);
		expect(legs).toHaveLength(2);
		expect(legs[0]).toMatchObject({ boardingStation: "Islington", alightingStation: "Cross", line: "Victoria Line" });
		expect(legs[1]).toMatchObject({
			boardingStation: "Cross",
			alightingStation: "Finchley",
			line: "Metropolitan Line",
		});
	});
});

describe("annotateUndergroundRuns", () => {
	it("splits a walking host into walk → train → walk around an underground run", async () => {
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(NETWORK);
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
		const result = await annotateUndergroundRuns(
			[host],
			rawFixes,
			[],
			stationsLookup,
			linesLookup,
			async () => [],
			servedLookup,
		);

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

	it("stops growing at a real GPS recovery, so the ride does not annex the walk after it", async () => {
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(NETWORK);
		// The ride Alpha → Delta again, but after alighting at Delta the user
		// walks with good GPS and only THEN goes dark again (indoors at the
		// destination). That later darkness is a DIFFERENT blackout: the gap to
		// it is inside the contiguity rule, so only the recovery test can stop
		// the run annexing it, running the train past its own alight and
		// swallowing the walk — which is what 2026-05-20 and 06-16 did, for no
		// gain in the label at all.
		const rawFixes: CoarseFix[] = [
			{ ts: 1100, ...at(20, 10), accuracy: 12 },
			coarseFix(1200, 200, 100),
			coarseFix(1450, 1050, 525),
			coarseFix(1700, 1600, 800),
			coarseFix(1990, 2100, 1050),
			coarseFix(2200, 2600, 1300),
			{ ts: 2400, ...at(2980, 1490), accuracy: 13 }, // alighted at Delta
			// A sustained recovery: 60 s of good GPS walking away from Delta.
			{ ts: 2430, ...at(3040, 1520), accuracy: 14 },
			{ ts: 2460, ...at(3100, 1550), accuracy: 12 },
			// …and only then darkness again, indoors — 270 s after the last
			// tunnel fix, well inside MAX_COARSE_GAP_S.
			coarseFix(2470, 3200, 1600),
			coarseFix(2700, 3210, 1610),
			{ ts: 2900, ...at(3220, 1620), accuracy: 13 },
		];
		// The host ends just past the alight, so the darkness after it is the
		// classifier's next segment — territory the run may only annex on merit.
		const host = seg({ startTs: 1000, endTs: 2465 });
		const result = await annotateUndergroundRuns(
			[host],
			rawFixes,
			[],
			stationsLookup,
			linesLookup,
			async () => [],
			servedLookup,
		);

		expect(result.map((s) => s.mode)).toEqual(["walking", "train", "walking"]);
		// The ride still reads end to end — the recovery bound costs no label.
		expect(result[1].wayName).toBe("Alpha → Delta · Line 1");
		// …and it ends where the user alighted, not in the indoor darkness after.
		expect(result[1].endTs).toBe(2400);
	});

	it("does not let a lone accuracy blip in good coverage extend the ride past its alight", async () => {
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(NETWORK);
		// The same Alpha → Delta ride, alighting at ts 2400. Four minutes into
		// the walk away from Delta, ONE fix reports poor accuracy while sitting
		// among well-located fixes seconds and metres either side of it. GPS
		// never went dark there — the accuracy figure wobbled — but the gap to
		// it is inside MAX_COARSE_GAP_S, so the contiguity rule alone lets it
		// join the tunnel run and drag the train four minutes past the alight,
		// over a walk that is confirmed truth (2026-07-16 at 07:51:56Z).
		const rawFixes: CoarseFix[] = [
			{ ts: 1100, ...at(20, 10), accuracy: 12 },
			coarseFix(1450, 1050, 525),
			coarseFix(1700, 1600, 800),
			coarseFix(1990, 2100, 1050),
			{ ts: 2400, ...at(2980, 1490), accuracy: 13 }, // alighted at Delta
			// Walking away from Delta with good GPS throughout…
			{ ts: 2460, ...at(3040, 1520), accuracy: 14 },
			{ ts: 2520, ...at(3100, 1550), accuracy: 12 },
			{ ts: 2580, ...at(3160, 1580), accuracy: 15 },
			// …and the blip, 30 m from its neighbours on both sides.
			coarseFix(2640, 3190, 1595),
			{ ts: 2700, ...at(3220, 1610), accuracy: 13 },
			{ ts: 2760, ...at(3280, 1640), accuracy: 14 },
		];
		const host = seg({ startTs: 1000, endTs: 2800 });
		const result = await annotateUndergroundRuns(
			[host],
			rawFixes,
			[],
			stationsLookup,
			linesLookup,
			async () => [],
			servedLookup,
		);

		expect(result.map((s) => s.mode)).toEqual(["walking", "train", "walking"]);
		expect(result[1].wayName).toBe("Alpha → Delta · Line 1");
		expect(result[1].endTs).toBe(2400);
	});

	it("keeps a blip-shaped fix the rider has not yet walked clear of (the arrival itself)", async () => {
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(NETWORK);
		// Arriving is not a tidy event. The phone reacquires on the platform at
		// Delta, loses it again under the concourse roof, and settles outside —
		// so the last dark fix looks exactly like a blip, with good fixes close
		// on both sides. It is still the arrival: the rider has moved barely
		// 100 m, well inside the station's own footprint. Trimming it cost
		// 2026-07-07 six minutes off a ride the user confirmed ran to 17:45, and
		// left a phantom stay standing in the gap.
		const rawFixes: CoarseFix[] = [
			{ ts: 1100, ...at(20, 10), accuracy: 12 },
			coarseFix(1450, 1050, 525),
			coarseFix(1700, 1600, 800),
			coarseFix(1990, 2100, 1050),
			coarseFix(2280, 2900, 1450), // surfacing into Delta
			{ ts: 2330, ...at(2940, 1470), accuracy: 40 },
			{ ts: 2360, ...at(2960, 1480), accuracy: 30 },
			coarseFix(2390, 2980, 1490), // under the concourse roof — 90 m on
			{ ts: 2420, ...at(3000, 1500), accuracy: 25 },
			{ ts: 2600, ...at(3040, 1520), accuracy: 13 },
		];
		const host = seg({ startTs: 1000, endTs: 2800 });
		const result = await annotateUndergroundRuns(
			[host],
			rawFixes,
			[],
			stationsLookup,
			linesLookup,
			async () => [],
			servedLookup,
		);

		expect(result.map((s) => s.mode)).toEqual(["walking", "train", "walking"]);
		// The ride still runs to the far side of the arrival, not to the platform
		// reacquire 60 s earlier.
		expect(result[1].endTs).toBe(2420);
	});

	it("keeps a genuine blackout that a blip merely precedes", async () => {
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(NETWORK);
		// Only the TAIL is trimmed, and only while it is still blips. A blip
		// sitting inside the run does not shorten it: what ends the ride is the
		// last dark fix that GPS coverage cannot explain away.
		const rawFixes: CoarseFix[] = [
			{ ts: 1100, ...at(20, 10), accuracy: 12 },
			coarseFix(1450, 1050, 525),
			// A blip mid-ride, bracketed by a brief surfacing either side.
			{ ts: 1600, ...at(1580, 790), accuracy: 15 },
			coarseFix(1700, 1600, 800),
			{ ts: 1800, ...at(1620, 810), accuracy: 14 },
			// …then real darkness again, on to the alight.
			coarseFix(1990, 2100, 1050),
			coarseFix(2200, 2600, 1300),
			{ ts: 2400, ...at(2980, 1490), accuracy: 13 },
		];
		const host = seg({ startTs: 1000, endTs: 2800 });
		const result = await annotateUndergroundRuns(
			[host],
			rawFixes,
			[],
			stationsLookup,
			linesLookup,
			async () => [],
			servedLookup,
		);

		expect(result.map((s) => s.mode)).toEqual(["walking", "train", "walking"]);
		expect(result[1].wayName).toBe("Alpha → Delta · Line 1");
		expect(result[1].endTs).toBe(2400);
	});

	it("joins two dark runs across a change of trains, because the train moved between them", async () => {
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(NETWORK);
		// The 2026-07-02 shape. The ride goes dark, the rider changes trains at an
		// intermediate station, and the ride resumes. The phone reports the
		// interchange platform at confident accuracy throughout the change, so the
		// contiguity rule alone cuts the tunnel in two: the first piece spans 18 s
		// (under MIN_RUN_DURATION_S) and the second holds one fix (under
		// MIN_COARSE_FIXES), so NEITHER qualifies and the whole ride stays buried
		// in the walking host.
		//
		// What says it is one blackout is not how long the gap was or how the
		// platform fixes paced — it is that the darkness resumed 1.6 km further
		// down the line. The train went somewhere; the blackout continued.
		const rawFixes: CoarseFix[] = [
			{ ts: 1000, ...at(20, 10), accuracy: 12 }, // boarding, good GPS at Alpha
			coarseFix(1200, 900, 450), //               into the tunnel, hugging Beta
			coarseFix(1218, 1010, 505),
			// The change: four confident fixes over 265 s, all within ~50 m of the
			// Gamma platform.
			{ ts: 1255, ...at(1990, 1000), accuracy: 30 },
			{ ts: 1400, ...at(2010, 1010), accuracy: 20 },
			{ ts: 1480, ...at(1995, 1005), accuracy: 83 },
			{ ts: 1520, ...at(2005, 1000), accuracy: 20 },
			// Dark again on the second leg — and 1.6 km on from where it went dark.
			coarseFix(1551, 2600, 1300),
			{ ts: 1700, ...at(2980, 1490), accuracy: 13 }, // alighted at Delta
		];
		const host = seg({ startTs: 900, endTs: 2400 });
		const result = await annotateUndergroundRuns(
			[host],
			rawFixes,
			[],
			stationsLookup,
			linesLookup,
			async () => [],
			servedLookup,
		);

		expect(result.map((s) => s.mode)).toContain("train");
		const train = result.find((s) => s.mode === "train");
		expect(train?.wayName).toBe("Alpha → Delta · Line 1");
		expect(train?.startTs).toBe(1000);
		expect(train?.endTs).toBe(1700);
	});

	it("joins two dark runs across a gap the phone said nothing at all in", async () => {
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(NETWORK);
		// The case the bridging exists for in the first place: a deep tunnel where
		// the phone does not surface between the two dark stretches, so there is
		// nothing in the gap to testify either way. Silence is not evidence that
		// the ride ended — it is the ordinary shape of being underground — and the
		// displacement test is left to answer on its own.
		const rawFixes: CoarseFix[] = [
			{ ts: 900, ...at(20, 10), accuracy: 12 },
			// A short first stretch, too brief to be a ride on its own …
			coarseFix(1000, 300, 150),
			coarseFix(1100, 700, 350),
			// … 400 s of nothing whatsoever, and the darkness resumes 1.2 km on …
			coarseFix(1500, 1800, 900),
			coarseFix(1700, 2400, 1200),
			coarseFix(1900, 2900, 1450),
			{ ts: 2000, ...at(2990, 1495), accuracy: 13 },
		];
		const host = seg({ startTs: 850, endTs: 2400 });
		const result = await annotateUndergroundRuns(
			[host],
			rawFixes,
			[],
			stationsLookup,
			linesLookup,
			async () => [],
			servedLookup,
		);

		const trains = result.filter((s) => s.mode === "train");
		expect(trains).toHaveLength(1);
		expect(trains[0].wayName).toBe("Alpha → Delta · Line 1");
	});

	it("keeps two dark runs apart when the phone was heard travelling between them", async () => {
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(NETWORK);
		// The 2026-07-01 shape, and the case displacement ALONE gets wrong. The
		// ride ends at Gamma, the rider walks out of the station and off down the
		// street, and several minutes later the phone throws one more poor fix from
		// the doorway of somewhere. Endpoint to endpoint that pair looks exactly
		// like the 07-02 change of trains above — 315 s apart and 1432 m on,
		// measured — so a displacement test joins them and the ride swallows six
		// minutes of the walk.
		//
		// What separates them is not the endpoints but what sits BETWEEN. A change
		// of trains is a dwell: the phone, when heard at all, is heard from one
		// station. Here it is heard continuously and it is heard MOVING — 226 s of
		// 2-20 m fixes tracing the street, 606 m end to end on the day. Nothing in
		// that gap was ever dark, so there is no blackout to bridge, and a ride
		// cannot be reconstructed across ground the phone already reported walking.
		const rawFixes: CoarseFix[] = [
			{ ts: 900, ...at(20, 10), accuracy: 12 }, // boarding, good GPS at Alpha
			// The tunnel, and it stands on its own: 3 fixes over 218 s.
			coarseFix(1000, 300, 150),
			coarseFix(1100, 700, 350),
			coarseFix(1218, 1010, 505),
			// Out at Gamma and away on foot: confident fixes the whole way, and they
			// travel — 600 m from the first to the last.
			{ ts: 1255, ...at(1990, 1000), accuracy: 30 },
			{ ts: 1340, ...at(2180, 1180), accuracy: 8 },
			{ ts: 1420, ...at(2330, 1330), accuracy: 6 },
			{ ts: 1490, ...at(2420, 1420), accuracy: 12 },
			// One more poor fix from a doorway, and it happens to land by the next
			// station down the line — 2.2 km on from where the tunnel went dark, so
			// endpoint displacement alone reads it as the ride carrying on.
			coarseFix(1551, 2980, 1490),
			{ ts: 1700, ...at(2990, 1495), accuracy: 13 },
		];
		const host = seg({ startTs: 850, endTs: 2400 });
		const result = await annotateUndergroundRuns(
			[host],
			rawFixes,
			[],
			stationsLookup,
			linesLookup,
			async () => [],
			servedLookup,
		);

		// The true ride is the one that ends where the phone came back.
		const trains = result.filter((s) => s.mode === "train");
		expect(trains).toHaveLength(1);
		expect(trains[0].wayName).toBe("Alpha → Gamma · Line 1");
		expect(trains[0].endTs).toBeLessThanOrEqual(1255);
	});

	it("keeps two dark runs apart when the darkness resumes where it stopped (the indoor stay)", async () => {
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(NETWORK);
		// The counterpart, and the case a pace-based reading of the reacquire gets
		// WRONG: 2026-06-15's Centre M stay and 2026-05-22's Clinic C
		// stay. The rider arrives, sits indoors for an hour and a half on poor GPS,
		// and leaves. Measured on 06-15 the two dark stretches sit 5314 s apart and
		// the phone is 4 m from where it started — against 333 s and 3072 m for the
		// 07-02 change of trains above.
		//
		// Someone sitting still is stationary in exactly the way someone waiting on
		// a platform is, so pace cannot separate them and duration only can by
		// being tuned. Displacement does it outright: a blackout that resumes where
		// it stopped is a new episode, and joining these two invents a ride that
		// swallows the stay.
		const rawFixes: CoarseFix[] = [
			{ ts: 1000, ...at(20, 10), accuracy: 12 },
			// A ride that qualifies on its own — so this test is about whether the
			// run wrongly EXTENDS, not about whether anything is found at all.
			coarseFix(1200, 900, 450),
			coarseFix(1300, 1500, 750),
			coarseFix(1400, 2010, 1010),
			{ ts: 1500, ...at(2980, 1490), accuracy: 13 }, // arrived near Delta
			// …and an hour and a half indoors, the phone barely moving.
			{ ts: 3000, ...at(2984, 1492), accuracy: 40 },
			{ ts: 5000, ...at(2979, 1488), accuracy: 55 },
			coarseFix(6532, 2982, 1491), // dark again — 4 m from where it went dark
			coarseFix(6600, 2984, 1489),
		];
		const host = seg({ startTs: 900, endTs: 7000 });
		const result = await annotateUndergroundRuns(
			[host],
			rawFixes,
			[],
			stationsLookup,
			linesLookup,
			async () => [],
			servedLookup,
		);

		// The ride is carved out, and it ENDS at the arrival — the indoor darkness
		// an hour and a half later is not part of it.
		const train = result.find((s) => s.mode === "train");
		expect(train?.endTs).toBe(1500);
	});

	it("keeps a nearby later blackout apart even inside the interchange window", async () => {
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(NETWORK);
		// The case the gap ceiling CANNOT decide, and the one the displacement
		// test exists for: 2026-06-15's 945 s / 574 m and 583 s / 296 m gaps both
		// sit inside the interchange window, so only distance says they are new
		// blackouts. The rider arrives, then goes dark again 657 m away a quarter
		// of an hour later — a building at the destination, not a station down the
		// line. Under MIN_JOURNEY_M, so the ride must not reach for it.
		const rawFixes: CoarseFix[] = [
			{ ts: 1000, ...at(20, 10), accuracy: 12 },
			coarseFix(1200, 900, 450),
			coarseFix(1300, 1500, 750),
			coarseFix(1400, 2010, 1010),
			{ ts: 1500, ...at(2980, 1490), accuracy: 13 }, // arrived near Delta
			// 950 s later — inside MAX_INTERCHANGE_GAP_S — and only 657 m on.
			coarseFix(2350, 2600, 1300),
			coarseFix(2420, 2610, 1310),
		];
		const host = seg({ startTs: 900, endTs: 3000 });
		const result = await annotateUndergroundRuns(
			[host],
			rawFixes,
			[],
			stationsLookup,
			linesLookup,
			async () => [],
			servedLookup,
		);

		const train = result.find((s) => s.mode === "train");
		expect(train?.endTs).toBe(1500);
	});

	it("leaves the change of trains out of both rides, instead of splitting it between them", async () => {
		// 2026-07-12 at King's Cross: a Metropolitan leg, 198 m of walking between
		// platforms at 93 steps/min, then a Victoria leg. The changeover was being
		// bisected — half given to each ride — so the walk ended up inside a train
		// segment and #356's invariant called it what it was: a train leg
		// sustaining a pedestrian-paced stepping run.
		//
		// The rider is not on a train while walking between platforms. The gap
		// between one leg's last coarse fix and the next leg's first belongs to
		// neither ride; it is the change, and it keeps the host's own mode.
		const IX: FakeStation[] = [
			{ name: "Alpha", north: 0, east: 0, lines: ["Line 1"] },
			{ name: "Mid1", north: 500, east: 0, lines: ["Line 1"] },
			{ name: "Beta", north: 1000, east: 0, lines: ["Line 1", "Line 3"] },
			{ name: "Mid2", north: 1500, east: 0, lines: ["Line 3"] },
			{ name: "Omega", north: 2000, east: 0, lines: ["Line 3"] },
		];
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(IX);
		const rawFixes: CoarseFix[] = [
			{ ts: 1000, ...at(20, 0), accuracy: 12 }, // boarding at Alpha
			coarseFix(1700, 500, 0), //                 leg 1, hugging Mid1
			coarseFix(1800, 510, 0),
			// Surfaced at Beta — the platform change, on foot.
			{ ts: 2000, ...at(1000, 0), accuracy: 15 },
			{ ts: 2100, ...at(1010, 0), accuracy: 15 },
			coarseFix(2300, 1500, 0), //                leg 2, hugging Mid2
			coarseFix(2400, 1510, 0),
			{ ts: 2600, ...at(1980, 0), accuracy: 13 }, // alighting at Omega
		];
		const host = seg({ startTs: 900, endTs: 3000 });
		const result = await annotateUndergroundRuns(
			[host],
			rawFixes,
			[],
			stationsLookup,
			linesLookup,
			async () => [],
			servedLookup,
		);

		// walk in · ride · CHANGE · ride · walk out — the change is its own
		// segment, not two halves donated to the rides either side.
		expect(result.map((s) => s.mode)).toEqual(["walking", "train", "walking", "train", "walking"]);
		expect(result[1].wayName).toBe("Alpha → Beta · Line 1");
		expect(result[3].wayName).toBe("Beta → Omega · Line 3");
		// The changeover spans exactly the gap between the two rides' own fixes.
		expect(result[2].startTs).toBe(1800);
		expect(result[2].endTs).toBe(2300);
	});

	it("does not cut a sliver of a segment out of a changeover too short to stand alone", async () => {
		// The other side of the rule above. A cross-platform change takes seconds,
		// not minutes, and carving a 50 s segment out between the two rides buys a
		// fragment nobody can read. Under MIN_SIDE_DURATION_S the rides meet at the
		// midpoint as before — there is no walk worth naming.
		const IX: FakeStation[] = [
			{ name: "Alpha", north: 0, east: 0, lines: ["Line 1"] },
			{ name: "Mid1", north: 500, east: 0, lines: ["Line 1"] },
			{ name: "Beta", north: 1000, east: 0, lines: ["Line 1", "Line 3"] },
			{ name: "Mid2", north: 1500, east: 0, lines: ["Line 3"] },
			{ name: "Omega", north: 2000, east: 0, lines: ["Line 3"] },
		];
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(IX);
		const rawFixes: CoarseFix[] = [
			{ ts: 1000, ...at(20, 0), accuracy: 12 },
			coarseFix(1700, 500, 0),
			coarseFix(1800, 510, 0),
			{ ts: 1820, ...at(1000, 0), accuracy: 15 }, // the change, 50 s end to end
			coarseFix(1850, 1500, 0),
			coarseFix(1900, 1510, 0),
			{ ts: 2100, ...at(1980, 0), accuracy: 13 },
		];
		const result = await annotateUndergroundRuns(
			[seg({ startTs: 900, endTs: 2400 })],
			rawFixes,
			[],
			stationsLookup,
			linesLookup,
			async () => [],
			servedLookup,
		);

		expect(result.map((s) => s.mode)).toEqual(["walking", "train", "train", "walking"]);
		// The two rides abut at the midpoint of the changeover, as before.
		expect(result[1].endTs).toBe(1825);
		expect(result[2].startTs).toBe(1825);
	});

	it("leaves a segment with no coarse-fix run untouched", async () => {
		const { stationsLookup, linesLookup, servedLookup } = lookupsFor(NETWORK);
		const host = seg({ startTs: 1000, endTs: 2800 });
		// All real GPS — an ordinary walk, nothing underground.
		const rawFixes: CoarseFix[] = [
			{ ts: 1100, ...at(20, 10), accuracy: 12 },
			{ ts: 1800, ...at(600, 300), accuracy: 14 },
			{ ts: 2500, ...at(1200, 600), accuracy: 13 },
		];
		const result = await annotateUndergroundRuns(
			[host],
			rawFixes,
			[],
			stationsLookup,
			linesLookup,
			async () => [],
			servedLookup,
		);
		expect(result).toEqual([host]);
	});
});
