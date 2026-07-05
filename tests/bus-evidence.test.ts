/**
 * Bus-vs-car evidence for road-vehicle segments (task #247).
 *
 * First-principles discriminators, as weighted evidence (never a veto):
 *
 *   - **Boarding wait**: a 45s–5min standstill immediately before the
 *     vehicle pulls away, located AT a bus stop. Nobody stands still at
 *     a flag for two minutes to enter a taxi; everybody does for a bus.
 *     (Measured on the motivating leg: ~2 min at accuracy 3–4 m.)
 *   - **Mid-leg dwells at bus stops**: buses stop at the same fixed
 *     public locations every time; cars stop at signals. A dwell
 *     coinciding with a bus_stop node (and not merely a signal) counts;
 *     several of them are near-conclusive.
 *   - **Counter-evidence**: a leg with several dwells, none anywhere
 *     near a bus stop, leans taxi.
 *
 * Deliberately weak/absent signals: average speed (London buses and
 * cars both crawl ~13 km/h), biometrics (sitting either way).
 *
 * All coordinates are synthetic, anchored at (50.0, 5.0).
 */

import { describe, expect, it } from "vitest";
import {
	annotateBusEvidence,
	BUS_EVIDENCE_THRESHOLD_NATS,
	detectBoardingWait,
	detectVehicleDwells,
	scoreBusEvidence,
} from "../src/geo/bus-evidence.js";
import type { TransportMode } from "../src/geo/segments.js";

const T0 = 1_750_000_000;
const LAT_PER_M = 1 / 111_000;

/** A fix `metresAlong` a straight east-west street. */
function fix(ts: number, metresAlong: number) {
	return { ts, lat: 50.0, lon: 5.0 + (metresAlong * LAT_PER_M) / Math.cos((50 * Math.PI) / 180) };
}

/** Fixes simulating travel at `kmh` between two points in time, every 15s. */
function run(fromTs: number, toTs: number, fromM: number, kmh: number) {
	const out = [];
	for (let t = fromTs; t <= toTs; t += 15) {
		out.push(fix(t, fromM + ((t - fromTs) * kmh) / 3.6));
	}
	return out;
}

describe("detectBoardingWait", () => {
	it("finds a 2-minute standstill immediately before the leg", () => {
		const fixes = [...run(T0 - 120, T0 - 15, 0, 0.5), ...run(T0, T0 + 120, 10, 30)];
		const wait = detectBoardingWait(fixes, T0);
		expect(wait).not.toBeNull();
		expect(wait?.durationS).toBeGreaterThanOrEqual(90);
	});

	it("returns null when the vehicle pulls away from a rolling approach", () => {
		// Continuous motion right up to the leg start — a hailed taxi or a
		// car leaving a moving drop-off; no standstill to find.
		const fixes = run(T0 - 300, T0 + 120, 0, 25);
		expect(detectBoardingWait(fixes, T0)).toBeNull();
	});

	it("ignores a standstill further back than the lookback window", () => {
		const fixes = [...run(T0 - 600, T0 - 420, 0, 0.3), ...run(T0 - 400, T0 + 60, 5, 25)];
		expect(detectBoardingWait(fixes, T0)).toBeNull();
	});
});

describe("detectVehicleDwells", () => {
	it("finds a 30s mid-leg dwell between moving stretches", () => {
		const fixes = [
			...run(T0, T0 + 120, 0, 30), // moving
			...run(T0 + 135, T0 + 165, 1000, 0.5), // 30s standstill
			...run(T0 + 180, T0 + 300, 1010, 30), // moving again
		];
		const dwells = detectVehicleDwells(fixes, T0, T0 + 300);
		expect(dwells).toHaveLength(1);
		expect(dwells[0].durationS).toBeGreaterThanOrEqual(30);
	});

	it("ignores sub-threshold blips", () => {
		// One 10s slow pair, then immediately back at speed — a signal
		// touch-and-go, not a dwell.
		const fixes = [...run(T0, T0 + 120, 0, 30), fix(T0 + 130, 1005), ...run(T0 + 140, T0 + 260, 1100, 30)];
		expect(detectVehicleDwells(fixes, T0, T0 + 260)).toHaveLength(0);
	});
});

describe("scoreBusEvidence", () => {
	it("boarding wait at a stop + two stop dwells clears the threshold", () => {
		const r = scoreBusEvidence({
			boardingWaitS: 120,
			boardingNearestBusStopM: 12,
			dwells: [
				{ durationS: 25, nearestBusStopM: 18, nearestSignalM: null },
				{ durationS: 30, nearestBusStopM: 9, nearestSignalM: 60 },
			],
		});
		expect(r.total).toBeGreaterThan(BUS_EVIDENCE_THRESHOLD_NATS);
	});

	it("a boarding wait with no stop data is weak evidence on its own", () => {
		const r = scoreBusEvidence({ boardingWaitS: 120, boardingNearestBusStopM: null, dwells: [] });
		expect(r.total).toBeLessThan(BUS_EVIDENCE_THRESHOLD_NATS);
		expect(r.total).toBeGreaterThanOrEqual(0);
	});

	it("dwells only at signals score as any road vehicle (≈0)", () => {
		const r = scoreBusEvidence({
			boardingWaitS: null,
			boardingNearestBusStopM: null,
			dwells: [
				{ durationS: 30, nearestBusStopM: null, nearestSignalM: 10 },
				{ durationS: 25, nearestBusStopM: null, nearestSignalM: 14 },
			],
		});
		expect(Math.abs(r.total)).toBeLessThan(0.5);
	});

	it("many dwells with no stop anywhere near leans taxi (negative)", () => {
		const r = scoreBusEvidence({
			boardingWaitS: null,
			boardingNearestBusStopM: null,
			dwells: [
				{ durationS: 30, nearestBusStopM: null, nearestSignalM: null },
				{ durationS: 25, nearestBusStopM: null, nearestSignalM: 12 },
				{ durationS: 40, nearestBusStopM: null, nearestSignalM: null },
			],
		});
		expect(r.total).toBeLessThan(0);
	});

	it("a dwell near BOTH a stop and a signal earns only partial credit", () => {
		const both = scoreBusEvidence({
			boardingWaitS: null,
			boardingNearestBusStopM: null,
			dwells: [{ durationS: 30, nearestBusStopM: 15, nearestSignalM: 12 }],
		});
		const stopOnly = scoreBusEvidence({
			boardingWaitS: null,
			boardingNearestBusStopM: null,
			dwells: [{ durationS: 30, nearestBusStopM: 15, nearestSignalM: null }],
		});
		expect(both.total).toBeGreaterThan(0);
		expect(both.total).toBeLessThan(stopOnly.total);
	});

	it("stop-dwell credit is capped — a long crawl cannot run away", () => {
		const many = scoreBusEvidence({
			boardingWaitS: null,
			boardingNearestBusStopM: null,
			dwells: Array.from({ length: 10 }, () => ({ durationS: 30, nearestBusStopM: 10, nearestSignalM: null })),
		});
		const three = scoreBusEvidence({
			boardingWaitS: null,
			boardingNearestBusStopM: null,
			dwells: Array.from({ length: 3 }, () => ({ durationS: 30, nearestBusStopM: 10, nearestSignalM: null })),
		});
		expect(many.total).toBe(three.total);
	});
});

describe("annotateBusEvidence (orchestrator)", () => {
	const seg = {
		startTs: T0,
		endTs: T0 + 10 * 60,
		mode: "driving" as TransportMode,
		refinedMode: undefined as TransportMode | undefined,
	};
	/** Boarding wait + one mid-leg dwell, both standstills detectable. */
	const busShapedFixes = [
		...run(T0 - 120, T0 - 15, 0, 0.5), // boarding wait
		...run(T0, T0 + 240, 10, 30), // moving
		...run(T0 + 255, T0 + 285, 2010, 0.5), // 30s stop dwell
		...run(T0 + 300, T0 + 600, 2020, 30), // moving
	];

	it("flips a driving leg to bus when stops resolve at the wait + dwell", async () => {
		const osm = {
			async nearbyTransitStops() {
				return [{ subtype: "bus_stop", distanceM: 12 }];
			},
		};
		const out = await annotateBusEvidence([seg], busShapedFixes, osm);
		expect(out[0].vehicleKind).toBe("bus");
	});

	it("leaves the leg as driving when no stops are anywhere near", async () => {
		const osm = {
			async nearbyTransitStops() {
				return [];
			},
		};
		const out = await annotateBusEvidence([seg], busShapedFixes, osm);
		expect(out[0].vehicleKind).toBeUndefined();
	});

	it("never judges non-driving segments", async () => {
		const osm = {
			async nearbyTransitStops() {
				throw new Error("must not be called");
			},
		};
		const train = { ...seg, mode: "train" as TransportMode };
		const out = await annotateBusEvidence([train], busShapedFixes, osm);
		expect(out[0].vehicleKind).toBeUndefined();
	});
});

describe("detectBoardingWait boundary placement", () => {
	it("finds the wait when the boundary sits one moving fix into the leg", () => {
		// The classifier's segment start IS the pull-away fix; the
		// standstill ends one pair earlier. Measured shape of the
		// motivating leg.
		const fixes = [...run(T0 - 135, T0 - 30, 0, 0.5), fix(T0 - 15, 60), fix(T0, 185)];
		const wait = detectBoardingWait(fixes, T0);
		expect(wait).not.toBeNull();
		expect(wait?.durationS).toBeGreaterThanOrEqual(90);
	});
});
