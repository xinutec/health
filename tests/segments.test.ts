import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../src/geo/kalman.js";
import {
	classifySegments,
	enforcePhysicalConstraints,
	inferTransitGaps,
	isStationaryIncoherent,
	normalizeScores,
	pedestrianCoreDisplacementM,
	smoothSegments,
	type TrackSegment,
} from "../src/geo/segments.js";

// Helper: generate points moving in a straight line at constant speed
function generateTrack(opts: {
	startTs: number;
	durationSec: number;
	intervalSec: number;
	speedKmh: number;
	bearingDeg?: number;
	startLat?: number;
	startLon?: number;
	speedJitter?: number; // random speed variation in km/h
	bearingJitter?: number; // random bearing variation in degrees
}): FilteredPoint[] {
	const {
		startTs,
		durationSec,
		intervalSec,
		speedKmh,
		bearingDeg = 90,
		startLat = 52.0,
		startLon = 5.0,
		speedJitter = 0,
		bearingJitter = 0,
	} = opts;

	const points: FilteredPoint[] = [];
	const speedMs = speedKmh / 3.6;
	const bearingRad = (bearingDeg * Math.PI) / 180;

	let lat = startLat;
	let lon = startLon;

	for (let t = 0; t <= durationSec; t += intervalSec) {
		const jitteredSpeed = speedKmh + (Math.random() - 0.5) * 2 * speedJitter;
		const jitteredBearing = bearingDeg + (Math.random() - 0.5) * 2 * bearingJitter;

		points.push({
			ts: startTs + t,
			lat,
			lon,
			speed_kmh: Math.max(0, Math.round(jitteredSpeed * 10) / 10),
			bearing: ((jitteredBearing % 360) + 360) % 360,
		});

		// Move forward
		const dlat = (speedMs * intervalSec * Math.cos(bearingRad)) / 6371000 / (Math.PI / 180);
		const dlon =
			(speedMs * intervalSec * Math.sin(bearingRad)) / (6371000 * Math.cos((lat * Math.PI) / 180)) / (Math.PI / 180);
		lat += dlat;
		lon += dlon;
	}

	return points;
}

// Helper: generate a meandering walking track
function generateWalk(startTs: number, durationSec: number): FilteredPoint[] {
	const points: FilteredPoint[] = [];
	let lat = 52.0;
	let lon = 5.0;
	let bearing = 0;

	for (let t = 0; t <= durationSec; t += 15) {
		const speed = 3 + Math.random() * 3; // 3-6 km/h
		bearing += (Math.random() - 0.5) * 60; // wander ±30 degrees

		const speedMs = speed / 3.6;
		const bearingRad = (bearing * Math.PI) / 180;
		lat += (speedMs * 15 * Math.cos(bearingRad)) / 6371000 / (Math.PI / 180);
		lon += (speedMs * 15 * Math.sin(bearingRad)) / (6371000 * Math.cos((lat * Math.PI) / 180)) / (Math.PI / 180);

		points.push({
			ts: startTs + t,
			lat,
			lon,
			speed_kmh: Math.round(speed * 10) / 10,
			bearing: ((bearing % 360) + 360) % 360,
		});
	}

	return points;
}

function findSegment(segments: TrackSegment[], mode: string): TrackSegment | undefined {
	return segments.find((s) => s.mode === mode);
}

describe("classifySegments", () => {
	it("returns empty for empty input", () => {
		expect(classifySegments([])).toEqual([]);
	});

	it("classifies stationary points", () => {
		const points = generateTrack({
			startTs: 1000,
			durationSec: 600,
			intervalSec: 30,
			speedKmh: 0.5,
			speedJitter: 0.3,
		});
		const segments = classifySegments(points);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		expect(segments[0].mode).toBe("stationary");
	});

	it("classifies walking", () => {
		const points = generateWalk(1000, 600);
		const segments = classifySegments(points);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		const walk = findSegment(segments, "walking");
		expect(walk).toBeDefined();
	});

	it("classifies cycling", () => {
		const points = generateTrack({
			startTs: 1000,
			durationSec: 600,
			intervalSec: 15,
			speedKmh: 20,
			speedJitter: 3,
			bearingJitter: 5,
		});
		const segments = classifySegments(points);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		const cycling = findSegment(segments, "cycling");
		expect(cycling).toBeDefined();
	});

	it("classifies train (high speed, very linear, consistent)", () => {
		const points = generateTrack({
			startTs: 1000,
			durationSec: 600,
			intervalSec: 15,
			speedKmh: 140,
			speedJitter: 3,
			bearingJitter: 0.5,
		});
		const segments = classifySegments(points);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		const train = findSegment(segments, "train");
		expect(train).toBeDefined();
		if (train) {
			expect(train.linearity).toBeGreaterThan(0.9);
		}
	});

	it("produces confidence as a 0-1 probability, and confidenceMargin as a ratio", () => {
		// A clean walking track produces a confident walking segment.
		// Confidence (probability of walking among modes) should be > 0.5,
		// margin (walking score / runner-up score) should be > 1.5.
		const points = generateTrack({
			startTs: 1000,
			durationSec: 600,
			intervalSec: 15,
			speedKmh: 4,
			speedJitter: 0.5,
			bearingJitter: 10,
		});
		const segments = classifySegments(points);
		const walking = findSegment(segments, "walking");
		expect(walking).toBeDefined();
		if (walking) {
			expect(walking.confidence).toBeGreaterThan(0.5);
			expect(walking.confidence).toBeLessThanOrEqual(1);
			expect(walking.confidenceMargin).toBeGreaterThan(1.5);
		}
	});

	it("findStays-produced stationary segments carry confidence and margin", () => {
		// A stay produces a stationary segment with high confidence and
		// large margin (stays are unambiguous by construction).
		const points: FilteredPoint[] = [];
		for (let i = 0; i < 60; i++) {
			points.push({
				ts: 1000 + i * 10,
				lat: 51.5 + (Math.random() - 0.5) * 0.0001,
				lon: -0.1 + (Math.random() - 0.5) * 0.0001,
				speed_kmh: 0.3,
				bearing: 0,
			});
		}
		const segments = classifySegments(points);
		const stay = findSegment(segments, "stationary");
		expect(stay).toBeDefined();
		if (stay) {
			expect(stay.confidence).toBeGreaterThan(0.5);
			expect(stay.confidence).toBeLessThanOrEqual(1);
			expect(stay.confidenceMargin).toBeGreaterThanOrEqual(1);
		}
	});

	it("classifies driving (moderate speed, some acceleration)", () => {
		const points = generateTrack({
			startTs: 1000,
			durationSec: 600,
			intervalSec: 10,
			speedKmh: 60,
			speedJitter: 15,
			bearingJitter: 3,
		});
		const segments = classifySegments(points);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		const driving = findSegment(segments, "driving");
		expect(driving).toBeDefined();
	});

	it("classifies plane (very high speed, extremely linear)", () => {
		const points = generateTrack({
			startTs: 1000,
			durationSec: 600,
			intervalSec: 30,
			speedKmh: 500,
			speedJitter: 10,
			bearingJitter: 0.2,
		});
		const segments = classifySegments(points);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		const plane = findSegment(segments, "plane");
		expect(plane).toBeDefined();
	});

	it("detects transition from walking to train", () => {
		// 10 min walking then 10 min train
		const walk = generateWalk(1000, 600);
		const train = generateTrack({
			startTs: 1600,
			durationSec: 600,
			intervalSec: 15,
			speedKmh: 130,
			speedJitter: 3,
			bearingJitter: 0.5,
			startLat: walk[walk.length - 1].lat,
			startLon: walk[walk.length - 1].lon,
		});
		const points = [...walk, ...train];
		const segments = classifySegments(points);

		expect(segments.length).toBeGreaterThanOrEqual(2);
		// Should have both walking and train/driving segments
		const modes = segments.map((s) => s.mode);
		const hasSlowMode = modes.some((m) => m === "walking" || m === "stationary");
		const hasFastMode = modes.some((m) => m === "train" || m === "driving");
		expect(hasSlowMode).toBe(true);
		expect(hasFastMode).toBe(true);
	});

	it("merges short segments into neighbors", () => {
		// Long walk, 30s stationary, long walk — the stationary blip should merge
		const walk1 = generateWalk(1000, 600);
		const lastPoint = walk1[walk1.length - 1];
		const pause: FilteredPoint[] = [
			{ ts: 1600, lat: lastPoint.lat, lon: lastPoint.lon, speed_kmh: 0, bearing: 0 },
			{ ts: 1630, lat: lastPoint.lat, lon: lastPoint.lon, speed_kmh: 0, bearing: 0 },
		];
		const walk2 = generateWalk(1630, 600);
		const points = [...walk1, ...pause, ...walk2];
		const segments = classifySegments(points);

		// The short pause shouldn't create its own segment (< 2 min threshold)
		const stationarySegments = segments.filter((s) => s.mode === "stationary" && s.endTs - s.startTs < 120);
		expect(stationarySegments).toHaveLength(0);
	});

	it("splits two stationary periods at distant locations into separate segments", () => {
		// 30 min stationary at A, then 30 min stationary at B ~280m away.
		// Same mode (stationary) but different places — must produce TWO
		// stays, not one merged stay.
		const A_LAT = 51.84797;
		const A_LON = 5.86412;
		const B_LAT = 51.84546;
		const B_LON = 5.86337;
		const points: FilteredPoint[] = [];
		// Stay at A for 30 min, one fix per minute, jitter within 5m
		for (let t = 0; t < 30 * 60; t += 60) {
			points.push({
				ts: 1000 + t,
				lat: A_LAT + (Math.random() - 0.5) * 0.00005,
				lon: A_LON + (Math.random() - 0.5) * 0.00005,
				speed_kmh: 0.2,
				bearing: 0,
			});
		}
		// Stay at B for 30 min
		for (let t = 0; t < 30 * 60; t += 60) {
			points.push({
				ts: 1000 + 30 * 60 + t,
				lat: B_LAT + (Math.random() - 0.5) * 0.00005,
				lon: B_LON + (Math.random() - 0.5) * 0.00005,
				speed_kmh: 0.2,
				bearing: 0,
			});
		}
		const segments = classifySegments(points);
		const stationary = segments.filter((s) => s.mode === "stationary");
		expect(stationary.length).toBeGreaterThanOrEqual(2);
	});

	it("segments have valid timestamps", () => {
		const points = generateWalk(1000, 1200);
		const segments = classifySegments(points);

		for (const seg of segments) {
			expect(seg.startTs).toBeLessThanOrEqual(seg.endTs);
			expect(seg.pointCount).toBeGreaterThan(0);
			expect(seg.confidence).toBeGreaterThanOrEqual(0);
			expect(seg.avgSpeed).toBeGreaterThanOrEqual(0);
			expect(seg.linearity).toBeGreaterThanOrEqual(0);
			expect(seg.linearity).toBeLessThanOrEqual(1);
		}
	});

	it("classifies fidgeting in one spot as stationary, not walking", () => {
		// Simulates throwing stones at a river: small movements (1-3 km/h GPS noise)
		// but all within a ~20m radius for 35 minutes
		const points: FilteredPoint[] = [];
		const centerLat = 51.8454;
		const centerLon = 5.8633;
		for (let t = 0; t <= 2100; t += 30) {
			// Random jitter within ~15m
			const jitterLat = (Math.random() - 0.5) * 0.0003;
			const jitterLon = (Math.random() - 0.5) * 0.0003;
			points.push({
				ts: 1000 + t,
				lat: centerLat + jitterLat,
				lon: centerLon + jitterLon,
				speed_kmh: Math.random() * 3, // 0-3 km/h GPS noise
				bearing: Math.random() * 360,
			});
		}
		const segments = classifySegments(points);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		// Should be classified as stationary, NOT walking
		const primary = segments.reduce((a, b) => (b.endTs - b.startTs > a.endTs - a.startTs ? b : a));
		expect(primary.mode).toBe("stationary");
	});

	it("emits a stay segment from sparse points after a moving segment", () => {
		// 10 minutes walking, then 30 minutes of sparse points clustered tightly
		// (simulating phone going indoors with poor GPS) — the classifier's window
		// pass would silently drop the indoor period; findStays should fill it.
		const walk = generateWalk(1000, 600);
		const last = walk[walk.length - 1];
		const stay: FilteredPoint[] = [];
		// Sparse: only 6 points across 30 minutes, all within ~30m of last walk point
		for (let t = 0; t < 6; t++) {
			stay.push({
				ts: 1700 + t * 300, // every 5 min
				lat: last.lat + (Math.random() - 0.5) * 0.0004,
				lon: last.lon + (Math.random() - 0.5) * 0.0004,
				speed_kmh: 0,
				bearing: 0,
			});
		}
		const segments = classifySegments([...walk, ...stay]);
		const stationary = segments.find((s) => s.mode === "stationary" && s.startTs >= 1700);
		expect(stationary).toBeDefined();
		if (stationary) {
			expect(stationary.endTs - stationary.startTs).toBeGreaterThanOrEqual(15 * 60);
		}
	});

	it("does not emit a stay when sparse points span > 100m", () => {
		// Same shape as above but the points wander 300m apart — not a stay
		const walk = generateWalk(1000, 600);
		const last = walk[walk.length - 1];
		const wander: FilteredPoint[] = [];
		for (let t = 0; t < 6; t++) {
			wander.push({
				ts: 1700 + t * 300,
				lat: last.lat + t * 0.001, // ~111m per step
				lon: last.lon,
				speed_kmh: 0,
				bearing: 0,
			});
		}
		const segments = classifySegments([...walk, ...wander]);
		const lateStationary = segments.find((s) => s.mode === "stationary" && s.startTs >= 1700);
		expect(lateStationary).toBeUndefined();
	});

	it("does not emit a stay when sparse cluster duration < 15 min", () => {
		const walk = generateWalk(1000, 600);
		const last = walk[walk.length - 1];
		const tooShort: FilteredPoint[] = [];
		for (let t = 0; t < 3; t++) {
			tooShort.push({
				ts: 1700 + t * 200, // 0, 200, 400 seconds = 6.7 min total
				lat: last.lat,
				lon: last.lon,
				speed_kmh: 0,
				bearing: 0,
			});
		}
		const segments = classifySegments([...walk, ...tooShort]);
		const lateStationary = segments.find((s) => s.mode === "stationary" && s.startTs >= 1700);
		expect(lateStationary).toBeUndefined();
	});

	it("emits a stay even when no other segments exist", () => {
		// Phone sat in one place all day, sparse GPS, classifier sees no movement
		const stay: FilteredPoint[] = [];
		for (let t = 0; t < 8; t++) {
			stay.push({
				ts: 1000 + t * 600, // every 10 min for 70 min
				lat: 52.0 + (Math.random() - 0.5) * 0.0003,
				lon: 5.0 + (Math.random() - 0.5) * 0.0003,
				speed_kmh: 0,
				bearing: 0,
			});
		}
		const segments = classifySegments(stay);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		expect(segments[0].mode).toBe("stationary");
	});

	it("does NOT infer a transit segment for a brief GPS gap (< 3 min)", () => {
		// 5 min at A, 1-min gap, 5 min at A. Same place, short gap.
		const points: FilteredPoint[] = [];
		const A = { lat: 50.83, lon: 4.33 };
		for (let t = 0; t <= 300; t += 30) {
			points.push({ ts: 1000 + t, lat: A.lat, lon: A.lon, speed_kmh: 0.3, bearing: 0 });
		}
		for (let t = 0; t <= 300; t += 30) {
			points.push({ ts: 1000 + 360 + t, lat: A.lat, lon: A.lon, speed_kmh: 0.3, bearing: 0 });
		}
		const segments = classifySegments(points);
		expect(segments.every((s) => !s.refinedReason?.includes("GPS gap"))).toBe(true);
	});

	it("does NOT infer a transit segment when the user stayed put despite a long gap", () => {
		// 10 min at A, 30 min gap, 10 min at A again (same location, just no
		// fixes for half an hour — phone in pocket / dead). No transit to
		// infer. (StayDetection might collapse this into one stay; if it
		// does, that's a separate fine outcome — just no SYNTHETIC transit.)
		const points: FilteredPoint[] = [];
		const A = { lat: 50.83, lon: 4.33 };
		for (let t = 0; t <= 600; t += 30) {
			points.push({ ts: 1000 + t, lat: A.lat, lon: A.lon, speed_kmh: 0.3, bearing: 0 });
		}
		const resumeStart = 1000 + 600 + 30 * 60;
		for (let t = 0; t <= 600; t += 30) {
			points.push({ ts: resumeStart + t, lat: A.lat, lon: A.lon, speed_kmh: 0.3, bearing: 0 });
		}
		const segments = classifySegments(points);
		expect(segments.every((s) => !s.refinedReason?.includes("GPS gap"))).toBe(true);
	});

	it("infers train mode when implied speed is high (>120 km/h)", () => {
		// 5 min at A, 1-hour gap, 5 min at B which is 200km away.
		// 200 km / 60 min = 200 km/h → train.
		const points: FilteredPoint[] = [];
		// Use lat differences rough but big enough; ~1.8° lat = 200km
		const A = { lat: 50.0, lon: 4.0 };
		const B = { lat: 51.8, lon: 4.0 };
		for (let t = 0; t <= 300; t += 30) {
			points.push({ ts: 1000 + t, lat: A.lat, lon: A.lon, speed_kmh: 0.3, bearing: 0 });
		}
		const bStart = 1000 + 300 + 60 * 60;
		for (let t = 0; t <= 300; t += 30) {
			points.push({ ts: bStart + t, lat: B.lat, lon: B.lon, speed_kmh: 0.3, bearing: 0 });
		}
		const segments = classifySegments(points);
		const inferred = segments.find((s) => s.refinedReason?.includes("GPS gap"));
		expect(inferred).toBeDefined();
		expect(inferred?.mode).toBe("train");
	});

	it("inferTransitGaps: vehicle-speed gap adjacent to a train segment upgrades to train (Tube interchange)", () => {
		// Pattern: a stationary segment near a station, then a 5-min gap of
		// 3.2 km, then a train segment. The gap is part of the same transit
		// chain, not a sudden 38 km/h car ride.
		const A = { lat: 50.0, lon: 5.0 };
		const B = { lat: 50.007, lon: 4.957 };
		const segs: TrackSegment[] = [
			{
				startTs: 1000,
				endTs: 1120,
				mode: "stationary",
				confidence: 1,
				confidenceMargin: 100,
				avgSpeed: 0,
				maxSpeed: 0,
				linearity: 0,
				pointCount: 5,
			},
			{
				startTs: 1420,
				endTs: 1720,
				mode: "train",
				confidence: 0.6,
				confidenceMargin: 3,
				avgSpeed: 85,
				maxSpeed: 100,
				linearity: 0.99,
				pointCount: 30,
			},
		];
		const points: FilteredPoint[] = [
			{ ts: 1120, lat: A.lat, lon: A.lon, speed_kmh: 0, bearing: 0 },
			{ ts: 1420, lat: B.lat, lon: B.lon, speed_kmh: 85, bearing: 90 },
		];
		const result = inferTransitGaps(segs, points);
		const inferred = result.find((s) => s.refinedReason?.includes("GPS gap"));
		expect(inferred).toBeDefined();
		expect(inferred?.mode).toBe("train"); // not "driving"
	});

	it("inferTransitGaps directly: pure logic (no classifier interference)", () => {
		const A = { lat: 50.83, lon: 4.33 };
		const B = { lat: 50.86, lon: 4.4 };
		const segs: TrackSegment[] = [
			{
				startTs: 1000,
				endTs: 1600,
				mode: "stationary",
				confidence: 1,
				confidenceMargin: 100,
				avgSpeed: 0,
				maxSpeed: 0,
				linearity: 0,
				pointCount: 5,
			},
			{
				startTs: 3400,
				endTs: 4000,
				mode: "stationary",
				confidence: 1,
				confidenceMargin: 100,
				avgSpeed: 0,
				maxSpeed: 0,
				linearity: 0,
				pointCount: 5,
			},
		];
		const points: FilteredPoint[] = [
			{ ts: 1600, lat: A.lat, lon: A.lon, speed_kmh: 0, bearing: 0 },
			{ ts: 3400, lat: B.lat, lon: B.lon, speed_kmh: 0, bearing: 0 },
		];
		const result = inferTransitGaps(segs, points);
		expect(result).toHaveLength(3);
		expect(result[1].refinedReason).toMatch(/GPS gap/);
		expect(result[1].startTs).toBe(1600);
		expect(result[1].endTs).toBe(3400);
	});

	it("segments cover the full track", () => {
		const points = generateTrack({
			startTs: 1000,
			durationSec: 1200,
			intervalSec: 15,
			speedKmh: 50,
		});
		const segments = classifySegments(points);

		if (segments.length > 0) {
			expect(segments[0].startTs).toBe(points[0].ts);
			// Last segment should end within one window of the track end
			const lastSegEnd = segments[segments.length - 1].endTs;
			const trackEnd = points[points.length - 1].ts;
			expect(lastSegEnd).toBeGreaterThanOrEqual(trackEnd - 300);
			expect(lastSegEnd).toBeLessThanOrEqual(trackEnd);
		}
	});

	it("does NOT fall for a single GPS noise spike inside an otherwise stationary period", () => {
		// 15 minutes of stationary fixes with one outlier point reading at
		// 25 km/h but at the same lat/lon as everything else (i.e. the
		// classifier's speed reading is noise). netDisplacement stays tiny so
		// the hidden-movement penalty must NOT trigger.
		const points: FilteredPoint[] = [];
		const baseLat = 52.0;
		const baseLon = 5.0;
		for (let t = 0; t <= 900; t += 15) {
			const isSpike = t === 450; // mid-window
			points.push({
				ts: 1000 + t,
				lat: baseLat,
				lon: baseLon,
				speed_kmh: isSpike ? 25 : 0.3,
				bearing: 90,
			});
		}
		const segments = classifySegments(points);
		expect(segments).toHaveLength(1);
		expect(segments[0].mode).toBe("stationary");
	});

	it("infers a transit segment in a long GPS gap between two distant stationary segments (Eurostar / underground)", () => {
		// 10 min stationary at A, then 30 min of NO GPS fixes, then 10 min
		// stationary at B (~5 km away). Without inference the timeline reads
		// "stationary at A → stationary at B" with nothing in between, which
		// looks like teleportation. The inference should fill the gap with
		// a synthetic "driving" segment (high enough speed → "driving"; very
		// fast would have been "train").
		const points: FilteredPoint[] = [];
		const A = { lat: 50.83, lon: 4.33 };
		const B = { lat: 50.86, lon: 4.4 }; // ~5 km away

		// 10 min at A, fix every 30s
		for (let t = 0; t <= 600; t += 30) {
			points.push({ ts: 1000 + t, lat: A.lat, lon: A.lon, speed_kmh: 0.3, bearing: 0 });
		}
		// 30 min gap — no fixes (Eurostar-shaped)
		// 10 min at B
		const bStart = 1000 + 600 + 30 * 60;
		for (let t = 0; t <= 600; t += 30) {
			points.push({ ts: bStart + t, lat: B.lat, lon: B.lon, speed_kmh: 0.3, bearing: 0 });
		}

		const segments = classifySegments(points);
		// Should have at least 3 segments: stationary at A, inferred transit, stationary at B
		expect(segments.length).toBeGreaterThanOrEqual(3);
		const inferred = segments.find((s) => s.refinedReason?.includes("GPS gap"));
		expect(inferred).toBeDefined();
		expect(inferred?.mode).toBe("driving"); // 5km/30min ≈ 10 km/h is below train threshold
	});

	it("splits a stationary block when GPS catches a real movement window inside (e.g. underground train surfacing briefly)", () => {
		// Simulate: 10 min waiting at platform A, then 5 min of fast movement
		// covering 3 km (a train hop), then 10 min waiting at platform B.
		// Without the hidden-movement penalty the whole 25 min collapses into
		// one stationary segment because median speed is dominated by the
		// 20 platform-min on each side. With the penalty, the train window
		// scores low on stationary and emerges as its own non-stationary
		// segment between the two stays.
		const points: FilteredPoint[] = [];
		const startA = { lat: 52.0, lon: 5.0 };
		const startB = { lat: 52.0, lon: 5.04 }; // ~2.7 km east

		// 10 min at platform A, fix every 30s
		for (let t = 0; t <= 600; t += 30) {
			points.push({ ts: 1000 + t, lat: startA.lat, lon: startA.lon, speed_kmh: 0.4, bearing: 0 });
		}
		// Train ride: 5 min covering ~2.7 km; fix every 30s
		const trainStart = 1000 + 630;
		for (let i = 0; i <= 10; i++) {
			const frac = i / 10;
			points.push({
				ts: trainStart + i * 30,
				lat: startA.lat + (startB.lat - startA.lat) * frac,
				lon: startA.lon + (startB.lon - startA.lon) * frac,
				speed_kmh: 32, // ~110 km/h would be too fast; use 32 for short hop
				bearing: 90,
			});
		}
		// 10 min at platform B
		const platBStart = trainStart + 5 * 60 + 30;
		for (let t = 0; t <= 600; t += 30) {
			points.push({ ts: platBStart + t, lat: startB.lat, lon: startB.lon, speed_kmh: 0.4, bearing: 0 });
		}

		const segments = classifySegments(points);
		// Should produce at least 3 segments: stationary → moving → stationary.
		expect(segments.length).toBeGreaterThanOrEqual(3);
		expect(segments.some((s) => s.mode !== "stationary")).toBe(true);
	});
});

describe("isStationaryIncoherent", () => {
	// A stay mills around a point (low linearity, ~0 net displacement). The
	// 2026-06-12 "Bleecker" / "The Other Palace" phantoms were the opposite:
	// a slow walk to Victoria, fixes marching in a line, mislabelled as a
	// stay and named after a POI it drifted past.

	it("flags a directed, displaced 'stationary' segment as incoherent (the Bleecker phantom)", () => {
		// lin 0.91, ~106 m net progress over ~5 min — a walk, not a stay.
		expect(
			isStationaryIncoherent({ linearity: 0.91, netDisplacementM: 106, coreDisplacementM: 106, durationS: 300 }),
		).toBe(true);
	});

	it("does NOT flag a genuine stay that mills around a point (clinic: low linearity)", () => {
		expect(
			isStationaryIncoherent({ linearity: 0.28, netDisplacementM: 40, coreDisplacementM: 40, durationS: 3600 }),
		).toBe(false);
	});

	it("does NOT flag a still stay whose few fixes happen to be colinear but barely move", () => {
		// High linearity but tiny displacement — the floor protects it.
		expect(
			isStationaryIncoherent({ linearity: 0.95, netDisplacementM: 20, coreDisplacementM: 20, durationS: 600 }),
		).toBe(false);
	});

	it("does NOT flag a home stay (moderate linearity, small displacement)", () => {
		expect(
			isStationaryIncoherent({ linearity: 0.56, netDisplacementM: 60, coreDisplacementM: 60, durationS: 7200 }),
		).toBe(false);
	});

	it("requires BOTH directed motion and real displacement", () => {
		// displaced too little
		expect(
			isStationaryIncoherent({ linearity: 0.95, netDisplacementM: 80, coreDisplacementM: 80, durationS: 600 }),
		).toBe(false);
		// not directed
		expect(
			isStationaryIncoherent({ linearity: 0.6, netDisplacementM: 300, coreDisplacementM: 300, durationS: 600 }),
		).toBe(false);
		// both
		expect(
			isStationaryIncoherent({ linearity: 0.85, netDisplacementM: 250, coreDisplacementM: 250, durationS: 600 }),
		).toBe(true);
	});

	it("does NOT flag a dwell-scale window whose pedestrian core implies no locomotion pace (#354)", () => {
		// A 2.5 h office afternoon whose tail is the walk-out-and-board: raw
		// first→last spans the ride's teleports (km), but the pedestrian core
		// displaced 408 m = 0.16 km/h. Nothing locomotes that slowly — the
		// departure is a boundary problem, not evidence the whole window
		// moved. Flipping it wholesale manufactured a phantom multi-hour walk.
		expect(
			isStationaryIncoherent({ linearity: 0.9, netDisplacementM: 3000, coreDisplacementM: 408, durationS: 9060 }),
		).toBe(false);
	});

	it("STILL flags a short mid-ride fragment spanning a teleport (rail absorbers rely on the flip)", () => {
		// A 4-min "stay" whose raw net is 1.5 km with a ~0 m pedestrian core:
		// sparse tunnel fixes clustered as a stop. Short windows keep the old
		// behaviour — suppressing these broke reconstructed journeys and moved
		// a Met alight to the wrong station (measured 2026-07-14).
		expect(
			isStationaryIncoherent({ linearity: 1.0, netDisplacementM: 1466, coreDisplacementM: 1, durationS: 240 }),
		).toBe(true);
	});

	it("still flags a slow-but-real march over a dwell-scale window (core pace above the floor)", () => {
		// 700 m core over 45 min = 0.93 km/h — a genuine crawl (crowd, luggage).
		expect(
			isStationaryIncoherent({ linearity: 0.88, netDisplacementM: 700, coreDisplacementM: 700, durationS: 2700 }),
		).toBe(true);
	});
});

describe("pedestrianCoreDisplacementM", () => {
	// The coherence pass catches SLOW locomotion misread as dwelling — so a
	// vehicle-paced step (a tunnel-reacquire teleport, a ride head stranded in
	// the stay's tail) can never be evidence for it. Displacement is judged
	// over the pedestrian-paced core: edge runs of ≥15 km/h steps are trimmed.
	const fix = (ts: number, lat: number, lon: number) => ({ ts, lat, lon, speed_kmh: 1, bearing: 0 });

	it("trims a trailing vehicle-paced run (dwell cloud + ride-head teleports = a stay)", () => {
		// 30 min milling inside a ~60 m cloud, then two ~29+ km/h teleport
		// steps as a ride departs. First→last reads kilometres; the core
		// reads the cloud.
		const cloud = Array.from({ length: 30 }, (_, i) =>
			fix(i * 60, 51.53 + (((i * 37) % 11) - 5) * 0.000005, -0.126 + (((i * 41) % 11) - 5) * 0.000005),
		);
		const teleports = [fix(30 * 60, 51.525, -0.15), fix(30 * 60 + 240, 51.536, -0.175)];
		const d = pedestrianCoreDisplacementM([...cloud, ...teleports]);
		expect(d).toBeLessThan(90);
	});

	it("trims a leading vehicle-paced run (ride tail stranded at a stay's head)", () => {
		const teleports = [fix(0, 51.536, -0.175), fix(240, 51.525, -0.15)];
		const cloud = Array.from({ length: 30 }, (_, i) => fix(600 + i * 60, 51.53, -0.126));
		const d = pedestrianCoreDisplacementM([...teleports, ...cloud]);
		expect(d).toBeLessThan(90);
	});

	it("handles a departing ride that dwells at a platform mid-tunnel (fast, slow, fast tail)", () => {
		// The measured 07-07 shape: the tail teleports are NOT one contiguous
		// fast run — the train stops at a station between them, producing a
		// slow step at a point kilometres from the stay. Any fix beyond a
		// teleport is off the stay's worldline; the core is the dwell mass.
		const cloud = Array.from({ length: 30 }, (_, i) => fix(i * 60, 51.53, -0.126));
		const tail = [
			fix(30 * 60, 51.525, -0.15), // teleport (~29 km/h)
			fix(30 * 60 + 150, 51.5239, -0.1573), // slow platform step (~3.8 km/h)
			fix(30 * 60 + 300, 51.536, -0.175), // teleport again
		];
		const d = pedestrianCoreDisplacementM([...cloud, ...tail]);
		expect(d).toBeLessThan(90);
	});

	it("keeps a genuine pedestrian march intact (the walk-to-the-station shape)", () => {
		// ~470 m of steady ~2.8 km/h progress — every step pedestrian-paced.
		const march = Array.from({ length: 20 }, (_, i) => fix(i * 30, 51.53 + i * 0.0002, -0.126));
		const d = pedestrianCoreDisplacementM(march);
		expect(d).toBeGreaterThan(250);
	});

	it("an interior spike does not extend the core's endpoints", () => {
		// Cloud, one out-and-back multipath spike mid-window, cloud: the
		// first→last displacement is already the cloud's — unchanged.
		const a = Array.from({ length: 10 }, (_, i) => fix(i * 60, 51.53, -0.126));
		const spike = [fix(11 * 60, 51.535, -0.13)];
		const b = Array.from({ length: 10 }, (_, i) => fix((13 + i) * 60, 51.53, -0.126));
		const d = pedestrianCoreDisplacementM([...a, ...spike, ...b]);
		expect(d).toBeLessThan(20);
	});

	it("returns 0 on fewer than two fixes", () => {
		expect(pedestrianCoreDisplacementM([])).toBe(0);
		expect(pedestrianCoreDisplacementM([fix(0, 51.53, -0.126)])).toBe(0);
	});
});

describe("enforcePhysicalConstraints", () => {
	// Some classifier outputs are physically impossible. A car can't sustain
	// 300+ km/h, a train can't sustain 500+ km/h. These are hard constraints,
	// not heuristic guards — they hold regardless of biometrics or OSM
	// context. Enforce them as a post-classification override.

	const baseSeg = (overrides: Partial<TrackSegment> = {}): TrackSegment => ({
		startTs: 1000,
		endTs: 1500,
		mode: "driving",
		confidence: 0.9,
		confidenceMargin: 5,
		avgSpeed: 60,
		maxSpeed: 70,
		linearity: 0.8,
		pointCount: 10,
		...overrides,
	});

	it("overrides driving with maxSpeed > 250 km/h to train (Eurostar case)", () => {
		const s = enforcePhysicalConstraints(baseSeg({ mode: "driving", avgSpeed: 130, maxSpeed: 317 }));
		expect(s.mode).toBe("train");
	});

	it("leaves regular driving alone (highway speeds)", () => {
		const s = enforcePhysicalConstraints(baseSeg({ mode: "driving", avgSpeed: 120, maxSpeed: 150 }));
		expect(s.mode).toBe("driving");
	});

	it("leaves autobahn-speed driving alone (up to 250 km/h max is plausible)", () => {
		// Autobahn / Italian autostrada can legitimately hit 200-240 km/h.
		// Threshold is 250, not 200, to avoid false-positives at the high
		// end of legal driving.
		const s = enforcePhysicalConstraints(baseSeg({ mode: "driving", avgSpeed: 140, maxSpeed: 240 }));
		expect(s.mode).toBe("driving");
	});

	it("overrides train with avgSpeed > 400 km/h to plane", () => {
		// avgSpeed: fastest scheduled trains top out around 350 km/h, so a
		// sustained > 400 average must be a plane. Single fixes can spike
		// during turbulent GPS samples, so use AVG, not max.
		const s = enforcePhysicalConstraints(baseSeg({ mode: "train", avgSpeed: 600, maxSpeed: 850 }));
		expect(s.mode).toBe("plane");
	});

	it("leaves train at high (but valid) train speeds alone", () => {
		// 280 km/h average is plausible TGV / Shinkansen. Don't override.
		const s = enforcePhysicalConstraints(baseSeg({ mode: "train", avgSpeed: 280, maxSpeed: 357 }));
		expect(s.mode).toBe("train");
	});

	it("records the override in refinedReason", () => {
		const s = enforcePhysicalConstraints(baseSeg({ mode: "driving", avgSpeed: 130, maxSpeed: 317 }));
		expect(s.refinedReason).toMatch(/physical/i);
	});

	it("leaves stationary, walking, cycling alone (low-speed modes can't trip the limit)", () => {
		const stay = enforcePhysicalConstraints(baseSeg({ mode: "stationary", avgSpeed: 0, maxSpeed: 1 }));
		expect(stay.mode).toBe("stationary");
		const walk = enforcePhysicalConstraints(baseSeg({ mode: "walking", avgSpeed: 5, maxSpeed: 8 }));
		expect(walk.mode).toBe("walking");
		const cycle = enforcePhysicalConstraints(baseSeg({ mode: "cycling", avgSpeed: 20, maxSpeed: 35 }));
		expect(cycle.mode).toBe("cycling");
	});
});

describe("normalizeScores", () => {
	// Pure function: given the sorted-descending raw mode scores from
	// scoreWindow, return the top mode's probability (share of total) and
	// the margin (best / runner-up). Used to turn raw heuristic scores
	// into a usable confidence signal.

	it("returns probability ≈ 1.0 when one mode dominates absolutely", () => {
		const r = normalizeScores([
			{ mode: "stationary", score: 18 },
			{ mode: "walking", score: 0.01 },
			{ mode: "driving", score: 0.01 },
		]);
		expect(r.mode).toBe("stationary");
		expect(r.probability).toBeGreaterThan(0.99);
		expect(r.margin).toBeGreaterThan(100);
	});

	it("returns probability ≈ 0.5 when two modes tie", () => {
		const r = normalizeScores([
			{ mode: "walking", score: 2.0 },
			{ mode: "driving", score: 2.0 },
		]);
		// share-of-total = 2 / (2+2) = 0.5
		expect(r.probability).toBeCloseTo(0.5, 2);
		// margin = 2 / 2 = 1.0
		expect(r.margin).toBeCloseTo(1.0, 2);
	});

	it("returns probability near 0.33 when three modes tie", () => {
		const r = normalizeScores([
			{ mode: "walking", score: 1 },
			{ mode: "cycling", score: 1 },
			{ mode: "driving", score: 1 },
		]);
		expect(r.probability).toBeCloseTo(1 / 3, 2);
		expect(r.margin).toBeCloseTo(1.0, 2);
	});

	it("captures realistic walking-vs-driving ambiguity", () => {
		// walking=2.1, driving=2.0: barely walking. Probability ~0.51,
		// margin ~1.05 → flag as ambiguous.
		const r = normalizeScores([
			{ mode: "walking", score: 2.1 },
			{ mode: "driving", score: 2.0 },
			{ mode: "stationary", score: 0.01 },
		]);
		expect(r.mode).toBe("walking");
		expect(r.probability).toBeLessThan(0.6);
		expect(r.margin).toBeLessThan(1.1);
	});

	it("captures realistic walking-clearly-wins case", () => {
		// walking=2, driving=0.5: confident walking. Probability ~0.79,
		// margin = 4.
		const r = normalizeScores([
			{ mode: "walking", score: 2 },
			{ mode: "driving", score: 0.5 },
			{ mode: "stationary", score: 0.01 },
			{ mode: "cycling", score: 0.01 },
			{ mode: "train", score: 0.01 },
			{ mode: "plane", score: 0.01 },
		]);
		expect(r.mode).toBe("walking");
		expect(r.probability).toBeGreaterThan(0.7);
		expect(r.probability).toBeLessThan(0.9);
		expect(r.margin).toBeCloseTo(4.0, 1);
	});

	it("handles a single-element array (no runner-up)", () => {
		// No other modes scored — margin is treated as 'unambiguous'
		// (use a large finite value rather than Infinity so it serialises).
		const r = normalizeScores([{ mode: "walking", score: 1 }]);
		expect(r.mode).toBe("walking");
		expect(r.probability).toBe(1);
		expect(r.margin).toBeGreaterThan(10);
		expect(Number.isFinite(r.margin)).toBe(true);
	});

	it("handles all-zero scores (degenerate, GPS-free window)", () => {
		// All scores are 0 → share-of-total is undefined. Return mode of
		// the first entry with probability=0 and margin=1 (no info).
		const r = normalizeScores([
			{ mode: "stationary", score: 0 },
			{ mode: "walking", score: 0 },
		]);
		expect(r.mode).toBe("stationary");
		expect(r.probability).toBe(0);
		expect(r.margin).toBe(1);
	});

	it("handles an empty array (degenerate, should not happen in practice)", () => {
		const r = normalizeScores([]);
		// Sentinel: still safe to consume.
		expect(r.probability).toBe(0);
		expect(r.margin).toBe(1);
	});
});

describe("smoothSegments — no input mutation", () => {
	const seg = (startTs: number, endTs: number, mode: TrackSegment["mode"]): TrackSegment => ({
		startTs,
		endTs,
		mode,
		confidence: 0.9,
		confidenceMargin: 100,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 3,
	});

	it("merges short segments into the previous one without mutating the input array", () => {
		// A long walk, a sub-threshold (60s) sliver that must merge back, then
		// another long walk. The sliver merge mutates the kept segment's endTs/
		// pointCount in place — it must touch the OUTPUT copy, never the input.
		const input = [seg(0, 600, "walking"), seg(600, 660, "stationary"), seg(660, 1260, "walking")];
		const snapshot = structuredClone(input);
		const out = smoothSegments(input, 5 * 60);
		expect(input).toEqual(snapshot); // input untouched
		// And the merge actually happened (sliver folded into the first walk).
		expect(out).toHaveLength(2);
		expect(out[0].endTs).toBe(660);
		expect(out[0].pointCount).toBe(6);
	});
});
