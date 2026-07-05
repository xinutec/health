/**
 * GPS Kalman filter for position + velocity estimation.
 *
 * State vector: [lat, lon, vlat, vlon] (degrees, degrees, deg/s, deg/s)
 * Measurement: [lat, lon] with accuracy in meters
 *
 * The filter smooths noisy GPS data and produces reliable speed estimates.
 * When moving fast (e.g. train), it trusts velocity predictions over
 * individual GPS fixes, naturally rejecting sideways jumps.
 */

// Earth radius in meters (for converting degrees <-> meters)
const R_EARTH = 6371000;

// Convert meters to degrees latitude
function metersToDegreesLat(m: number): number {
	return m / (R_EARTH * (Math.PI / 180));
}

// Convert meters to degrees longitude at a given latitude
function metersToDegreesLon(m: number, lat: number): number {
	return m / (R_EARTH * Math.cos(lat * (Math.PI / 180)) * (Math.PI / 180));
}

export interface GpsPoint {
	ts: number; // unix timestamp (seconds)
	lat: number;
	lon: number;
	accuracy: number | null; // meters
}

export interface FilteredPoint {
	ts: number;
	lat: number;
	lon: number;
	speed_kmh: number;
	bearing: number; // degrees, 0 = north, 90 = east
}

/**
 * 2D Kalman filter state.
 * We run two independent 1D filters (lat and lon) each with position + velocity.
 * This is simpler than a full 4D filter and works well for GPS.
 */
interface KalmanState1D {
	x: number; // position (degrees)
	v: number; // velocity (degrees/s)
	px: number; // position variance
	pv: number; // velocity variance
	pxv: number; // position-velocity covariance
}

function predict1D(s: KalmanState1D, dt: number, processNoise: number): KalmanState1D {
	// State prediction: x += v * dt
	const x = s.x + s.v * dt;
	const v = s.v;

	// Covariance prediction
	const px = s.px + 2 * dt * s.pxv + dt * dt * s.pv + (processNoise * dt * dt * dt) / 3;
	const pv = s.pv + processNoise * dt;
	const pxv = s.pxv + dt * s.pv + (processNoise * dt * dt) / 2;

	return { x, v, px, pv, pxv };
}

function update1D(s: KalmanState1D, measurement: number, measurementVariance: number): KalmanState1D {
	// Innovation
	const y = measurement - s.x;
	const sy = s.px + measurementVariance;

	// Kalman gains
	const kx = s.px / sy;
	const kv = s.pxv / sy;

	// State update
	const x = s.x + kx * y;
	const v = s.v + kv * y;

	// Covariance update
	const px = s.px - kx * s.px;
	const pv = s.pv - kv * s.pxv;
	const pxv = s.pxv - kx * s.pxv;

	return { x, v, px, pv, pxv };
}

/**
 * Process noise controls how much the filter expects velocity to change.
 * Higher = more responsive to acceleration (walking, driving).
 * Lower = smoother (train at constant speed).
 *
 * We use adaptive process noise: scale it with current estimated speed.
 * At high speed, we expect less lateral acceleration (train), so reduce noise.
 * At low speed, allow more variation (walking, turning corners).
 */
function adaptiveProcessNoise(speedDegPerSec: number, _baseLat: number): number {
	const speedMs = speedDegPerSec * R_EARTH * (Math.PI / 180);
	const speedKmh = speedMs * 3.6;

	if (speedKmh > 80) {
		// High speed (train/plane): very smooth, trust velocity
		return 0.1;
	}
	if (speedKmh > 30) {
		// Driving: moderate smoothing
		return 0.5;
	}
	if (speedKmh > 7) {
		// Cycling: moderate
		return 1.0;
	}
	// Walking/stationary: responsive
	return 2.0;
}

/** Innovation-gating threshold. After the predict step, a measurement's
 *  normalised innovation — (Δlat)²/Slat + (Δlon)²/Slon, chi-square with
 *  2 dof — is compared against this. A genuine fix sits within a few
 *  units of the filter's prediction; a GPS teleport spike (underground
 *  cell-tower fallback) is hundreds-to-thousands. 50 is ~5σ per axis:
 *  far enough out to never reject legitimate motion (the filter's
 *  velocity state tracks even a plane, so plane fixes stay consistent),
 *  tight enough to catch gross teleports. */
const INNOVATION_GATE = 50;

/** After this many consecutive gated measurements the filter stops
 *  coasting and re-acquires from the next fix. Covers the underground-
 *  tube case: a whole run of garbage fixes, then the user surfaces
 *  somewhere new — the surfacing fix is itself far from the (stale)
 *  coasted prediction, so without re-acquisition it would be gated too. */
const MAX_CONSECUTIVE_REJECTS = 3;

export function filterGpsTrack(points: GpsPoint[]): FilteredPoint[] {
	if (points.length === 0) return [];
	if (points.length === 1) {
		return [{ ts: points[0].ts, lat: points[0].lat, lon: points[0].lon, speed_kmh: 0, bearing: 0 }];
	}

	// Default accuracy if not provided
	const defaultAccuracy = 20; // meters

	// Initialize state from first point
	const accM = points[0].accuracy ?? defaultAccuracy;
	const initVarianceLat = metersToDegreesLat(accM) ** 2;
	const initVarianceLon = metersToDegreesLon(accM, points[0].lat) ** 2;

	let stateLat: KalmanState1D = {
		x: points[0].lat,
		v: 0,
		px: initVarianceLat,
		pv: initVarianceLat, // initially uncertain about velocity
		pxv: 0,
	};

	let stateLon: KalmanState1D = {
		x: points[0].lon,
		v: 0,
		px: initVarianceLon,
		pv: initVarianceLon,
		pxv: 0,
	};

	const result: FilteredPoint[] = [
		{ ts: points[0].ts, lat: points[0].lat, lon: points[0].lon, speed_kmh: 0, bearing: 0 },
	];

	// Count of consecutive measurements gated out by innovation testing.
	// Reset to 0 on any accepted measurement or filter reset.
	let consecutiveRejects = 0;

	for (let i = 1; i < points.length; i++) {
		const p = points[i];
		const dt = p.ts - points[i - 1].ts;

		if (dt <= 0) continue; // skip duplicate timestamps

		// Detect resets — three independent conditions:
		//  - very long gap (>1 h): definite re-entry, reset.
		//  - teleport (>5 min + implied >200 km/h): impossible motion, reset.
		//  - tracking gap (>10 min + >500m moved): the user was probably stationary
		//    for some of the gap and then moved — averaging over the whole gap
		//    would invent a fake low speed, so we reset and let the next fix
		//    establish a real velocity. (Without this rule the post-gap fix would
		//    look like "you drove the full distance smoothly across the gap.")
		const impliedDist = Math.sqrt(
			((p.lat - points[i - 1].lat) * 111320) ** 2 +
				((p.lon - points[i - 1].lon) * 111320 * Math.cos((p.lat * Math.PI) / 180)) ** 2,
		);
		const impliedSpeedKmh = (impliedDist / dt) * 3.6;
		// Re-acquire after a run of gated measurements: the filter has
		// been coasting on a stale prediction, the user has likely
		// surfaced somewhere new (underground tube → street).
		const reacquire = consecutiveRejects >= MAX_CONSECUTIVE_REJECTS;
		const shouldReset =
			dt > 3600 || (dt > 300 && impliedSpeedKmh > 200) || (dt >= 600 && impliedDist >= 500) || reacquire;

		if (shouldReset) {
			consecutiveRejects = 0;
			const acc = p.accuracy ?? defaultAccuracy;
			const posVarLat = metersToDegreesLat(acc) ** 2;
			const posVarLon = metersToDegreesLon(acc, p.lat) ** 2;

			// Forward-look: if there's a next fix close in time, infer initial
			// speed/bearing from the (this, next) pair so the post-reset point
			// doesn't appear stationary mid-drive (a known gotcha that previously
			// produced a phantom 0-speed segment when tracking turned on mid-trip).
			let initialSpeed = 0;
			let initialBearing = 0;
			let vLatPerSec = 0;
			let vLonPerSec = 0;
			if (i + 1 < points.length) {
				const next = points[i + 1];
				const dt2 = next.ts - p.ts;
				if (dt2 > 0 && dt2 < 600) {
					const dLatDeg = next.lat - p.lat;
					const dLonDeg = next.lon - p.lon;
					const dLatM = dLatDeg * 111320;
					const dLonM = dLonDeg * 111320 * Math.cos((p.lat * Math.PI) / 180);
					const dist = Math.sqrt(dLatM ** 2 + dLonM ** 2);
					initialSpeed = (dist / dt2) * 3.6;
					initialBearing = ((Math.atan2(dLonM, dLatM) * 180) / Math.PI + 360) % 360;
					// Seed Kalman velocity components (deg/sec) from the same
					// forward-look. Without this seed the Kalman state's v=0
					// prior + accumulated process noise produces a large gain
					// on the next update step, overshooting true motion by
					// ~30% for several fixes after a reset.
					vLatPerSec = dLatDeg / dt2;
					vLonPerSec = dLonDeg / dt2;
				}
			}

			// Generous velocity variance so the filter readily updates the
			// seeded velocity to whatever the next measurement implies. ~100x
			// position variance corresponds to ≈ 100 km/h of velocity uncertainty.
			const velVarLat = posVarLat * 100;
			const velVarLon = posVarLon * 100;
			stateLat = { x: p.lat, v: vLatPerSec, px: posVarLat, pv: velVarLat, pxv: 0 };
			stateLon = { x: p.lon, v: vLonPerSec, px: posVarLon, pv: velVarLon, pxv: 0 };

			result.push({ ts: p.ts, lat: p.lat, lon: p.lon, speed_kmh: initialSpeed, bearing: initialBearing });
			continue;
		}

		// Adaptive process noise based on current speed estimate
		const _currentSpeed = Math.sqrt(stateLat.v ** 2 + stateLon.v ** 2);
		const qLat = adaptiveProcessNoise(Math.abs(stateLat.v), stateLat.x);
		const qLon = adaptiveProcessNoise(Math.abs(stateLon.v), stateLat.x);

		// Scale process noise to degrees
		const qLatDeg = metersToDegreesLat(qLat) ** 2;
		const qLonDeg = metersToDegreesLon(qLon, stateLat.x) ** 2;

		// Predict
		stateLat = predict1D(stateLat, dt, qLatDeg);
		stateLon = predict1D(stateLon, dt, qLonDeg);

		// Measurement noise from GPS accuracy
		const accM = p.accuracy ?? defaultAccuracy;
		const rLat = metersToDegreesLat(accM) ** 2;
		const rLon = metersToDegreesLon(accM, p.lat) ** 2;

		// Innovation gating: reject a measurement that is wildly
		// inconsistent with the filter's prediction. The normalised
		// innovation scales with the prediction uncertainty, so the gate
		// is lenient when the filter is unsure (just after a reset, the
		// inflated velocity variance widens the gate) and strict once
		// the track is well-established. A GPS teleport spike from a
		// settled state scores in the hundreds-to-thousands; a genuine
		// fast mode stays consistent because the velocity state tracks
		// it. Gated measurements coast on the prediction (no update, no
		// emitted point); after MAX_CONSECUTIVE_REJECTS the reset path
		// above re-acquires.
		const innovLat = p.lat - stateLat.x;
		const innovLon = p.lon - stateLon.x;
		const normInnovation = (innovLat * innovLat) / (stateLat.px + rLat) + (innovLon * innovLon) / (stateLon.px + rLon);
		if (normInnovation > INNOVATION_GATE) {
			consecutiveRejects++;
			continue;
		}
		consecutiveRejects = 0;

		// Update
		stateLat = update1D(stateLat, p.lat, rLat);
		stateLon = update1D(stateLon, p.lon, rLon);

		// Calculate speed in km/h from velocity state
		const vLatMs = stateLat.v * R_EARTH * (Math.PI / 180);
		const vLonMs = stateLon.v * R_EARTH * Math.cos(stateLat.x * (Math.PI / 180)) * (Math.PI / 180);
		const speedMs = Math.sqrt(vLatMs ** 2 + vLonMs ** 2);
		const speedKmh = speedMs * 3.6;

		// Bearing from velocity
		const bearing = (Math.atan2(vLonMs, vLatMs) * (180 / Math.PI) + 360) % 360;

		result.push({
			ts: p.ts,
			lat: stateLat.x,
			lon: stateLon.x,
			speed_kmh: Math.round(speedKmh * 10) / 10,
			bearing: Math.round(bearing),
		});
	}

	return result;
}

/**
 * Classify transport mode from speed.
 */
export function classifyMode(speedKmh: number): "stationary" | "walking" | "cycling" | "driving" | "transit" {
	if (speedKmh < 2) return "stationary";
	if (speedKmh < 7) return "walking";
	if (speedKmh < 30) return "cycling";
	if (speedKmh < 120) return "driving";
	return "transit";
}
