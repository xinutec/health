/**
 * Per-minute observation tensor — the input shape the joint sequence
 * model (HMM, Phase 1) consumes.
 *
 * Stitches three input streams into one 1440-row array spanning a
 * single local day:
 *
 *   - **GPS**: Kalman-filtered fixes (cadence varies — every 10 s in
 *     dense periods, sparse over signal gaps). Aggregated by minute:
 *     median lat/lon, mean speed_kmh.
 *   - **HR**: 1-minute means from `heart_rate_intraday`.
 *   - **Cadence**: per-minute step counts from `steps_intraday`. We
 *     distinguish a missing row (no observation; `null`) from an
 *     explicit zero (resting; `0`) because the HMM's zero-inflated
 *     cadence emission cares about the difference.
 *   - **Context**: hour and day-of-week in the user's `displayTz`,
 *     used by the HMM's transition prior conditioning.
 *
 * Missing observations are first-class: `null` rather than 0 or NaN.
 * The HMM's per-state Bernoulli emission `p(gps_present | state)`
 * uses GPS-presence as a signal, so accurately representing
 * "no fix this minute" is load-bearing.
 *
 * Pure function: takes already-loaded streams + a date + tz, returns
 * the tensor. The I/O loader that fetches the streams lives at the
 * caller (today: `loadBiometrics` + PhoneTrack + Kalman in
 * `velocity.ts`; Phase 1 will likely wrap them into a `loadDay`
 * helper).
 */

import type { HrPoint, StepPoint } from "../geo/biometrics.js";
import type { FilteredPoint } from "../geo/kalman.js";
import { dateBoundsUtc } from "../geo/timezone.js";

export interface Observation {
	/** Unix seconds — top of the minute. */
	ts: number;
	/** GPS aggregate for this minute, or `null` when no fix landed
	 *  inside the minute. */
	gps: { lat: number; lon: number; speedKmh: number } | null;
	/** Mean HR (bpm) over samples in the minute. Null when no HR
	 *  samples landed in the minute. */
	hr: number | null;
	/** Step count for the minute. Null distinguishes "no row written"
	 *  from "0 steps recorded" (steps_intraday only writes non-zero
	 *  minutes by default, but a sync may explicitly insert a 0). */
	cadence: number | null;
	/** Hour 0-23 in the user's displayTz. */
	hourLocal: number;
	/** Day-of-week in the user's displayTz; Sunday = 0. */
	dayOfWeekLocal: number;
	/** Whether Fitbit detected a sleep stage (any of asleep / deep /
	 *  light / rem / wake) at this minute. `false` means "no Fitbit
	 *  sleep observation" — NOT "user is awake." Sleep observations
	 *  are evidence for `stationary`, weak evidence against most
	 *  movement modes, and weak-to-moderate evidence against train/
	 *  plane (where sleep is plausible). Used as a soft factor in
	 *  emission — never a hard constraint. */
	inBed: boolean;
	/** Most recent GPS fix AT OR BEFORE this minute. Used by the
	 *  geometric feasibility factor — when this minute's `gps` is
	 *  null, a stationary @ knownPlace state can be scored against
	 *  the implied teleport speed from `prevGpsFix` to the place
	 *  centroid. When the minute itself has GPS, `prevGpsFix === gps`. */
	prevGpsFix: { ts: number; lat: number; lon: number } | null;
	/** Most recent GPS fix AT OR AFTER this minute. Symmetric to
	 *  `prevGpsFix` for the forward direction — a stat @ A pick at
	 *  minute t must also be consistent with the next observed fix. */
	nextGpsFix: { ts: number; lat: number; lon: number } | null;
	/** Distance (m) from this minute's fix to the nearest drivable road,
	 *  and to the nearest rail-only way. Computed at input-load time from
	 *  the OSM mirror (the same `nearbyWays` source the velocity layer
	 *  uses), so the line-proximity factor can tell "riding the track"
	 *  from "driving past it". Null when no fix landed in the minute, or
	 *  the kind wasn't in range; absent entirely on fixtures captured
	 *  before road proximity existed (then the factor skips the test). */
	roadDistM?: number | null;
	railDistM?: number | null;
}

export interface ObservationTensorInput {
	/** Local-tz date string `YYYY-MM-DD`. */
	date: string;
	/** IANA timezone for boundary + local-clock derivation. */
	tz: string;
	/** Kalman-filtered GPS fixes anywhere in the world (this function
	 *  filters by the local day's UTC window). */
	points: readonly FilteredPoint[];
	/** HR samples — same filtering applies. */
	hr: readonly HrPoint[];
	/** Step rows — same filtering applies. */
	steps: readonly StepPoint[];
	/** Fitbit sleep-stage records overlapping the day. Each record is a
	 *  (startTs, endTs, stage) interval. Used to populate
	 *  `Observation.inBed` per minute. When omitted, all minutes have
	 *  `inBed = false`. */
	sleep?: readonly { startTs: number; endTs: number; stage: string }[];
	/** Rail/road proximity per minute, keyed by the minute's top-of-minute
	 *  ts (= `Observation.ts`), from `computeMinuteProximity`. Computed at
	 *  the same per-minute median coordinate this builder uses for
	 *  `Observation.gps`, so the distance and the line-near check refer to
	 *  one coherent location. Omitted on inputs/fixtures captured before
	 *  #238 — then the distances stay null and the line-proximity factor
	 *  keeps its pre-#238 behaviour. */
	proximityByMinute?: ReadonlyMap<number, { railDistM: number | null; roadDistM: number | null }>;
}

const MINUTES_PER_DAY = 1440;
const SECONDS_PER_MINUTE = 60;

export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	let sum = 0;
	for (const v of values) sum += v;
	return sum / values.length;
}

/**
 * Compute local hour and day-of-week for a given UTC ts in a tz.
 * Uses `Intl.DateTimeFormat` rather than a date library — matches the
 * convention already established in `dateBoundsUtc`.
 */
function localCtx(ts: number, tz: string): { hour: number; dayOfWeek: number } {
	const d = new Date(ts * 1000);
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hour: "2-digit",
		hour12: false,
		weekday: "short",
	});
	const parts = fmt.formatToParts(d);
	const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
	// Intl renders 00 as "24" in some en-US patterns; coerce.
	const hour = Number(hourStr) % 24;
	const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
	const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
	const dayOfWeek = wdMap[wd] ?? 0;
	return { hour, dayOfWeek };
}

export function buildObservationTensor(input: ObservationTensorInput): Observation[] {
	const { date, tz, points, hr, steps, sleep, proximityByMinute } = input;
	const { startUtc, endUtc } = dateBoundsUtc(date, tz);

	// Pre-bucket the input streams by minute index for O(N) aggregation
	// instead of O(N × 1440).
	const gpsBuckets: FilteredPoint[][] = Array.from({ length: MINUTES_PER_DAY }, () => []);
	const hrBuckets: HrPoint[][] = Array.from({ length: MINUTES_PER_DAY }, () => []);
	// Step rows are nominally one-per-minute (top-of-minute); but we
	// allow multiple per bucket to handle sub-minute resolution if it
	// ever shows up — the aggregation is a sum either way.
	const stepBuckets: Array<StepPoint[] | null> = Array.from({ length: MINUTES_PER_DAY }, () => null);
	// Per-minute sleep flag — set true when any sleep_stages record
	// overlaps this minute (regardless of stage). Brief mid-night
	// "wake" rows still imply "in bed" for our purposes.
	const inBedBuckets: boolean[] = new Array(MINUTES_PER_DAY).fill(false);

	function bucketIndex(ts: number): number | null {
		if (ts < startUtc || ts >= endUtc) return null;
		const m = Math.floor((ts - startUtc) / SECONDS_PER_MINUTE);
		if (m < 0 || m >= MINUTES_PER_DAY) return null;
		return m;
	}

	for (const p of points) {
		const m = bucketIndex(p.ts);
		if (m !== null) gpsBuckets[m].push(p);
	}
	for (const h of hr) {
		const m = bucketIndex(h.ts);
		if (m !== null) hrBuckets[m].push(h);
	}
	for (const s of steps) {
		const m = bucketIndex(s.ts);
		if (m === null) continue;
		const existing = stepBuckets[m];
		if (existing === null) stepBuckets[m] = [s];
		else existing.push(s);
	}
	// Mark every minute that any sleep_stages record overlaps. A record
	// (startTs, endTs) covers minutes floor((startTs - startUtc)/60)
	// through ceil((endTs - startUtc)/60) - 1.
	if (sleep) {
		for (const rec of sleep) {
			const startMin = Math.max(0, Math.floor((rec.startTs - startUtc) / SECONDS_PER_MINUTE));
			const endMin = Math.min(MINUTES_PER_DAY, Math.ceil((rec.endTs - startUtc) / SECONDS_PER_MINUTE));
			for (let m = startMin; m < endMin; m++) inBedBuckets[m] = true;
		}
	}

	// First pass: build the per-minute aggregates without
	// prev/next-fix context.
	type Aggregated = Omit<Observation, "prevGpsFix" | "nextGpsFix">;
	const aggregated: Aggregated[] = new Array(MINUTES_PER_DAY);
	for (let m = 0; m < MINUTES_PER_DAY; m++) {
		const ts = startUtc + m * SECONDS_PER_MINUTE;
		const { hour, dayOfWeek } = localCtx(ts, tz);

		const gpsRows = gpsBuckets[m];
		const gps =
			gpsRows.length === 0
				? null
				: {
						lat: median(gpsRows.map((p) => p.lat)),
						lon: median(gpsRows.map((p) => p.lon)),
						speedKmh: mean(gpsRows.map((p) => p.speed_kmh)),
					};

		// Per-minute rail/road proximity, looked up by this minute's ts.
		// Computed upstream at the same median coordinate as `gps`, so the
		// distances and the line-near check refer to one location. Null
		// when no proximity was supplied (older fixtures) — the
		// line-proximity factor then skips the road-vs-rail test.
		const prox = proximityByMinute?.get(ts);
		const roadDistM = prox?.roadDistM ?? null;
		const railDistM = prox?.railDistM ?? null;

		const hrRows = hrBuckets[m];
		const hrAgg = hrRows.length === 0 ? null : mean(hrRows.map((h) => h.bpm));

		const stepRows = stepBuckets[m];
		const cadence = stepRows === null ? null : stepRows.reduce((sum, s) => sum + s.steps, 0);

		aggregated[m] = {
			ts,
			inBed: inBedBuckets[m],
			gps,
			hr: hrAgg,
			cadence,
			hourLocal: hour,
			dayOfWeekLocal: dayOfWeek,
			roadDistM,
			railDistM,
		};
	}

	// Second pass: fill prevGpsFix (forward) and nextGpsFix (backward
	// scan). Each is O(N) with a single accumulator carrying the
	// last-seen-fix forward or backward.
	const prevFixes: Observation["prevGpsFix"][] = new Array(MINUTES_PER_DAY).fill(null);
	const nextFixes: Observation["nextGpsFix"][] = new Array(MINUTES_PER_DAY).fill(null);
	let runningPrev: Observation["prevGpsFix"] = null;
	for (let m = 0; m < MINUTES_PER_DAY; m++) {
		const a = aggregated[m];
		if (a.gps !== null) runningPrev = { ts: a.ts, lat: a.gps.lat, lon: a.gps.lon };
		prevFixes[m] = runningPrev;
	}
	let runningNext: Observation["nextGpsFix"] = null;
	for (let m = MINUTES_PER_DAY - 1; m >= 0; m--) {
		const a = aggregated[m];
		if (a.gps !== null) runningNext = { ts: a.ts, lat: a.gps.lat, lon: a.gps.lon };
		nextFixes[m] = runningNext;
	}

	const tensor: Observation[] = new Array(MINUTES_PER_DAY);
	for (let m = 0; m < MINUTES_PER_DAY; m++) {
		tensor[m] = { ...aggregated[m], prevGpsFix: prevFixes[m], nextGpsFix: nextFixes[m] };
	}
	return tensor;
}
