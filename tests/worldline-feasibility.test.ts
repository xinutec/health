/**
 * Worldline-feasibility invariants (`src/eval/worldline-feasibility.ts`).
 *
 * Phase 0 of `docs/proposals/decoder-roadmap.md`: a
 * model-independent assertion on the *output* timeline that catches
 * physically-impossible journeys the cascade can emit. These are facts a
 * real worldline cannot violate, checked regardless of how the timeline was
 * produced:
 *
 *   - a train cannot board where you are not — two train legs with no
 *     relocating travel between them must share a station
 *     (`alight(prev) == board(next)`);
 *   - a train cannot ride from a station to itself.
 *
 * This is the regression baseline / standing gate for the journey-worldline
 * migration; it would have caught the 2026-06-22 "one Met ride emitted as two
 * legs both alighting at the same station" bug.
 */

import { describe, expect, it } from "vitest";
import { checkWorldlineFeasibility, type FeasibilityLeg } from "../src/eval/worldline-feasibility.js";

/** Compact leg builder; ts values are arbitrary but contiguous. */
function leg(over: Partial<FeasibilityLeg> & { mode: string }): FeasibilityLeg {
	return { startTs: 0, endTs: 60, ...over };
}

function train(board: string, alight: string, line?: string, ts = 0): FeasibilityLeg {
	return { startTs: ts, endTs: ts + 600, mode: "train", wayName: `${board} → ${alight}${line ? ` · ${line}` : ""}` };
}

describe("checkWorldlineFeasibility", () => {
	it("passes a clean interchange — alight == next board", () => {
		const legs = [train("Ashvale", "Carfax", "Metropolitan Line", 0), train("Carfax", "Farvale", "Jubilee Line", 600)];
		expect(checkWorldlineFeasibility(legs)).toEqual([]);
	});

	it("flags the 2026-06-22 bug: adjacent train legs that do NOT share a station", () => {
		// One Met ride mis-cut into two legs both alighting at Deepwell,
		// the second spuriously boarding mid-route at Carfax.
		const legs = [
			train("Ashvale", "Deepwell", "Metropolitan Line", 0),
			train("Carfax", "Deepwell", "Circle, Hammersmith & City and Metropolitan Lines", 600),
		];
		const v = checkWorldlineFeasibility(legs);
		expect(v).toHaveLength(1);
		expect(v[0].kind).toBe("rail-discontinuity");
		expect(v[0].detail).toContain("Carfax");
		expect(v[0].detail).toContain("Deepwell");
	});

	it("allows a different boarding station when a walking leg relocates the user between trains", () => {
		const legs = [
			train("Ashvale", "Deepwell", "Metropolitan Line", 0),
			leg({ mode: "walking", wayName: "Deepwell Road", startTs: 600, endTs: 900 }),
			train("Elmford", "Finsbury Park", "Victoria Line", 900),
		];
		expect(checkWorldlineFeasibility(legs)).toEqual([]);
	});

	it("flags trains separated only by a stationary leg (a sit does not relocate you between stations)", () => {
		const legs = [
			train("Ashvale", "Deepwell", "Metropolitan Line", 0),
			leg({ mode: "stationary", startTs: 600, endTs: 780 }),
			train("Carfax", "Farvale", "Jubilee Line", 780),
		];
		const v = checkWorldlineFeasibility(legs);
		expect(v).toHaveLength(1);
		expect(v[0].kind).toBe("rail-discontinuity");
	});

	it("allows trains separated by a stationary leg when they DO share the station (platform wait)", () => {
		const legs = [
			train("Ashvale", "Carfax", "Metropolitan Line", 0),
			leg({ mode: "stationary", startTs: 600, endTs: 780 }),
			train("Carfax", "Farvale", "Jubilee Line", 780),
		];
		expect(checkWorldlineFeasibility(legs)).toEqual([]);
	});

	it("flags a degenerate train leg that boards and alights at the same station", () => {
		const legs = [train("Deepwell", "Deepwell", "Metropolitan Line", 0)];
		const v = checkWorldlineFeasibility(legs);
		expect(v).toHaveLength(1);
		expect(v[0].kind).toBe("degenerate-train-leg");
	});

	it("does not assert continuity through a bare-line train leg with no board/alight", () => {
		// A train leg labelled only by line (e.g. an underground hop) carries no
		// station pair to chain on — we cannot assert, so we must not fabricate a
		// violation.
		const legs = [
			train("Ashvale", "Deepwell", "Metropolitan Line", 0),
			leg({ mode: "train", wayName: "Hammersmith & City Line", startTs: 600, endTs: 660 }),
			train("Carfax", "Farvale", "Jubilee Line", 660),
		];
		expect(checkWorldlineFeasibility(legs)).toEqual([]);
	});

	it("returns no violations for a day with no train legs", () => {
		const legs = [leg({ mode: "stationary" }), leg({ mode: "walking", startTs: 60, endTs: 120 })];
		expect(checkWorldlineFeasibility(legs)).toEqual([]);
	});
});

describe("checkWorldlineFeasibility — mode kinematics", () => {
	// ~250 m of latitude per 14 s ≈ 64 km/h — a vehicle-paced step.
	const FAST_DLAT = 0.00225;
	// ~28 m per 14 s ≈ 7 km/h — a brisk-walk step.
	const WALK_DLAT = 0.00025;

	function fixesFrom(t0: number, lat0: number, steps: number[]): { ts: number; lat: number; lon: number }[] {
		const out = [{ ts: t0, lat: lat0, lon: -0.28 }];
		for (const dLat of steps) {
			const prev = out[out.length - 1];
			out.push({ ts: prev.ts + 14, lat: prev.lat + dLat, lon: -0.28 });
		}
		return out;
	}

	it("flags a walking leg whose fixes sustain a vehicle-paced run (the stranded ride tail)", () => {
		// 8 consecutive ~64 km/h steps (a 2 km ride) then genuine walking pace.
		const points = fixesFrom(1000, 51.55, [
			...Array.from({ length: 8 }, () => FAST_DLAT),
			...Array.from({ length: 10 }, () => WALK_DLAT),
		]);
		const legs = [leg({ mode: "walking", startTs: 1000, endTs: 1000 + 18 * 14 })];
		const v = checkWorldlineFeasibility(legs, points);
		expect(v).toHaveLength(1);
		expect(v[0].kind).toBe("impossible-mode-kinematics");
		expect(v[0].detail).toMatch(/walking/);
	});

	it("does NOT flag a genuine walk", () => {
		const points = fixesFrom(
			1000,
			51.55,
			Array.from({ length: 20 }, () => WALK_DLAT),
		);
		const legs = [leg({ mode: "walking", startTs: 1000, endTs: 1000 + 20 * 14 })];
		expect(checkWorldlineFeasibility(legs, points)).toEqual([]);
	});

	it("does NOT flag a single reacquire teleport hop (one fast step is GPS, not a ride)", () => {
		const points = fixesFrom(1000, 51.55, [WALK_DLAT, WALK_DLAT, FAST_DLAT * 2, WALK_DLAT, WALK_DLAT]);
		const legs = [leg({ mode: "walking", startTs: 1000, endTs: 1000 + 5 * 14 })];
		expect(checkWorldlineFeasibility(legs, points)).toEqual([]);
	});

	it("does NOT flag fast jitter with no accumulated displacement (urban canyon)", () => {
		// alternating ±60 m at 14 s: every step ~15 km/h but net ~0.
		const points = [{ ts: 1000, lat: 51.55, lon: -0.28 }];
		for (let i = 1; i <= 12; i++) {
			points.push({ ts: 1000 + i * 14, lat: 51.55 + (i % 2 === 0 ? 0 : 0.00055), lon: -0.28 });
		}
		const legs = [leg({ mode: "walking", startTs: 1000, endTs: 1000 + 12 * 14 })];
		expect(checkWorldlineFeasibility(legs, points)).toEqual([]);
	});

	it("does NOT flag vehicle-paced fixes inside a driving leg (right mode, fast is fine)", () => {
		const points = fixesFrom(
			1000,
			51.55,
			Array.from({ length: 8 }, () => FAST_DLAT),
		);
		const legs = [leg({ mode: "driving", startTs: 1000, endTs: 1000 + 8 * 14 })];
		expect(checkWorldlineFeasibility(legs, points)).toEqual([]);
	});

	it("is inert when no points are supplied (label-only callers keep working)", () => {
		const legs = [leg({ mode: "walking", startTs: 1000, endTs: 2000 })];
		expect(checkWorldlineFeasibility(legs)).toEqual([]);
	});
});

describe("checkWorldlineFeasibility — pedestrian run inside a vehicle leg (#356)", () => {
	const FAST_DLAT = 0.00225; // ~64 km/h per 14 s step
	const WALK_DLAT = 0.00025; // ~7 km/h per 14 s step

	function fixesFrom(t0: number, lat0: number, steps: number[]): { ts: number; lat: number; lon: number }[] {
		const out = [{ ts: t0, lat: lat0, lon: -0.28 }];
		for (const dLat of steps) {
			const prev = out[out.length - 1];
			out.push({ ts: prev.ts + 14, lat: prev.lat + dLat, lon: -0.28 });
		}
		return out;
	}

	/** Per-minute step buckets covering [t0, t0+minutes*60) at a given cadence. */
	function cadence(t0: number, minutes: number, stepsPerMin: number): { ts: number; steps: number }[] {
		return Array.from({ length: minutes }, (_, i) => ({ ts: t0 + i * 60, steps: stepsPerMin }));
	}

	// The acceptance shape (2026-07-14 evening, abstracted): a ride at ~64 km/h
	// whose tail is 9 brisk-walk steps (~2 min, ~250 m net) with sustained
	// walking cadence — the user is out of the train and walking, but the leg
	// still owns the fixes.
	const rideThenWalkTail = fixesFrom(1000, 51.55, [
		...Array.from({ length: 8 }, () => FAST_DLAT),
		...Array.from({ length: 9 }, () => WALK_DLAT),
	]);
	const tailLegs = [leg({ mode: "train", startTs: 1000, endTs: 1000 + 17 * 14, wayName: "Ashvale → Carfax" })];

	it("flags a train leg whose tail sustains a pedestrian-paced stepping run (the stolen arrival walk)", () => {
		const steps = cadence(1000, 5, 110);
		const v = checkWorldlineFeasibility(tailLegs, rideThenWalkTail, steps);
		expect(v).toHaveLength(1);
		expect(v[0].kind).toBe("impossible-mode-kinematics");
		expect(v[0].detail).toMatch(/train/);
		expect(v[0].detail).toMatch(/pedestrian/);
	});

	it("does NOT flag the same pace shape when the wearer is not stepping (a signal-crawl into the platform)", () => {
		const steps = cadence(1000, 5, 4); // seated: incidental wrist movement only
		expect(checkWorldlineFeasibility(tailLegs, rideThenWalkTail, steps)).toEqual([]);
	});

	it("does NOT assert at all when no step data exists (cannot distinguish crawl from walk)", () => {
		expect(checkWorldlineFeasibility(tailLegs, rideThenWalkTail)).toEqual([]);
		expect(checkWorldlineFeasibility(tailLegs, rideThenWalkTail, [])).toEqual([]);
	});

	it("does NOT flag a station dwell mid-ride (near-zero pace accumulates no distance)", () => {
		const dwell = fixesFrom(1000, 51.55, [
			...Array.from({ length: 4 }, () => FAST_DLAT),
			...Array.from({ length: 9 }, () => 0.00002), // ~0.5 km/h jitter at the platform
			...Array.from({ length: 4 }, () => FAST_DLAT),
		]);
		const legs = [leg({ mode: "train", startTs: 1000, endTs: 1000 + 17 * 14 })];
		const steps = cadence(1000, 5, 110); // even with cadence: no net displacement, no assertion
		expect(checkWorldlineFeasibility(legs, dwell, steps)).toEqual([]);
	});

	it("does NOT flag a genuine ride end-to-end", () => {
		const ride = fixesFrom(
			1000,
			51.55,
			Array.from({ length: 17 }, () => FAST_DLAT),
		);
		const legs = [leg({ mode: "train", startTs: 1000, endTs: 1000 + 17 * 14 })];
		const steps = cadence(1000, 5, 110);
		expect(checkWorldlineFeasibility(legs, ride, steps)).toEqual([]);
	});

	it("does NOT flag a short pedestrian blip (under the duration floor)", () => {
		const blip = fixesFrom(1000, 51.55, [
			...Array.from({ length: 12 }, () => FAST_DLAT),
			...Array.from({ length: 3 }, () => WALK_DLAT), // 42 s of walk pace — could be a crawl
		]);
		const legs = [leg({ mode: "train", startTs: 1000, endTs: 1000 + 15 * 14 })];
		const steps = cadence(1000, 5, 110);
		expect(checkWorldlineFeasibility(legs, blip, steps)).toEqual([]);
	});
});
