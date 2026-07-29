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
