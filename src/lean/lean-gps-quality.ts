/**
 * Request-path adoption of the verified GPS quality pre-filter.
 *
 * `Verified.Geo.GpsQuality.qualityFilterGps` drops physically-incoherent runs
 * of fixes (underground / cell-tower garbage) so downstream gap-inference sees
 * an honest temporal gap. It runs one call above the Kalman filter — the two
 * are consecutive lines in `computeVelocity` — and, like it, had no caller
 * until now (#388).
 *
 *   off    (default) — pure TS, zero behaviour change. The bridge is never
 *            touched; no measurement.
 *   shadow — run BOTH, SERVE the TS track, compare, record.
 *   on     — run BOTH, SERVE the verified track, still compare and record.
 *            Fall back to TS on any bridge failure.
 *
 * **Why this one has NO ULP class, unlike `lean-kalman`.** The filter is
 * drop-only: every fix it emits is a *copy of an input fix*, never a computed
 * value. Inputs cross the wire as exact IEEE bit patterns (`float-bits.ts`), so
 * both arms select from bit-identical candidates and the output is pure
 * selection. `cos` (via `distanceM`) reaches only the threshold comparisons.
 *
 * That makes the gate strictly sharper than the Kalman one: any divergence at
 * all is a DECISION flip — the two arms disagreeing about whether a run is
 * garbage — and the only mechanism that can cause one is a 1-ULP `cos`
 * difference landing exactly on a threshold (SPEED_CEILING_KMH 150,
 * ACCURACY_CEILING_M 80, GARBAGE_MIN_SPEED_KMH 15,
 * MIN_TRANSIT_DISPLACEMENT_M 800). On real data those comparisons sit far from
 * their boundaries, so the honest expectation is zero. A divergence should be
 * read as a finding and adjudicated, not filed as noise.
 *
 * Caveat worth stating plainly: `GpsQuality.lean` carries only 2 `#guard`s for
 * a filter with five thresholds and three branch paths, where `Kalman.lean` has
 * 10. The corpus shadow is doing most of the verification work here, not the
 * in-build pinning.
 */

import type { GpsPoint } from "../geo/kalman.js";
import { floatToBits } from "./float-bits.js";
import { LeanBridgeError, type LeanGpsQualityResp, leanGpsQualityServe } from "./lean-core.js";
import { type LedgerVerdict, servedNote } from "./ledger-verdict.js";
import { type LeanRunScope, leanRunScope } from "./run-scope.js";
import { verifiedCoreOverride } from "./runtime-mode.js";

export type LeanGpsQualityMode = "off" | "shadow" | "on";

export function leanGpsQualityMode(): LeanGpsQualityMode {
	// The settings-UI master override wins over the env default when set.
	const o = verifiedCoreOverride();
	if (o !== null) return o ? "on" : "off";
	const v = process.env.LEAN_GPSQUALITY;
	return v === "on" || v === "shadow" ? v : "off";
}

interface GpsQualityStat {
	/** Successful bridge calls (the verified filter ran and returned). */
	calls: number;
	/** Bridge failures caught and fallen back to TS (LeanBridgeError). */
	fails: number;
	/** Calls where the two arms kept a different NUMBER of fixes. */
	lenDiffs: number;
	/** Calls where the counts matched but the selections differed. */
	pickDiffs: number;
	/** Total fixes whose keep/drop decision differed, across all calls. */
	fixes: number;
}

const empty = (): GpsQualityStat => ({ calls: 0, fails: 0, lenDiffs: 0, pickDiffs: 0, fixes: 0 });

let stats: GpsQualityStat = empty();

export function leanGpsQualityStats(): Readonly<GpsQualityStat> {
	return stats;
}

export interface GpsQualityDivergence {
	/** Input track length — identifies the call without logging coordinates. */
	n: number;
	tsKept: number;
	leanKept: number;
	/** Compact symmetric difference of the two keep-sets, by input index. */
	note: string;
	scope: LeanRunScope;
}

const MAX_DIVERGENCES = 20;
let divergences: GpsQualityDivergence[] = [];

export function leanGpsQualityDivergences(): readonly GpsQualityDivergence[] {
	return divergences;
}

export function resetLeanGpsQualityStats(): void {
	stats = empty();
	divergences = [];
}

/** A fix as its four wire values — the identity used to match a returned row
 *  back to its input. Bits, not numbers, so `-0`/`NaN` cannot alias. */
function key(p: GpsPoint): string {
	return `${p.ts}|${floatToBits(p.lat)}|${floatToBits(p.lon)}|${p.accuracy === null ? "n" : floatToBits(p.accuracy)}`;
}

/**
 * Indices of a drop-only, order-preserving result within the input, by
 * lock-step walk. The filter returns a subsequence, so this recovers exactly
 * which input fixes survived — for both arms, so the comparison is
 * index-set vs index-set.
 */
function keptIndices(points: readonly GpsPoint[], keptKeys: readonly string[]): number[] {
	const out: number[] = [];
	let j = 0;
	for (let i = 0; i < points.length && j < keptKeys.length; i++) {
		if (key(points[i]) === keptKeys[j]) {
			out.push(i);
			j += 1;
		}
	}
	return out;
}

/** Compact description of how two keep-index sets differ (for the ledger). */
function symdiffNote(ts: readonly number[], lean: readonly number[]): string {
	const tsSet = new Set(ts);
	const leanSet = new Set(lean);
	const tsOnly = ts.filter((i) => !leanSet.has(i));
	const leanOnly = lean.filter((i) => !tsSet.has(i));
	return `ts-only=[${tsOnly.slice(0, 10)}] lean-only=[${leanOnly.slice(0, 10)}]`;
}

/**
 * Quality-filter a raw GPS track through the verified core, staged behind
 * `LEAN_GPSQUALITY`. `tsResult` is what the call site already computed with
 * `qualityFilterGps(points)`. Both `shadow` and `on` run the verified filter
 * and compare; `on` serves the verified selection, recovered as the ORIGINAL
 * input objects so downstream sees the same identities. Any bridge failure is
 * recorded and falls back to `tsResult`.
 */
export function qualityFilterGpsViaLean(points: readonly GpsPoint[], tsResult: GpsPoint[]): GpsPoint[] {
	const mode = leanGpsQualityMode();
	if (mode === "off" || points.length <= 2) return tsResult;

	let lean: LeanGpsQualityResp;
	try {
		lean = leanGpsQualityServe({
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

	const leanKeys = lean.pts.map((r) => `${r[0]}|${r[1]}|${r[2]}|${r[3] === null ? "n" : r[3]}`);
	const leanIdx = keptIndices(points, leanKeys);
	const tsIdx = keptIndices(points, tsResult.map(key));

	const same = tsIdx.length === leanIdx.length && tsIdx.every((v, i) => v === leanIdx[i]);
	if (!same) {
		const note = symdiffNote(tsIdx, leanIdx);
		if (tsIdx.length !== leanIdx.length) stats.lenDiffs += 1;
		else stats.pickDiffs += 1;
		const tsSet = new Set(tsIdx);
		const leanSet = new Set(leanIdx);
		stats.fixes += tsIdx.filter((i) => !leanSet.has(i)).length + leanIdx.filter((i) => !tsSet.has(i)).length;
		if (divergences.length < MAX_DIVERGENCES) {
			divergences.push({
				n: points.length,
				tsKept: tsIdx.length,
				leanKept: leanIdx.length,
				note,
				scope: leanRunScope(),
			});
		}
		if (mode === "shadow") console.warn(`[lean-gpsquality] divergence (n=${points.length}): ${note}`);
	}

	// `leanIdx` indexes the ORIGINAL array, so `on` serves the input objects —
	// never the round-tripped copies. Identity downstream is preserved.
	return mode === "on" ? leanIdx.map((i) => points[i]) : tsResult;
}

/**
 * Print the quality-filter ledger and reset it. Called per day from
 * `decode-day`.
 *
 * Two levels, not three: unlike `lean-kalman` there is no expected divergence
 * class to grade, so anything other than EXACT is a decision flip and reads
 * loud. If one ever appears, adjudicate which arm is right rather than
 * widening the verdict.
 */
export function logLeanGpsQualityLedger(label: string): LedgerVerdict | null {
	const mode = leanGpsQualityMode();
	if (mode === "off") return null;
	const s = stats;
	const clean = s.lenDiffs === 0 && s.pickDiffs === 0;
	// Zero calls is not a pass — see the note in lean-kalman.ts (#392).
	const verdict = s.calls === 0 ? "NOT EXERCISED" : clean ? "EXACT" : `${s.lenDiffs + s.pickDiffs} DIVERGED`;
	const detail = clean ? "" : ` — len=${s.lenDiffs} pick=${s.pickDiffs} (${s.fixes} fixes)`;
	const served = divergences.filter((d) => d.scope === "decode").length;
	const servedTag = servedNote(mode, served);
	const calls =
		divergences.length === 0
			? ""
			: ` — ${divergences.map((d) => `[${d.scope}] n=${d.n} ts=${d.tsKept} lean=${d.leanKept} ${d.note}`).join("; ")}`;
	console.log(
		`lean-gpsquality[${mode}] ${label} ${s.calls}/${s.fails}f${s.calls === 0 ? " (no calls)" : ""}${detail} ${verdict}${servedTag}${calls}`,
	);
	const out: LedgerVerdict = {
		tenant: "gpsquality",
		mode,
		calls: s.calls,
		fails: s.fails,
		// No per-item fingerprint: this tenant compares whole outputs, so a
		// divergence of its own cannot be recorded in the ceiling and always fails.
		unexplained: [],
		klass: s.calls === 0 ? "not-exercised" : clean ? "exact" : "diverged",
	};
	resetLeanGpsQualityStats();
	return out;
}
