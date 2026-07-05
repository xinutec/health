import { describe, expect, it } from "vitest";
import { classifyMode, filterGpsTrack, type GpsPoint } from "../src/geo/kalman.js";

describe("filterGpsTrack", () => {
	it("returns empty for empty input", () => {
		expect(filterGpsTrack([])).toEqual([]);
	});

	it("returns single point with zero speed", () => {
		const result = filterGpsTrack([{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 10 }]);
		expect(result).toHaveLength(1);
		expect(result[0].speed_kmh).toBe(0);
	});

	it("calculates speed for two points", () => {
		// Two points ~111m apart (0.001 degrees latitude), 10 seconds apart
		// Expected speed: ~40 km/h
		const points: GpsPoint[] = [
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 },
			{ ts: 1010, lat: 52.001, lon: 5.0, accuracy: 5 },
		];
		const result = filterGpsTrack(points);
		expect(result).toHaveLength(2);
		expect(result[1].speed_kmh).toBeGreaterThan(30);
		expect(result[1].speed_kmh).toBeLessThan(50);
	});

	it("smooths out a GPS spike", () => {
		// Moving steadily north, then one point jumps east, then continues north
		const points: GpsPoint[] = [
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 },
			{ ts: 1030, lat: 52.0003, lon: 5.0, accuracy: 5 },
			{ ts: 1060, lat: 52.0006, lon: 5.0, accuracy: 5 },
			{ ts: 1090, lat: 52.0009, lon: 5.005, accuracy: 5 }, // spike east
			{ ts: 1120, lat: 52.0012, lon: 5.0, accuracy: 5 },
			{ ts: 1150, lat: 52.0015, lon: 5.0, accuracy: 5 },
		];
		const result = filterGpsTrack(points);

		// The spike point's longitude should be pulled back toward 5.0
		const spikePoint = result[3];
		expect(spikePoint.lon).toBeLessThan(5.005); // smoothed toward the track
		expect(spikePoint.lon).toBeGreaterThan(5.0); // but not completely (filter is gradual)
	});

	it("handles stationary points (should show ~0 speed)", () => {
		const points: GpsPoint[] = [];
		for (let i = 0; i < 10; i++) {
			points.push({
				ts: 1000 + i * 30,
				lat: 52.0 + (Math.random() - 0.5) * 0.00005, // ±5m noise
				lon: 5.0 + (Math.random() - 0.5) * 0.00005,
				accuracy: 10,
			});
		}
		const result = filterGpsTrack(points);
		// After a few points, speed should settle near 0
		const lastFew = result.slice(-3);
		for (const p of lastFew) {
			expect(p.speed_kmh).toBeLessThan(5);
		}
	});

	it("skips duplicate timestamps", () => {
		const points: GpsPoint[] = [
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 },
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 }, // duplicate
			{ ts: 1030, lat: 52.001, lon: 5.0, accuracy: 5 },
		];
		const result = filterGpsTrack(points);
		expect(result).toHaveLength(2); // duplicate skipped
	});

	it("resets on teleport (gap > 5 min + implied speed > 200 km/h)", () => {
		// Phone indoors for 10 minutes, then GPS fix 50km away (teleport, not real movement)
		const points: GpsPoint[] = [
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 },
			{ ts: 1030, lat: 52.001, lon: 5.0, accuracy: 5 },
			{ ts: 1660, lat: 52.5, lon: 5.5, accuracy: 5 }, // 10 min gap, ~60km away → ~360 km/h implied
		];
		const result = filterGpsTrack(points);
		expect(result).toHaveLength(3);
		// After teleport reset, speed should be 0 (not 360 km/h)
		expect(result[2].speed_kmh).toBe(0);
	});

	it("does NOT reset on short gap with reasonable speed", () => {
		// 6 min gap but only 2km away → ~20 km/h, reasonable (cycling)
		const points: GpsPoint[] = [
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 },
			{ ts: 1030, lat: 52.001, lon: 5.0, accuracy: 5 },
			{ ts: 1390, lat: 52.018, lon: 5.0, accuracy: 5 }, // 6 min gap, ~2km → ~20 km/h
		];
		const result = filterGpsTrack(points);
		expect(result).toHaveLength(3);
		// Should NOT reset — speed should be > 0
		expect(result[2].speed_kmh).toBeGreaterThan(0);
	});

	it("resets on tracking gap (dt ≥ 10 min AND distance ≥ 500m, even at modest implied speed)", () => {
		// Phone tracking turned off mid-trip: 10 min later, 5 km away.
		// Implied speed across the gap = 30 km/h — old rule wouldn't reset.
		// The post-gap fix should reflect the *real* driving speed via forward-
		// look (~67 km/h here), not the fake 30 km/h average across the gap.
		const points: GpsPoint[] = [
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 },
			{ ts: 1030, lat: 52.0001, lon: 5.0, accuracy: 5 }, // stationary
			{ ts: 1630, lat: 52.045, lon: 5.0, accuracy: 5 }, // 10 min gap, 5km
			{ ts: 1660, lat: 52.05, lon: 5.0, accuracy: 5 }, // continued motion (~67 km/h)
		];
		const result = filterGpsTrack(points);
		expect(result).toHaveLength(4);
		// > 50 means: not the ~30 km/h implied-across-gap rate AND not 0.
		// Only achievable with both the loosened reset rule AND forward-look.
		expect(result[2].speed_kmh).toBeGreaterThan(50);
		expect(result[2].speed_kmh).toBeLessThan(200);
	});

	it("post-reset fix uses forward-look speed (not 0) when there's a next fix", () => {
		// Big gap, then two close fixes showing real motion
		const points: GpsPoint[] = [
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 },
			{ ts: 1030, lat: 52.0001, lon: 5.0, accuracy: 5 },
			{ ts: 5000, lat: 52.05, lon: 5.0, accuracy: 5 }, // teleport reset triggers
			{ ts: 5030, lat: 52.0517, lon: 5.0, accuracy: 5 }, // 0.0017° lat = ~190m in 30s → ~22 km/h
		];
		const result = filterGpsTrack(points);
		expect(result).toHaveLength(4);
		expect(result[2].speed_kmh).toBeGreaterThan(0); // not the silent stationary fix
	});

	it("the FIX AFTER a reset reflects real motion (no overshoot from v=0 prior)", () => {
		// Bug being fixed: at reset, the code computes a forward-look velocity
		// and emits it on the reset row, but resets the Kalman STATE with v=0.
		// One predict step later, the v=0 prior + accumulated pv produces a
		// large Kalman gain on velocity, and the post-reset+1 fix overshoots
		// the true motion by ~30%. The fix is to seed the Kalman state's
		// velocity from the same forward-look estimate.
		const points: GpsPoint[] = [
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 },
			// Large gap → reset triggers at t=5000
			{ ts: 5000, lat: 52.05, lon: 5.0, accuracy: 5 },
			// Continue moving north at ~26 km/h (about 222m every 30s)
			{ ts: 5030, lat: 52.052, lon: 5.0, accuracy: 5 },
			{ ts: 5060, lat: 52.054, lon: 5.0, accuracy: 5 },
		];
		const result = filterGpsTrack(points);
		expect(result).toHaveLength(4);
		// Reset row itself: forward-look gives ~26 km/h (existing behaviour).
		expect(result[1].speed_kmh).toBeGreaterThan(20);
		expect(result[1].speed_kmh).toBeLessThan(32);
		// Post-reset+1: should track the true motion, not overshoot. Without
		// the seed this read ~35 km/h; with the seed it stays near 26.
		expect(result[2].speed_kmh).toBeGreaterThan(20);
		expect(result[2].speed_kmh).toBeLessThan(32);
	});

	it("post-reset fix has speed=0 when there's no next fix (last point)", () => {
		const points: GpsPoint[] = [
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 },
			{ ts: 5000, lat: 52.05, lon: 5.0, accuracy: 5 }, // teleport reset, no follow-up
		];
		const result = filterGpsTrack(points);
		expect(result).toHaveLength(2);
		expect(result[1].speed_kmh).toBe(0);
	});

	it("resets on gaps > 1 hour", () => {
		const points: GpsPoint[] = [
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 },
			{ ts: 1030, lat: 52.001, lon: 5.0, accuracy: 5 },
			{ ts: 5000, lat: 53.0, lon: 6.0, accuracy: 5 }, // 1+ hour gap, different location
		];
		const result = filterGpsTrack(points);
		expect(result).toHaveLength(3);
		// After reset, speed should be 0 (no velocity history)
		expect(result[2].speed_kmh).toBe(0);
	});

	it("gates a single-fix GPS teleport spike (underground tube garbage)", () => {
		// Reproduces the morning-tube failure: the user is stationary at a
		// station, then goes underground. The phone falls back to cell-tower
		// triangulation and emits a fix ~2.8 km away — implying ~480 km/h
		// over a 12 s gap. The old code's teleport-reset only fires for
		// dt > 300 s, so a 12 s teleport sailed through and the filter
		// trusted it, producing a 480 km/h speed.
		//
		// Synthetic anchor: middle-of-nowhere coords. STATION_A at
		// (50.0, 5.0); the garbage fix teleports ~2.8 km NE.
		const points: GpsPoint[] = [];
		// 8 fixes stationary at STATION_A, 15 s apart.
		for (let i = 0; i < 8; i++) {
			points.push({ ts: 1000 + i * 15, lat: 50.0, lon: 5.0, accuracy: 20 });
		}
		// One garbage teleport fix 12 s later, ~2.8 km NE (implies ~480 km/h).
		points.push({ ts: 1000 + 8 * 15 - 3, lat: 50.018, lon: 5.025, accuracy: 20 });
		// 8 more fixes back at STATION_A — the spike was transient.
		for (let i = 0; i < 8; i++) {
			points.push({ ts: 1000 + 9 * 15 + i * 15, lat: 50.0, lon: 5.0, accuracy: 20 });
		}
		const result = filterGpsTrack(points);
		// No filtered point may carry an implausible speed. A real GPS
		// teleport spike must not become a 480 km/h reading.
		const maxSpeed = Math.max(...result.map((p) => p.speed_kmh));
		expect(maxSpeed, `max filtered speed ${maxSpeed} km/h — spike not gated`).toBeLessThan(120);
	});

	it("does NOT gate sustained high speed (a plane keeps its speed)", () => {
		// Positive control: innovation gating must not reject genuine
		// fast travel. A plane at ~600 km/h emits fixes ~5 km apart every
		// 30 s — each fix IS consistent with the filter's velocity state,
		// so none is gated.
		const points: GpsPoint[] = [];
		// 600 km/h = 166.7 m/s; over 30 s = 5000 m ≈ 0.0449 deg lat.
		const stepDeg = 0.0449;
		for (let i = 0; i < 15; i++) {
			points.push({ ts: 1000 + i * 30, lat: 50.0 + i * stepDeg, lon: 5.0, accuracy: 30 });
		}
		const result = filterGpsTrack(points);
		// After the filter settles, speed should track ~600 km/h, not be
		// gated down to near-zero.
		const settled = result.slice(-4);
		for (const p of settled) {
			expect(p.speed_kmh, `plane speed gated to ${p.speed_kmh} km/h`).toBeGreaterThan(400);
		}
	});

	it("produces consistent speed for constant velocity", () => {
		// Simulate walking north at ~5 km/h for 2 minutes
		// 5 km/h = 1.39 m/s ≈ 0.0000125 deg/s latitude
		const points: GpsPoint[] = [];
		const vDegPerSec = 0.0000125;
		for (let i = 0; i < 8; i++) {
			points.push({
				ts: 1000 + i * 15,
				lat: 52.0 + i * 15 * vDegPerSec,
				lon: 5.0,
				accuracy: 5,
			});
		}
		const result = filterGpsTrack(points);
		// After settling, speed should be near 5 km/h
		const settled = result.slice(-3);
		for (const p of settled) {
			expect(p.speed_kmh).toBeGreaterThan(3);
			expect(p.speed_kmh).toBeLessThan(8);
		}
	});
});

describe("classifyMode", () => {
	it("classifies stationary", () => expect(classifyMode(0)).toBe("stationary"));
	it("classifies walking", () => expect(classifyMode(5)).toBe("walking"));
	it("classifies cycling", () => expect(classifyMode(20)).toBe("cycling"));
	it("classifies driving", () => expect(classifyMode(80)).toBe("driving"));
	it("classifies transit", () => expect(classifyMode(200)).toBe("transit"));
});
