/**
 * Request-path adoption of the verified GPS Kalman filter.
 *
 * `Verified.Geo.Kalman.filterGpsTrack` has been complete and `#guard`-pinned
 * against Node/V8 for a while; what was missing was any caller, so the ported
 * filter never ran on a real day. This is that caller — the first *execution*
 * slice of the written-but-idle Lean surface (#387).
 *
 *   off    (default) — pure TS, zero behaviour change. The bridge is never
 *            touched; no measurement.
 *   shadow — run BOTH, SERVE the TS track, compare bit-exact, record.
 *   on     — run BOTH, SERVE the verified track, still compare and record.
 *            Fall back to TS on any bridge failure.
 *
 * Its own flag, for the same reason `LEAN_RAIL` is separate from `LEAN_MATCH`:
 * each tenant's soak is its own decision.
 *
 * **What `on` adopts.** Unlike the geometry passes and the matcher, nothing
 * here is quantised — the filter is a covariance recursion over raw degrees,
 * and the seventh decimal of a fix moves the gain. So the wire carries exact
 * bits, and `+`/`-`/`*`/`÷`/`sqrt` are exact in both runtimes.
 *
 * The bar is NOT bit-exactness, and measurement is why. `compare-kalman` over
 * all 32 golden days: row counts always agree, `lat` is always identical, and
 * `lon` differs by ≤1 ULP on ~0.5% of rows (worst day 19 ULP, where the
 * recursion compounds a run of them). Root cause, measured directly over
 * bit-exact inputs: Lean's `Float.cos` and V8's `Math.cos` disagree by 1 ULP on
 * 65 of 860 (7.6%) of one real day's latitudes. `metersToDegreesLon` calls
 * `cos`; `metersToDegreesLat` does not — which is exactly why `lat` is clean,
 * and makes the attribution a controlled comparison rather than a guess.
 * `speed`/`bearing` are `Math.round`-quantised on the normal path (so the ULP
 * wobble washes out) and raw on the reset path (so it shows) — the handful of
 * speed/bearing divergences are all reset rows.
 *
 * **`bearing` is measured as an angle, not as bits.** It is modular, so 0° and
 * 360° are one heading with 4.6e18 ULPs between their bit patterns. The first
 * real in-cluster soak (2026-07-29) hit exactly that and reported DIVERGED —
 * the loudest verdict — for two arms that agreed on the direction precisely.
 * `float-gap.ts` now measures the short way round the circle for `bearing` and
 * true ULP distance for the rest — the latter via a sign-aware ordinal, which
 * is a correctness measure rather than a rescue: within one sign, which is
 * every comparison this ledger has actually made, it changes nothing.
 *
 * That is a permanent property of running one algorithm on two libms, not a
 * defect to fix: 1 ULP of longitude here is ~1e-17°, femtometres, against a
 * display grid of 1e-7°. It is also the concrete argument for eventually taking
 * the metre↔degree scaling off `Float` — a fixed-point or rational formulation
 * would agree exactly AND be provable, where two IEEE `cos` implementations can
 * never be made to.
 *
 * So the ledger reports magnitude, not just presence. What must stay at zero is
 * `lenDiffs`: the two arms disagreeing about which fixes to KEEP is structural,
 * and no ULP story explains it.
 *
 * **Where this runs.** One call per `computeVelocity`, over the whole day's
 * quality-filtered track — upstream of segmentation and of everything the
 * decode sees. That makes it the highest-leverage single call in the pipeline
 * and also the bluntest: a divergence here moves every downstream boundary.
 */

import type { FilteredPoint, GpsPoint } from "../geo/kalman.js";
import { floatFromBits, floatToBits } from "./float-bits.js";
import { circularDegGap, ulpGap } from "./float-gap.js";
import { LeanBridgeError, type LeanKalmanResp, leanKalmanServe } from "./lean-core.js";
import { type LeanRunScope, leanRunScope } from "./run-scope.js";
import { verifiedCoreOverride } from "./runtime-mode.js";

export type LeanKalmanMode = "off" | "shadow" | "on";

export function leanKalmanMode(): LeanKalmanMode {
	// The settings-UI master override wins over the env default when set.
	const o = verifiedCoreOverride();
	if (o !== null) return o ? "on" : "off";
	const v = process.env.LEAN_KALMAN;
	return v === "on" || v === "shadow" ? v : "off";
}

interface KalmanStat {
	/** Successful bridge calls (the verified filter ran and returned). */
	calls: number;
	/** Bridge failures caught and fallen back to TS (LeanBridgeError). */
	fails: number;
	/** Calls where the two arms emitted different row COUNTS. The filter drops
	 *  rows (duplicate timestamps, innovation-gated fixes), so a count mismatch
	 *  means the two arms disagreed about which fixes to keep — a louder finding
	 *  than a value difference, and the first thing to look at. */
	lenDiffs: number;
	/** Calls where the counts matched but some row differed bit-for-bit. This is
	 *  the EXPECTED class (the `cos` ULP difference, see the header), so its
	 *  presence alone is not a finding — `worstUlp` is what says whether it is
	 *  still that class. */
	rowDiffs: number;
	/** Total differing ROWS across all calls — the magnitude behind `rowDiffs`,
	 *  which counts calls. Printed as `rows=`; it was printed as `cells=` until
	 *  2026-07-30, which made a single row look like sixteen findings. */
	rows: number;
	/** Largest ULP distance in any differing `lat`/`lon`/`speed`. Single digits
	 *  is the known libm class; anything larger is a different phenomenon and
	 *  should be read as one. `bigint` because the gap can exceed 2^53, where
	 *  `Number` rounds silently. */
	worstUlp: bigint;
	/** Largest ANGULAR difference in any differing `bearing`, in degrees.
	 *  Separate from `worstUlp` because bearing is modular and its bit distance
	 *  measures nothing — see `float-gap.ts`. */
	worstBearingDeg: number;
	/** Bearing rows that differ while BOTH runtimes emit speed 0.
	 *
	 *  Not a divergence, and not a tolerance either — a category error being
	 *  retired. Bearing is `atan2(vLon, vLat)`, so at a standstill it is the
	 *  direction of a vector whose components are both ~0: unconstrained, and a
	 *  quantity neither runtime can be right about. Speed is quantised to
	 *  0.1 km/h, so the two arms agree on a rounded `0` while their underlying
	 *  velocities differ, and bearing — quantised only to 1° — is the one place
	 *  that shows. Measured on the corpus: 8° vs 351°, at speed 0 (#393).
	 *
	 *  Counted rather than ignored, because the number is the evidence for the
	 *  separate, REAL defect it points at: the pipeline serves a fabricated
	 *  heading for stationary points, in TS as much as in Lean, to some fifteen
	 *  downstream modules. That is #394, and it is not the port's doing. */
	stationaryBearing: number;
	/** The row that produced {@link worstBearingDeg}, described field-by-field.
	 *  A magnitude alone names no instance: `≤17° bearing` says a real angular
	 *  disagreement exists somewhere in the corpus and gives you no way to go
	 *  look at it — the per-call record only keeps each call's FIRST differing
	 *  row, which is rarely the worst one. Empty while no bearing has differed. */
	worstBearingNote: string;
}

const empty = (): KalmanStat => ({
	calls: 0,
	fails: 0,
	lenDiffs: 0,
	rowDiffs: 0,
	rows: 0,
	worstUlp: 0n,
	worstBearingDeg: 0,
	worstBearingNote: "",
	stationaryBearing: 0,
});

let stats: KalmanStat = empty();

export function leanKalmanStats(): Readonly<KalmanStat> {
	return stats;
}

export interface KalmanDivergence {
	/** Input track length — enough to identify the call without logging coordinates. */
	n: number;
	tsLen: number;
	leanLen: number;
	/** Rows differing bit-for-bit (0 when the lengths already disagree). */
	diffRows: number;
	/** First differing row, described field-by-field. */
	first: string;
	scope: LeanRunScope;
}

/** Bound the record so a pathological run cannot grow it without limit; the
 *  counters above stay exact regardless. */
const MAX_DIVERGENCES = 20;
let divergences: KalmanDivergence[] = [];

export function leanKalmanDivergences(): readonly KalmanDivergence[] {
	return divergences;
}

export function resetLeanKalmanStats(): void {
	stats = empty();
	divergences = [];
}

/** A filtered point as the five wire values — the exact comparison basis.
 *  Compared as BITS, not as numbers: `===` would call `-0` equal to `0` and
 *  every `NaN` unequal to itself, and both of those are differences the ledger
 *  must see. */
function wireRow(p: FilteredPoint): [number, string, string, string, string] {
	return [p.ts, floatToBits(p.lat), floatToBits(p.lon), floatToBits(p.speed_kmh), floatToBits(p.bearing)];
}

const FIELDS = ["ts", "lat", "lon", "speed", "bearing"] as const;
/** Index of the one modular field. Everything else is a plain magnitude. */
const BEARING = 4;

/** How wide is this field's divergence, in the units that field understands?
 *  `ts` is an integer and has no ULP reading; `bearing` is an angle and has no
 *  meaningful bit distance; the rest are compared as ULPs. */
function fieldGap(k: number, a: unknown, b: unknown): string {
	if (k === 0) return "";
	if (k === BEARING) return `${circularDegGap(String(a), String(b))}°`;
	return `${ulpGap(String(a), String(b))}ulp`;
}

/** Name the fields of one row that differ, with both values and the gap — the
 *  ledger's whole diagnosis of a value divergence. The gap is the part that
 *  distinguishes the known `cos` class from something new. */
function rowNote(i: number, ts: readonly (number | string)[], lean: readonly unknown[]): string {
	const parts: string[] = [];
	for (let k = 0; k < FIELDS.length; k++) {
		if (String(ts[k]) === String(lean[k])) continue;
		if (k === 0) {
			parts.push(`ts ${ts[k]}≠${lean[k]}`);
			continue;
		}
		parts.push(
			`${FIELDS[k]} ${floatFromBits(String(ts[k]))}→${floatFromBits(String(lean[k]))} (${fieldGap(k, ts[k], lean[k])})`,
		);
	}
	return `row ${i}: ${parts.join(" ")}`;
}

/** Decode a Lean wire row back into a `FilteredPoint`. */
function fromWire(r: readonly unknown[]): FilteredPoint {
	return {
		ts: Number(r[0]),
		lat: floatFromBits(String(r[1])),
		lon: floatFromBits(String(r[2])),
		speed_kmh: floatFromBits(String(r[3])),
		bearing: floatFromBits(String(r[4])),
	};
}

/**
 * Filter a raw GPS track through the verified core, staged behind
 * `LEAN_KALMAN`. `tsResult` is the track the call site already computed with
 * `filterGpsTrack(points)`. Both `shadow` and `on` run the verified filter and
 * compare; `shadow` serves `tsResult`, `on` serves the verified track. Any
 * bridge failure is recorded and falls back to `tsResult` (swallow-over-wrong,
 * execution edition).
 */
export function filterGpsTrackViaLean(points: readonly GpsPoint[], tsResult: FilteredPoint[]): FilteredPoint[] {
	const mode = leanKalmanMode();
	if (mode === "off") return tsResult;

	let lean: LeanKalmanResp;
	try {
		lean = leanKalmanServe({
			pts: points.map((p) => [
				p.ts,
				floatToBits(p.lat),
				floatToBits(p.lon),
				p.accuracy === null ? null : floatToBits(p.accuracy),
			]),
		});
	} catch (e) {
		if (!(e instanceof LeanBridgeError)) throw e;
		stats.fails += 1;
		return tsResult;
	}
	if (lean.error !== undefined || lean.pts === undefined) {
		stats.fails += 1;
		return tsResult;
	}
	stats.calls += 1;

	const leanRows = lean.pts;
	const tsRows = tsResult.map(wireRow);

	const record = (diffRows: number, first: string): void => {
		if (divergences.length >= MAX_DIVERGENCES) return;
		divergences.push({
			n: points.length,
			tsLen: tsRows.length,
			leanLen: leanRows.length,
			diffRows,
			first,
			scope: leanRunScope(),
		});
	};

	if (tsRows.length !== leanRows.length) {
		stats.lenDiffs += 1;
		record(0, `lengths differ (in=${points.length})`);
		if (mode === "shadow") {
			console.warn(`[lean-kalman] length divergence in=${points.length} ts=${tsRows.length} lean=${leanRows.length}`);
		}
	} else {
		let diffRows = 0;
		let first = "";
		for (let i = 0; i < tsRows.length; i++) {
			const a = tsRows[i];
			const b = leanRows[i];
			if (a.every((v, k) => String(v) === String(b[k]))) continue;
			// Differing bits are not yet a differing ROW: a row whose only
			// disagreement is the heading of a standstill has nothing to disagree
			// about. Counted only if some field survives that filter.
			let realDiffs = 0;
			for (let k = 1; k < FIELDS.length; k++) {
				if (String(a[k]) === String(b[k])) continue;
				if (k === BEARING) {
					// A heading that does not exist. Both arms emitted the same speed and
					// that speed is 0 — so this row disagrees about the direction of a
					// standstill, which is not a fact either of them can get wrong. Kept
					// out of the worst-gap statistic so one undefined quantity cannot
					// mask a real heading divergence behind it; counted so the residue
					// stays visible. Anything with speed on it falls through and is a
					// finding, as before.
					if (String(a[3]) === String(b[3]) && floatFromBits(String(a[3])) === 0) {
						stats.stationaryBearing += 1;
						continue;
					}
					const gap = circularDegGap(String(a[k]), String(b[k]));
					if (gap > stats.worstBearingDeg) {
						stats.worstBearingDeg = gap;
						// Carry the row's SPEED even though it is not a differing field —
						// that is the point. Speed is quantised to 0.1 km/h and bearing to
						// 1°, so near a standstill both runtimes agree on a rounded 0.0
						// while the direction of a velocity whose components are both ~0
						// is unconstrained. A large angular gap sitting on an identical
						// near-zero speed is that story; on a real speed it is not.
						stats.worstBearingNote = `${rowNote(i, a, b)} @ speed ${floatFromBits(String(a[3]))}`;
					}
				} else {
					const g = ulpGap(String(a[k]), String(b[k]));
					if (g > stats.worstUlp) stats.worstUlp = g;
				}
				realDiffs += 1;
			}
			if (realDiffs === 0) continue;
			diffRows += 1;
			if (first === "") first = rowNote(i, a, b);
		}
		if (diffRows > 0) {
			stats.rowDiffs += 1;
			stats.rows += diffRows;
			record(diffRows, first);
			if (mode === "shadow") console.warn(`[lean-kalman] ${diffRows}/${tsRows.length} rows differ — ${first}`);
		}
	}

	return mode === "on" ? leanRows.map(fromWire) : tsResult;
}

/**
 * Print the Kalman ledger and reset it. Mirrors `logLeanRailLedger`; called
 * per day from `decode-day`.
 *
 * The verdict has three levels rather than two, because a bare EXACT/DIVERGED
 * split would report the known `cos` ULP class in the same words as a real
 * defect, and the reader would learn to ignore both:
 *
 *   EXACT      nothing differed.
 *   ULP        rows differ, all within a few bits — the measured libm class.
 *   DIVERGED   lengths disagree (the arms kept different fixes), or a gap too
 *              wide for that story. Read this one.
 *
 * No accepted-delta manifest: the geometry passes need one because a
 * quantisation near-tie flips a DECISION, and only a signed-off list can tell a
 * blessed flip from a new one. Here nothing decides — the divergence is a
 * magnitude, so a bound on it is a truer gate than an enumeration of instances.
 */
/** Widest bit gap still explained by the `cos` libm difference. Measured worst
 *  over the corpus is 19 (07-14, where the recursion compounds a run of 1-ULP
 *  inputs); this leaves headroom without letting a real defect hide. */
const ULP_CLASS_MAX = 64n;

/** Widest ANGULAR gap still explained by the same story. A 1-ULP wobble in a
 *  bearing is ~1e-14°, so this is generous by nine orders of magnitude and
 *  still nowhere near a heading anyone could see. Note what it is NOT: a way to
 *  wave through the 0°/360° wrap, which `circularDegGap` already reports as the
 *  zero it is. */
const BEARING_CLASS_MAX_DEG = 1e-6;

export function logLeanKalmanLedger(label: string): void {
	const mode = leanKalmanMode();
	if (mode === "off") return;
	const s = stats;
	const clean = s.lenDiffs === 0 && s.rowDiffs === 0;
	const ulpOnly = s.lenDiffs === 0 && s.worstUlp <= ULP_CLASS_MAX && s.worstBearingDeg <= BEARING_CLASS_MAX_DEG;
	const verdict = clean
		? "EXACT"
		: ulpOnly
			? `ULP (≤${s.worstUlp}, ≤${s.worstBearingDeg}°)`
			: `${s.lenDiffs + s.rowDiffs} DIVERGED`;
	const detail = clean
		? ""
		: ` — len=${s.lenDiffs} calls=${s.rowDiffs} rows=${s.rows} (≤${s.worstUlp}ulp, ≤${s.worstBearingDeg}° bearing)`;
	// Name the worst bearing instance whenever it is the thing that broke the ULP
	// class. Reporting only the magnitude tells you a real angular disagreement
	// exists and gives you nothing to go look at — the per-call record keeps each
	// call's FIRST differing row, which is rarely the worst one.
	const worstBearing =
		!clean && s.worstBearingDeg > BEARING_CLASS_MAX_DEG ? ` — worst bearing @ ${s.worstBearingNote}` : "";
	// Never silent, even when the verdict is EXACT. These rows are excluded from
	// the divergence count because a standstill has no heading to disagree about
	// — but the count is the running evidence for #394, and a class that stops
	// being printed is a class nobody re-examines.
	const stationary = s.stationaryBearing === 0 ? "" : ` +${s.stationaryBearing} stationary-bearing`;
	// Only shout about served output for a divergence the ULP story does not
	// cover — every `decode`-scope call diverges by a bit or two, so flagging
	// those would make the phrase permanent and therefore meaningless.
	const served = ulpOnly ? 0 : divergences.filter((d) => d.scope === "decode").length;
	const servedNote = served === 0 ? "" : ` ${served} IN SERVED OUTPUT`;
	const calls =
		divergences.length === 0
			? ""
			: ` — ${divergences.map((d) => `[${d.scope}] in=${d.n} ts=${d.tsLen} lean=${d.leanLen} ${d.first}`).join("; ")}`;
	console.log(
		`lean-kalman[${mode}] ${label} ${s.calls}/${s.fails}f${s.calls === 0 ? " (no calls)" : ""}${detail} ${verdict}${stationary}${servedNote}${worstBearing}${calls}`,
	);
	resetLeanKalmanStats();
}
