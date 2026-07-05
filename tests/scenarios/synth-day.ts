/**
 * Synthetic day generator for end-to-end scenario tests.
 *
 * Takes a high-level spec — a series of "legs" describing where the user is
 * and how they're moving — and returns realistic-looking GPS + biometric
 * streams that can drive the segment-classification pipeline.
 *
 * Goals:
 *   - Encode production bug classes as repeatable, no-DB, no-network tests.
 *   - Be readable: a test reading the spec should be able to picture the day.
 *   - Be realistic enough that Kalman + segments + biometrics behave like
 *     they would on real input. Not pixel-perfect; just plausible-shaped.
 *
 * Non-goals:
 *   - Modelling GPS multipath, indoor drift, or watch firmware quirks.
 *   - Producing data that exactly matches any real-world day.
 */

import type { HrPoint, SleepStageRecord, StepPoint } from "../../src/geo/biometrics.js";
import type { GpsPoint } from "../../src/geo/kalman.js";

/** Either a stationary period at a fixed location, or a straight-line
 *  movement between two points at a fixed speed. */
export type Leg =
	| {
			kind: "stay";
			durationSec: number;
			lat: number;
			lon: number;
			/** Mean HR during this leg; nullable to simulate watch off. */
			hr: number | null;
			/** Steps per minute. 0 for true rest; tiny non-zero for fidgeting. */
			cadence?: number;
			/** GPS accuracy in metres reported by the watch. Default 15. */
			accuracy?: number;
	  }
	| {
			kind: "move";
			durationSec: number;
			from: [number, number];
			to: [number, number];
			/** Average speed in km/h. The leg interpolates linearly between
			 *  `from` and `to` over `durationSec`; speedKmh is informational
			 *  and not re-derived. Pick `to` so distance/time matches. */
			speedKmh: number;
			hr: number | null;
			cadence: number;
			accuracy?: number;
	  };

export interface SynthDay {
	points: GpsPoint[];
	hr: HrPoint[];
	steps: StepPoint[];
	sleep: SleepStageRecord[];
	/** Convenience: start/end of the synth window for assertions. */
	startTs: number;
	endTs: number;
}

const GPS_INTERVAL_SEC = 10;
const HR_INTERVAL_SEC = 60;
const STEPS_INTERVAL_SEC = 60;
const EARTH_KM_PER_DEG_LAT = 111;

function jitter(seedTs: number, axis: number): number {
	// Deterministic small jitter so synth output is stable across runs.
	// Range ~ ±5m in degrees at typical European latitudes.
	const h = ((seedTs * 9301 + axis * 49297) % 233280) / 233280;
	return (h - 0.5) * 0.00009; // ~5m
}

function lonDegPerKm(lat: number): number {
	return 1 / (EARTH_KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
}

/** Build a synthetic day from a starting Unix timestamp + leg list.
 *  Each leg contributes GPS fixes (every 10 s), HR samples (every 60 s),
 *  and steps rows (every 60 s, only when cadence > 0). */
export function synthDay(startTs: number, legs: Leg[]): SynthDay {
	const points: GpsPoint[] = [];
	const hr: HrPoint[] = [];
	const steps: StepPoint[] = [];

	let cursor = startTs;
	for (const leg of legs) {
		const legStart = cursor;
		const legEnd = cursor + leg.durationSec;
		const accuracy = leg.accuracy ?? 15;

		// GPS fixes
		for (let t = legStart; t < legEnd; t += GPS_INTERVAL_SEC) {
			const progress = (t - legStart) / leg.durationSec;
			let lat: number;
			let lon: number;
			if (leg.kind === "stay") {
				lat = leg.lat + jitter(t, 1);
				lon = leg.lon + jitter(t, 2);
			} else {
				lat = leg.from[0] + (leg.to[0] - leg.from[0]) * progress + jitter(t, 1);
				lon = leg.from[1] + (leg.to[1] - leg.from[1]) * progress + jitter(t, 2);
			}
			points.push({ ts: t, lat, lon, accuracy });
		}

		// HR samples
		if (leg.hr !== null) {
			for (let t = legStart; t < legEnd; t += HR_INTERVAL_SEC) {
				const noise = (jitter(t, 3) * 1e5) % 4; // ±2 bpm
				hr.push({ ts: t, bpm: Math.round(leg.hr + noise) });
			}
		}

		// Steps rows
		const cadence = leg.kind === "move" ? leg.cadence : (leg.cadence ?? 0);
		if (cadence > 0) {
			for (let t = legStart; t < legEnd; t += STEPS_INTERVAL_SEC) {
				steps.push({ ts: t, steps: cadence });
			}
		}

		cursor = legEnd;
	}

	return { points, hr, steps, sleep: [], startTs, endTs: cursor };
}

/** Resolve an ISO instant to unix seconds. Helper to keep the spec readable. */
export function tsAt(iso: string): number {
	return Math.floor(Date.parse(iso) / 1000);
}

/** Convenience builder: a `move` leg whose `to` is computed from `from` +
 *  speed + duration + heading (degrees, 0 = north, 90 = east). Lets specs
 *  read like "walk east at 5 km/h for 20 minutes". */
export function moveBearing(args: {
	durationSec: number;
	from: [number, number];
	speedKmh: number;
	headingDeg: number;
	hr: number | null;
	cadence: number;
	accuracy?: number;
}): Extract<Leg, { kind: "move" }> {
	const { durationSec, from, speedKmh, headingDeg } = args;
	const km = (speedKmh * durationSec) / 3600;
	const headingRad = (headingDeg * Math.PI) / 180;
	const dLat = (km * Math.cos(headingRad)) / EARTH_KM_PER_DEG_LAT;
	const dLon = km * Math.sin(headingRad) * lonDegPerKm(from[0]);
	return {
		kind: "move",
		durationSec,
		from,
		to: [from[0] + dLat, from[1] + dLon],
		speedKmh,
		hr: args.hr,
		cadence: args.cadence,
		accuracy: args.accuracy,
	};
}
