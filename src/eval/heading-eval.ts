/**
 * Heading-agreement eval — PDR Phase 0 (#296/#297), measurement only.
 *
 * The phone reports a course-over-ground (`cog`, degrees) with each Owntracks
 * fix, persisted in `motion_log` since 2026-07-01. Before any fusion design,
 * measure whether that heading is trustworthy during walks: compare it against
 * the GPS-derived course of each fix-to-fix hop. High agreement while moving
 * means `cog` can serve as the independent per-fix direction witness the
 * true-path proposal needs (the out-and-back-vs-straight disambiguator steps
 * alone cannot provide); low agreement means the capture side must change
 * before fusion is worth building. Pure: no IO.
 */

export interface TrackSample {
	ts: number;
	lat: number;
	lon: number;
}

/** One `motion_log` row's heading-relevant fields. */
export interface MotionSample {
	ts: number;
	/** Course over ground, degrees clockwise from north; null = not reported. */
	cogDeg: number | null;
	/** Phone-reported speed (km/h, the Owntracks `vel` convention); null = not reported. */
	velKmh: number | null;
}

export interface HeadingComparison {
	/** Hop start ts. */
	ts: number;
	cogDeg: number;
	/** GPS course of the hop this fix starts. */
	trackBearingDeg: number;
	/** Wrapped absolute difference, 0..180. */
	diffDeg: number;
	/** Hop length (m) — longer hops define their course more sharply. */
	hopM: number;
}

export interface CompareOptions {
	/** Motion sample must sit within this many seconds of the hop start. */
	joinToleranceS: number;
	/** Phone must report at least this speed for its cog to be meaningful. */
	minVelKmh: number;
	/** Hop must be at least this long for GPS to define a course at all. */
	minHopM: number;
}

export const DEFAULT_COMPARE: CompareOptions = {
	joinToleranceS: 3,
	minVelKmh: 1,
	minHopM: 3,
};

/** Wrapped absolute angular difference in degrees, 0..180. */
export function circularDiffDeg(a: number, b: number): number {
	const d = Math.abs(((a - b) % 360) + 360) % 360;
	return d > 180 ? 360 - d : d;
}

/** Initial bearing from `a` to `b`, degrees clockwise from north, 0..360. */
export function bearingDeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
	const φ1 = (a.lat * Math.PI) / 180;
	const φ2 = (b.lat * Math.PI) / 180;
	const Δλ = ((b.lon - a.lon) * Math.PI) / 180;
	const y = Math.sin(Δλ) * Math.cos(φ2);
	const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
	return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const EARTH_R_M = 6_371_000;

function hopMetres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
	const φ1 = (a.lat * Math.PI) / 180;
	const φ2 = (b.lat * Math.PI) / 180;
	const dφ = φ2 - φ1;
	const dλ = ((b.lon - a.lon) * Math.PI) / 180;
	const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
	return 2 * EARTH_R_M * Math.asin(Math.sqrt(h));
}

/**
 * Pair each track hop (fix i → fix i+1) with the phone heading reported
 * nearest the hop start, and report the wrapped course difference. A hop
 * compares only when: a motion sample sits within the join tolerance, it
 * carries a cog, the phone was moving (cog is undefined at a standstill),
 * and the hop is long enough for GPS to define a course.
 */
export function compareHeadings(
	trackFixes: readonly TrackSample[],
	motionFixes: readonly MotionSample[],
	opts: CompareOptions = DEFAULT_COMPARE,
): HeadingComparison[] {
	const usable = motionFixes.filter((m) => m.cogDeg !== null && (m.velKmh ?? 0) >= opts.minVelKmh);
	const byTs = [...usable].sort((a, b) => a.ts - b.ts);
	const out: HeadingComparison[] = [];
	for (let i = 0; i + 1 < trackFixes.length; i++) {
		const a = trackFixes[i];
		const b = trackFixes[i + 1];
		const hopM = hopMetres(a, b);
		if (hopM < opts.minHopM) continue;
		const m = nearestByTs(byTs, a.ts, opts.joinToleranceS);
		if (!m || m.cogDeg === null) continue;
		const course = bearingDeg(a, b);
		out.push({ ts: a.ts, cogDeg: m.cogDeg, trackBearingDeg: course, diffDeg: circularDiffDeg(m.cogDeg, course), hopM });
	}
	return out;
}

function nearestByTs(sorted: readonly MotionSample[], ts: number, tolS: number): MotionSample | null {
	// Binary search for the insertion point, then compare the neighbours.
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (sorted[mid].ts < ts) lo = mid + 1;
		else hi = mid;
	}
	let best: MotionSample | null = null;
	for (const cand of [sorted[lo - 1], sorted[lo]]) {
		if (!cand) continue;
		if (Math.abs(cand.ts - ts) > tolS) continue;
		if (!best || Math.abs(cand.ts - ts) < Math.abs(best.ts - ts)) best = cand;
	}
	return best;
}

export interface DiffSummary {
	n: number;
	medianDeg: number | null;
	p90Deg: number | null;
}

/** Median + p90 of a diff set; nulls (not zeros) when nothing compared. */
export function summarizeDiffs(diffs: readonly number[]): DiffSummary {
	if (diffs.length === 0) return { n: 0, medianDeg: null, p90Deg: null };
	const s = [...diffs].sort((a, b) => a - b);
	const q = (p: number): number => {
		const idx = p * (s.length - 1);
		const lo = Math.floor(idx);
		const hi = Math.ceil(idx);
		return s[lo] + (s[hi] - s[lo]) * (idx - lo);
	};
	return { n: s.length, medianDeg: q(0.5), p90Deg: q(0.9) };
}
