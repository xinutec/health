/**
 * `LEAN_DAY=solo` skips the TS cascade — measured, not asserted (#975).
 *
 * The other eight tenants take the TS arm as a THUNK, so `solo` is "don't call
 * it" and a spy proves the mode works. `day` is not like them: the TS arm is the
 * ENCLOSING ~1,340 lines of `computeVelocity` — the OSM enrichment loop, the
 * five corrections, the 38 passes, the sleep attribution, the timeline and the
 * episodes — and `leanDay` is invoked at the END of it. There is no thunk to
 * leave uncalled, so there is nothing for a spy to count.
 *
 * The instrument is therefore an OSM adapter that THROWS on every method. A day
 * with real movement cannot get through the enrichment loop without asking it
 * something, so:
 *
 *   - under `solo` the run completes  → the region did not execute
 *   - under `shadow` the run throws   → the region does execute, on this day
 *
 * The second half is what makes the first half evidence rather than a tautology.
 * A day that happened to need no OSM would pass the solo test while proving
 * nothing at all, and that is the failure mode this file is shaped to avoid.
 *
 * ⚠ This file mocks `lean-day.js` and `tests/lean-day-solo.test.ts` mocks
 * `day-serve.js` underneath the real one. They cannot share a file: this one
 * needs the tenant stubbed to observe what `velocity.ts` hands it, that one
 * needs the tenant real to test its own failure handling.
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
	shadowLeanDay: vi.fn(),
	serveLeanDay: vi.fn(),
}));

import { computeVelocityFromInputs } from "../src/geo/velocity.js";
import { shadowLeanDay, soloLeanDay } from "../src/lean/lean-day.js";

const solo = vi.mocked(soloLeanDay);
const shadow = vi.mocked(shadowLeanDay);

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
	shadow.mockReset();
	solo.mockResolvedValue(served);
	shadow.mockResolvedValue(undefined);
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

	// The control. Without this, the test above would pass on a day that needed
	// no OSM at all — green, and evidence of nothing.
	it("the same day under shadow DOES reach the adapter", async () => {
		process.env.LEAN_DAY = "shadow";
		await expect(computeVelocityFromInputs(movingDay(throwingOsmAdapter()))).rejects.toThrow(/the TS region ran/);
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

describe("solo sends the same request the tail would have sent", () => {
	/** Run the day under one mode and return the request the tenant received. */
	async function requestUnder(mode: "solo" | "shadow"): Promise<DayRequestInputs> {
		process.env.LEAN_DAY = mode;
		await computeVelocityFromInputs(movingDay(emptyOsmAdapter()));
		const spy = mode === "solo" ? solo : shadow;
		expect(spy).toHaveBeenCalledOnce();
		return spy.mock.calls[0][0] as DayRequestInputs;
	}

	// ⚠ THE CLAIM THE WHOLE MODE RESTS ON. Solo builds the request ~1,340 lines
	// before the tail does, from `inputs.biometrics` / `inputs.modeBiometrics`
	// rather than from the locals `biomForStaySplit` / `modeStats`. `velocity.ts`
	// asserts in a comment that those resolve to the same values on every branch.
	// A comment cannot fail; this can.
	it("builds a byte-identical request from inputs alone", async () => {
		const soloReq = await requestUnder("solo");
		const tailReq = await requestUnder("shadow");
		expect(soloReq).toEqual(tailReq);
	});

	// Guards the test above against passing vacuously. Two empty requests are
	// equal, and a fixture that drifted into producing one would turn the
	// comparison into a tautology without failing anything.
	it("compares a request that actually carries the day", async () => {
		const r = await requestUnder("solo");
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

describe("FOLD_CAPTURE and solo are mutually exclusive", () => {
	// The capture records the TS arm's answer as the GATE's input closure. Under
	// solo there is no TS answer, so a file written here would hold the fold's own
	// output and the gate would be the fold grading itself. Refusing is the only
	// honest option; writing it silently is the one this test exists to prevent.
	it("refuses rather than writing a capture of the fold's own output", async () => {
		process.env.LEAN_DAY = "solo";
		process.env.FOLD_CAPTURE = "/tmp/should-never-be-written";
		try {
			await expect(computeVelocityFromInputs(movingDay(throwingOsmAdapter()))).rejects.toThrow(/mutually exclusive/);
		} finally {
			delete process.env.FOLD_CAPTURE;
		}
	});
});
