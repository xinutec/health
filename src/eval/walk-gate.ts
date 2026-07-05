/**
 * Walk-geometry ratchet gate — the drawn-line counterpart of `journey-gate.ts`.
 *
 * `npm run golden` gates day-STATES; the drawn walk geometry was refereed by
 * `score-walk-match` but never gated — the referee only measured anything when
 * a human invoked it, and its A/B exit (matcher vs smoother) carries standing
 * failures (#305), so it cannot be a deploy gate as-is.
 *
 * This is the ratchet: a local baseline (`tests/golden/walk-baseline.json`,
 * gitignored with the fixtures) records each walk's referee metrics. The gate
 * fails only when a walk gets WORSE than its recorded floor beyond the
 * per-metric epsilon; improvements are surfaced for re-bless. Standing defects
 * stay recorded and can only shrink. Pure: no IO.
 */

/** Referee metrics recorded per walk. null = honestly unmeasured (no building
 *  data in the fixture / no named-street truth over the leg). */
export interface WalkBaselineEntry {
	/** Episode start (unix seconds) — the walk's identity within its day. */
	startTs: number;
	/** Off-walkable p90 of the drawn line (m). */
	p90M: number | null;
	/** Corridor over-route (m). */
	stallM: number;
	/** Mean drawn speed (km/h). */
	speedKmh: number;
	/** Fraction of the line on the ground-truth-confirmed street. */
	routeCorr: number | null;
	/** Building-crossing while off every walkable way (m) — the true defect. */
	offPathM: number | null;
}

/** date → walks. The committed floor (locally, beside the fixtures). */
export type WalkBaseline = Record<string, WalkBaselineEntry[]>;

export type WalkGateMetric = "p90" | "stall" | "speed" | "route" | "offPath";

export interface WalkGateDelta {
	date: string;
	startTs: number;
	metric: WalkGateMetric;
	base: number;
	now: number;
}

export interface WalkGateResult {
	/** Walks worse than their recorded floor — these fail the gate. */
	regressed: WalkGateDelta[];
	/** Walks better than their floor — re-bless to ratchet it down. */
	improved: WalkGateDelta[];
	/** Baseline walks with no current counterpart. States are golden-gated, so
	 *  a vanished/merged walk is not a geometry failure — surfaced for re-bless. */
	unmatched: { date: string; startTs: number }[];
	/** Current walks the baseline has no floor for — record via bless. */
	added: { date: string; startTs: number }[];
	/** A metric that was measured in the baseline but is null now (lost
	 *  measurement, e.g. a scorer change) — surfaced loudly, does not fail. */
	unmeasured: { date: string; startTs: number; metric: WalkGateMetric }[];
}

/** p90 may rise this much (m) before it counts as a regression. */
export const P90_EPS_M = 3;
/** Over-route may rise this much (m). */
export const STALL_EPS_M = 15;
/** Route-correctness may fall this much (fraction). */
export const ROUTE_EPS = 0.1;
/** Off-path building-crossing may rise this much (m). */
export const OFFPATH_EPS_M = 5;
/** A drawn walk above this mean speed (km/h) is implausible on foot; the gate
 *  fires when a walk newly crosses the ceiling, not on standing offenders. */
export const WALK_SPEED_CEIL_KMH = 12;
/** A walk's startTs may shift this much (s) between runs and still be the
 *  same walk — small upstream segmentation moves must not drop its floor. */
export const START_TS_TOLERANCE_S = 120;

/** Pair baseline walks with current walks of the same day, nearest startTs
 *  first, one-to-one, within the tolerance. */
function pairWalks(
	base: readonly WalkBaselineEntry[],
	cur: readonly WalkBaselineEntry[],
): { pairs: [WalkBaselineEntry, WalkBaselineEntry][]; lostBase: WalkBaselineEntry[]; newCur: WalkBaselineEntry[] } {
	const candidates: { b: number; c: number; d: number }[] = [];
	for (let b = 0; b < base.length; b++) {
		for (let c = 0; c < cur.length; c++) {
			const d = Math.abs(base[b].startTs - cur[c].startTs);
			if (d <= START_TS_TOLERANCE_S) candidates.push({ b, c, d });
		}
	}
	candidates.sort((x, y) => x.d - y.d);
	const usedB = new Set<number>();
	const usedC = new Set<number>();
	const pairs: [WalkBaselineEntry, WalkBaselineEntry][] = [];
	for (const { b, c } of candidates) {
		if (usedB.has(b) || usedC.has(c)) continue;
		usedB.add(b);
		usedC.add(c);
		pairs.push([base[b], cur[c]]);
	}
	return {
		pairs,
		lostBase: base.filter((_, i) => !usedB.has(i)),
		newCur: cur.filter((_, i) => !usedC.has(i)),
	};
}

/**
 * Compare a run against the recorded floor. Only dates present in `current`
 * are compared (a single-day invocation must not read the other days' floors
 * as vanished); pass `onlyDates` to make that scope explicit.
 */
export function gateWalks(
	baseline: WalkBaseline,
	current: WalkBaseline,
	opts: { onlyDates?: readonly string[] } = {},
): WalkGateResult {
	const dates = opts.onlyDates ?? Object.keys(current);
	const out: WalkGateResult = { regressed: [], improved: [], unmatched: [], added: [], unmeasured: [] };

	for (const date of [...dates].sort()) {
		const { pairs, lostBase, newCur } = pairWalks(baseline[date] ?? [], current[date] ?? []);
		for (const w of lostBase) out.unmatched.push({ date, startTs: w.startTs });
		for (const w of newCur) out.added.push({ date, startTs: w.startTs });

		for (const [b, c] of pairs) {
			const at = { date, startTs: b.startTs };
			// Higher-is-worse metrics with an epsilon; null on either side never
			// compares (newly measured is not a regression; lost measurement is
			// surfaced separately).
			const axes: { metric: WalkGateMetric; base: number | null; now: number | null; eps: number; up: boolean }[] = [
				{ metric: "p90", base: b.p90M, now: c.p90M, eps: P90_EPS_M, up: true },
				{ metric: "stall", base: b.stallM, now: c.stallM, eps: STALL_EPS_M, up: true },
				{ metric: "route", base: b.routeCorr, now: c.routeCorr, eps: ROUTE_EPS, up: false },
				{ metric: "offPath", base: b.offPathM, now: c.offPathM, eps: OFFPATH_EPS_M, up: true },
			];
			for (const a of axes) {
				if (a.base === null) continue;
				if (a.now === null) {
					out.unmeasured.push({ ...at, metric: a.metric });
					continue;
				}
				const worse = a.up ? a.now - a.base : a.base - a.now;
				const delta: WalkGateDelta = { ...at, metric: a.metric, base: a.base, now: a.now };
				if (worse > a.eps) out.regressed.push(delta);
				else if (worse < -a.eps) out.improved.push(delta);
			}
			// Speed: gate only the ceiling crossing — a standing offender is
			// already recorded in the baseline and can only be fixed, not re-flagged.
			if (b.speedKmh <= WALK_SPEED_CEIL_KMH && c.speedKmh > WALK_SPEED_CEIL_KMH) {
				out.regressed.push({ ...at, metric: "speed", base: b.speedKmh, now: c.speedKmh });
			} else if (b.speedKmh > WALK_SPEED_CEIL_KMH && c.speedKmh <= WALK_SPEED_CEIL_KMH) {
				out.improved.push({ ...at, metric: "speed", base: b.speedKmh, now: c.speedKmh });
			}
		}
	}
	return out;
}
