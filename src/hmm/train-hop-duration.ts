/**
 * Duration prior for the HSMM decode, with a one-stop-hop relaxation.
 *
 * The per-mode duration prior (`duration-dist.ts`) imposes a 2-minute
 * physical floor on every movement mode: a 1-minute `train` segment is
 * normally an *artifact* of the per-minute decoder bridging between two
 * stays, so it gets `HARD_FLOOR_LOG_PROB`.
 *
 * But a one-stop underground hop is a genuine sub-floor train event —
 * GPS is occluded from boarding until a single reacquisition fix near
 * the alighting platform, so the *observed* ride is one minute even
 * though the real ride happened. When the train generator vouches that
 * minute (a valid station-to-station candidate covers it), the ride is
 * structurally real, not a bridge artifact, so the floor must not apply.
 * For such a covered, sub-floor train segment we use a flat duration
 * prior (0 nats) over the short, coverage-bounded window: the generator
 * already encoded the ride's validity, and the GPS-truncated observed
 * duration carries no further information against it.
 *
 * Every other case — multi-minute trains (d ≥ floor), uncovered trains,
 * and all non-train modes — is unchanged, so the relaxation is invisible
 * to the existing decode (and the golden corpus).
 *
 * Pure module. No DB, no IO, no globals.
 */

import { type GammaFit, logDurationProb } from "./duration-dist.js";
import type { State } from "./state-space.js";

export interface DurationPriorOpts {
	/** Per-mode fitted Gamma duration distributions. */
	fits: Record<State["mode"], GammaFit>;
	/** Per-mode physical-floor minimum duration in minutes. */
	minByMode: Record<State["mode"], number>;
	/** Unix-seconds timestamp of the observation at `segEndIndex`, or
	 *  undefined when out of range. */
	tsAt: (segEndIndex: number) => number | undefined;
	/** Whether the train generator vouches a station-to-station ride at
	 *  the given minute timestamp. */
	isTrainCovered: (ts: number) => boolean;
}

/**
 * Build the HSMM duration log-prior. Returns `log P_d(d | state)` for a
 * segment of `state` of length `d` minutes ending at observation index
 * `segEndIndex`, with the one-stop-hop relaxation applied.
 */
export function buildDurationLogProb(
	opts: DurationPriorOpts,
): (state: State, durationMinutes: number, segEndIndex: number) => number {
	// Outside the relaxation branch below, the prior is `logDurationProb(d,
	// mode, fits[mode], minByMode[mode])` — a function of the mode and the
	// duration and nothing else. The HSMM asks for it once per (state,
	// duration, segment-end) cell, so at S=159 / maxD=240 / T=1440 the same
	// few thousand values were being recomputed ~55M times, each recompute
	// paying two string-keyed record lookups and a Gamma evaluation. Cache
	// per mode, indexed by duration; the table is bounded by maxD.
	const byMode = new Map<State["mode"], number[]>();
	const priorFor = (mode: State["mode"], d: number): number => {
		let row = byMode.get(mode);
		if (row === undefined) {
			row = [];
			byMode.set(mode, row);
		}
		const hit = row[d];
		if (hit !== undefined) return hit;
		const v = logDurationProb(d, mode, opts.fits[mode], opts.minByMode[mode]);
		row[d] = v;
		return v;
	};
	return (state, d, segEndIndex) => {
		// Relax the floor only for a sub-floor train segment on a named
		// line that the generator vouches — the one-stop-hop case. This is
		// the only part that depends on `segEndIndex`, so it stays outside
		// the cache.
		if (
			state.mode === "train" &&
			state.lineName !== null &&
			state.lineName !== "unknown_rail" &&
			d < opts.minByMode.train
		) {
			const ts = opts.tsAt(segEndIndex);
			if (ts !== undefined && opts.isTrainCovered(ts)) return 0;
		}
		return priorFor(state.mode, d);
	};
}
