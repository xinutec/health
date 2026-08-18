/**
 * The fold IS the day: what `computeVelocity` returns comes from it (#975).
 *
 * # What this file used to be, and why it shrank
 *
 * It measured that `LEAN_DAY=solo` SKIPPED the ~1,420-line TS cascade, using an
 * OSM adapter that throws as the instrument and a `shadow` run as the control:
 * solo completed, shadow threw, so the region demonstrably did not execute.
 *
 * #975 deleted the region. Those tests are gone rather than adapted, because
 * the property they measured cannot be stated any more — there is no second arm
 * to skip, no `shadow` to contrast with, and no tail to build a rival request.
 * A test kept alive past its subject reads as coverage and asserts nothing.
 *
 * What survives is what is still true and still worth breaking a build over:
 * the returned day comes from the fold, and the fields that do NOT come from
 * the fold are still produced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassificationInputs, RawPhonetrackFix } from "../src/geo/classification-inputs.js";
import type { OsmAdapter } from "../src/geo/osm-adapter.js";
import type { DayRequestInputs } from "../src/lean/fold-capture.js";

// `leanDayMode` stays REAL — it is what reads the env, and stubbing it would
// test this file's idea of the flag rather than the tenant's.
vi.mock("../src/lean/lean-day.js", async (orig) => ({
	...(await orig<typeof import("../src/lean/lean-day.js")>()),
	soloLeanDay: vi.fn(),
}));

import { computeVelocityFromInputs } from "../src/geo/velocity.js";
import { soloLeanDay } from "../src/lean/lean-day.js";

const solo = vi.mocked(soloLeanDay);

/** Throws if any method is called. Under solo nothing may reach it. */
function throwingOsmAdapter(): OsmAdapter {
	const boom = (name: string) => (): never => {
		throw new Error(`OSM adapter method ${name} called — the TS region ran`);
	};
	return {
		nearbyWays: boom("nearbyWays"),
		nearbyStations: boom("nearbyStations"),
		nearbyLandmarks: boom("nearbyLandmarks"),
		linesAtPoint: boom("linesAtPoint"),
		reverseGeocode: boom("reverseGeocode"),
		nearbyTransitStops: boom("nearbyTransitStops"),
		stationsOnLine: boom("stationsOnLine"),
		drivableRoads: boom("drivableRoads"),
		walkableRoads: boom("walkableRoads"),
		buildingsNear: boom("buildingsNear"),
	} as unknown as OsmAdapter;
}

/** Answers everything with nothing. Lets the TS region RUN to completion so the
 *  request it builds at the tail can be compared against solo's. */
function emptyOsmAdapter(): OsmAdapter {
	return {
		nearbyWays: async () => [],
		nearbyStations: async () => [],
		nearbyLandmarks: async () => [],
		linesAtPoint: async () => new Set<string>(),
		reverseGeocode: async () => null,
		nearbyTransitStops: async () => [],
		stationsOnLine: async () => [],
		drivableRoads: async () => [],
		walkableRoads: async () => [],
		buildingsNear: async () => [],
	} as unknown as OsmAdapter;
}

/** 2026-05-15 00:00 Europe/London, in unix seconds. */
const DAY_START = Math.floor(Date.UTC(2026, 4, 14, 23, 0, 0) / 1000);

const fix = (offsetS: number, lat: number, lon: number, battery: number | null = 80): RawPhonetrackFix => ({
	ts: DAY_START + offsetS,
	lat,
	lon,
	altitude: null,
	speed: null,
	accuracy: 10,
	battery,
});

/**
 * A day with a stay, a walk and a second stay — enough shape that the cascade
 * has real work and the enrichment loop has somewhere to ask about.
 *
 * Every field the fold's request reads is deliberately NON-EMPTY. An input
 * closure of empty arrays would make the request-equality test below pass
 * without comparing anything, which is the way that test could look green and
 * measure nothing.
 */
function movingDay(osm: OsmAdapter): ClassificationInputs {
	const fixes: RawPhonetrackFix[] = [];
	// 09:00–10:00, parked at one spot.
	for (let i = 0; i < 30; i++) fixes.push(fix(9 * 3600 + i * 120, 51.5074, -0.1278));
	// 10:00–10:30, moving east at a walking pace.
	for (let i = 0; i < 15; i++) fixes.push(fix(10 * 3600 + i * 120, 51.5074, -0.1278 + i * 0.0008));
	// 10:30–11:30, parked at the destination.
	for (let i = 0; i < 30; i++) fixes.push(fix(10.5 * 3600 + i * 120, 51.5074, -0.1166, 60));

	return {
		identity: { userId: "pippijn", date: "2026-05-15", displayTz: "Europe/London" },
		phonetrack: {
			today: fixes,
			morning: [fix(1 * 3600, 51.5074, -0.1278)],
			priorEvening: [fix(-2 * 3600, 51.5074, -0.1278)],
		},
		knownPlaces: [],
		biometrics: {
			hr: Array.from({ length: 20 }, (_, i) => ({ ts: DAY_START + 9 * 3600 + i * 300, bpm: 62 + i })),
			sleep: [{ startTs: DAY_START + 3600, endTs: DAY_START + 5 * 3600, stage: "asleep" }],
			steps: Array.from({ length: 20 }, (_, i) => ({ ts: DAY_START + 10 * 3600 + i * 60, steps: 40 })),
		},
		modeBiometrics: [
			{
				mode: "walking",
				hrMean: 95,
				hrStd: 8,
				hrSampleCount: 120,
				cadenceMean: 105,
				cadenceStd: 9,
				cadenceSampleCount: 120,
				speedMean: 4.8,
				speedStd: 0.6,
				speedSampleCount: 120,
				sampleCount: 120,
			},
		],
		hsmmDecode: null,
		railRouteCache: [],
		osm,
		homeTz: "Europe/London",
		sleepWindows: [{ startTs: DAY_START + 3600, endTs: DAY_START + 5 * 3600, tz: "Europe/London", minutesAsleep: 210 }],
		emptyDayBracket: null,
	};
}

/** What the fold would have answered. Shapes only — this file measures which
 *  code RAN, not what the cascade computes. */
const served = { segs: [], states: [], episodes: [] };

beforeEach(() => {
	solo.mockReset();
	solo.mockResolvedValue(served);
});

afterEach(() => {
	delete process.env.LEAN_DAY;
	vi.restoreAllMocks();
});

describe("solo does not execute the TS region", () => {
	// ⚠ THE POINT OF THE MODE. `on` computes the whole cascade and then returns
	// Lean's answer instead, which is why nine tenants at `on` deleted zero lines
	// of TypeScript. If this regresses, the deletion sweep that follows would
	// remove code that is still executing.
	it("completes with an OSM adapter that throws on every call", async () => {
		process.env.LEAN_DAY = "solo";
		const out = await computeVelocityFromInputs(movingDay(throwingOsmAdapter()));
		expect(solo).toHaveBeenCalledOnce();
		expect(out.segments).toEqual([]);
	});

	// Solo answers from the fold, not from a TS arm that quietly still ran.
	it("returns the fold's three arrays", async () => {
		process.env.LEAN_DAY = "solo";
		const segs = [{ startTs: 1, endTs: 2, mode: "stationary" }] as never;
		solo.mockResolvedValue({ segs, states: [], episodes: [] });
		const out = await computeVelocityFromInputs(movingDay(throwingOsmAdapter()));
		expect(out.segments).toBe(segs);
	});

	// Battery is computed from the RAW in-day fixes before the skipped region
	// (`velocity.ts`), so solo must still produce it. It is the one returned
	// field that is neither the fold's nor trivially derived from the head.
	it("still returns the battery trace, which is computed before the region", async () => {
		process.env.LEAN_DAY = "solo";
		const out = await computeVelocityFromInputs(movingDay(throwingOsmAdapter()));
		expect(out.battery.length).toBeGreaterThan(0);
	});
});

describe("the request carries the day", () => {
	/** Run the day and return the request the fold received. */
	async function requestUnder(): Promise<DayRequestInputs> {
		process.env.LEAN_DAY = "solo";
		await computeVelocityFromInputs(movingDay(emptyOsmAdapter()));
		expect(solo).toHaveBeenCalledOnce();
		return solo.mock.calls[0][0] as DayRequestInputs;
	}

	// Guards the test above against passing vacuously. Two empty requests are
	// equal, and a fixture that drifted into producing one would turn the
	// comparison into a tautology without failing anything.
	it("compares a request that actually carries the day", async () => {
		const r = await requestUnder();
		expect(r.segsRaw.length).toBeGreaterThan(0);
		expect(r.modeStats.length).toBeGreaterThan(0);
		expect(r.obs.points.length).toBeGreaterThan(0);
		expect(r.obs.rawFixes.length).toBeGreaterThan(0);
		expect(r.obs.displayFixes.length).toBeGreaterThan(0);
		expect(r.obs.steps.length).toBeGreaterThan(0);
		expect(r.obs.hr.length).toBeGreaterThan(0);
		expect(r.obs.sleep.length).toBeGreaterThan(0);
		expect(r.tail?.morningRaw.length).toBeGreaterThan(0);
		expect(r.tail?.prevEveningRaw.length).toBeGreaterThan(0);
		expect(r.tail?.rawSleep.length).toBeGreaterThan(0);
	});
});
