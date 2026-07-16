/**
 * Segment-scoped physics evidence for the HSMM (C4.2 groundwork,
 * `docs/proposals/2026-07-continuity-c4.md`).
 *
 * Per-minute emissions score instants; nothing scores whether a candidate
 * segment's *story* is physically coherent. This factor does, once per
 * candidate segment, from three observables the trellis already carries:
 * the last GPS fix at-or-before the segment start (`prevGpsFix`), the
 * first at-or-after its end (`nextGpsFix`), and the measured step total
 * across its minutes.
 *
 *   - **stationary**: predicts ~zero net displacement (GPS-noise σ). A
 *     one-hour "stay" whose brackets are kilometres apart pays.
 *   - **walking**: predicts displacement ≈ measured steps × stride. The
 *     swallowed-hop signature — a blackout bridged at walking pace with
 *     half the steps the distance demands — pays hard; a slow genuine
 *     walk is within noise. Encodes the expected-vs-observed step
 *     likelihood the user asked for (steps are the discriminator in
 *     blackouts; speed is structurally blind).
 *   - **vehicles**: predict a mode-typical *net* displacement for the
 *     segment's duration (net, not instantaneous — stops and indirection
 *     included). A GPS-drift phantom micro-ride (multi-minute "drive"
 *     going nowhere) pays; a real dark tube ride at ~25 km/h net does not.
 *
 * **Bracket slop**: the bracketing fixes can sit well outside the segment
 * (deep in a GPS blackout the same pair brackets *every* candidate
 * sub-segment). The time between a bracket fix and the segment boundary
 * belongs to NEIGHBOURING segments, whose motion is unattributable to
 * this hypothesis — so σ grows by `SLOP_SPEED_M_PER_MIN` per slop minute
 * and stale brackets assert ~nothing. Without this, a genuine platform
 * wait inside a blackout is convicted of the whole dark ride's
 * displacement (measured 2026-07-16 on the acceptance suite: a
 * pre-boarding standstill and an interchange walk both clamped to −6
 * while `unknown`, which pays nothing, won the window).
 *
 * Shape discipline (probabilistic-principles): pure z²/2 penalties with
 * NO normalization constants — a hypothesis consistent with the physics
 * scores ~0 and inconsistency scores negative, so no mode carries a
 * generic bias from just having the term. Clamped at `CLAMP_NATS` so one
 * segment's absurdity never dominates a day. Everything is a graduated
 * likelihood; there are no gates.
 *
 * Pure module. No DB, no IO, no globals, no flags (the caller gates it).
 */

import type { Observation } from "./observation.js";
import type { State } from "./state-space.js";

/** Mean walking stride (metres per counted step). */
const STRIDE_M = 0.75;
/** Stride-model relative spread — cadence miscounts, path indirection
 *  (net displacement understates path length). */
const STRIDE_REL_STD = 0.4;
/** GPS noise floor on a net-displacement prediction (m). Covers fix
 *  scatter on both brackets plus door-vs-centroid offsets. */
const DISP_NOISE_M = 200;
/** Net-speed priors (km/h) for vehicle segments: slower and wider than
 *  the instantaneous per-minute speed priors — net includes stops,
 *  station dwells, and route indirection. */
const NET_SPEED: Partial<Record<State["mode"], { mean: number; std: number }>> = {
	cycling: { mean: 12, std: 6 },
	driving: { mean: 22, std: 12 },
	train: { mean: 28, std: 14 },
	plane: { mean: 400, std: 250 },
};
/** Unattributable-motion spread per minute of bracket slop (m/min).
 *  Slop time sits in neighbouring segments where anything up to urban
 *  vehicle pace (~30 km/h) may have happened. */
const SLOP_SPEED_M_PER_MIN = 500;
/** Hard clamp on the penalty — evidence, never a veto. */
const CLAMP_NATS = -6;

export interface SegmentEvidenceOpts {
	observations: readonly Observation[];
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** −z²/2, clamped. */
function zPenalty(observed: number, predicted: number, sigma: number): number {
	const z = (observed - predicted) / sigma;
	return Math.max(CLAMP_NATS, -0.5 * z * z);
}

/**
 * Build the segment-evidence term for the HSMM duration hook. Returns
 * `score(state, durationMinutes, segEndIndex)` in nats — compose
 * additively with the duration prior.
 */
export function buildSegmentEvidence(
	opts: SegmentEvidenceOpts,
): (state: State, durationMinutes: number, segEndIndex: number) => number {
	const obs = opts.observations;
	// Prefix sums of MEASURED cadence so a segment's step total is O(1).
	// Imputed/absent minutes contribute 0 either way — the budget uses
	// what the watch counted.
	const stepPrefix = new Array<number>(obs.length + 1);
	stepPrefix[0] = 0;
	for (let i = 0; i < obs.length; i++) {
		stepPrefix[i + 1] = stepPrefix[i] + (obs[i].cadence ?? 0);
	}

	return (state, durationMinutes, segEndIndex) => {
		if (state.mode === "unknown") return 0;
		const startIndex = segEndIndex - durationMinutes + 1;
		const first = obs[Math.max(0, startIndex)];
		const last = obs[segEndIndex];
		if (first === undefined || last === undefined) return 0;
		const before = first.prevGpsFix;
		const after = last.nextGpsFix;
		// No bracketing fixes on one side → the net displacement is
		// unobservable; assert nothing.
		if (before === null || after === null || after.ts <= before.ts) return 0;

		const dispM = haversineMeters(before.lat, before.lon, after.lat, after.lon);
		// Bracket slop: fix time not covered by the segment's own minutes.
		// Motion there belongs to neighbouring segments and widens σ.
		const segStartTs = first.ts;
		const segEndTs = last.ts + 60;
		const slopMin = (Math.max(0, segStartTs - before.ts) + Math.max(0, after.ts - segEndTs)) / 60;
		const slopVar = (SLOP_SPEED_M_PER_MIN * slopMin) ** 2;
		const withSlop = (sigma: number): number => Math.sqrt(sigma * sigma + slopVar);

		if (state.mode === "stationary") {
			return zPenalty(dispM, 0, withSlop(DISP_NOISE_M));
		}
		if (state.mode === "walking") {
			const steps = stepPrefix[Math.min(obs.length, segEndIndex + 1)] - stepPrefix[Math.max(0, startIndex)];
			const predicted = steps * STRIDE_M;
			const sigma = Math.max(STRIDE_REL_STD * predicted, DISP_NOISE_M);
			return zPenalty(dispM, predicted, withSlop(sigma));
		}
		const net = NET_SPEED[state.mode];
		if (net === undefined) return 0;
		const segH = durationMinutes / 60;
		const predicted = net.mean * 1000 * segH;
		const sigma = Math.max(net.std * 1000 * segH, DISP_NOISE_M);
		return zPenalty(dispM, predicted, withSlop(sigma));
	};
}
