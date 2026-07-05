/**
 * Static-prior transition log-probabilities for the MVP HMM.
 *
 * The full HMM design (`docs/archive/2025-model-hmm.md`) learns
 * transitions from heuristic-pipeline bootstrap labels with Dirichlet
 * smoothing. For the MVP we use a hand-tuned rule-based prior — it
 * captures the structural truths without the bootstrap-bias risk
 * of learning from biased labels.
 *
 * Calibration:
 *   - Self-loops: log(0.95) ≈ -0.05. The HMM stays in a state
 *     minute-to-minute most of the time. Strong self-bias is the
 *     "Station B" mechanism: when emission is ambiguous, the
 *     self-loop pulls the path through.
 *   - Mode changes (e.g. stationary → walking): log(0.02). Common
 *     enough to fire when emission supports them.
 *   - Hard-zero rules — structural impossibilities:
 *     - stationary @ A → stationary @ B (different non-null places):
 *       impossible. Must pass through a moving state.
 *
 * Station-graph hard-zeros (train @ L cannot serve a place not on
 * line L) are wired at integration time, not here — they require
 * the per-place coordinates that this pure module doesn't know
 * about.
 *
 * Learned transitions and time-of-day conditioning are post-MVP.
 * The "rows sum to ≤ 1" test pins that the matrix is a proper
 * probability distribution even with hard-zeros.
 */

import type { State } from "./state-space.js";

export type TransitionLogProbFn = (from: State, to: State) => number;

export interface BuildTransitionMatrixOpts {
	states: readonly State[];
	/** Self-loop log-probability. Default log(0.95). */
	selfLoopLogProb?: number;
	/** Generic cross-state log-prob (when no specific rule applies).
	 *  Default log(0.02). */
	crossStateLogProb?: number;
	/** Station-graph hard-zero lookup: returns `true` when the given
	 *  focus_place is within walking distance of a station served by
	 *  the named rail line. When provided, transitions between
	 *  `train @ L` and `stationary @ P` (in either direction) are
	 *  hard-zeroed when `placeNearLine(P, L) === false`. */
	placeNearLine?: (placeId: number, lineName: string) => boolean;
}

const DEFAULT_SELF_LOOP = Math.log(0.95);

/** Modes in which you are aboard a vehicle. Moving between two *different*
 *  vehicles always requires alighting first — you cannot step from a car
 *  straight onto a moving train, or off a train straight onto a bicycle,
 *  without a non-vehicle moment (a platform wait, a walk to the car park)
 *  in between. */
const VEHICLE_MODES: ReadonlySet<string> = new Set(["driving", "train", "cycling", "plane"]);

/** Extra log-cost on a direct transition between two *distinct* vehicle
 *  modes (e.g. train → driving). Not a hard zero: the intervening walk can
 *  occasionally be sub-minute and so unobserved, and a hard zero would make
 *  a genuine fast interchange impossible. But ~8 nats is steep enough that
 *  the decoder strongly prefers to route through a walking/stationary minute
 *  — i.e. `train → walking → driving` beats `train → driving`. This is the
 *  rule that forbids the physically-absurd "drove along the tube line, then
 *  boarded the tube" narrative the per-segment cascade produces. */
const INTER_VEHICLE_PENALTY_LOG = -8;

function sameState(a: State, b: State): boolean {
	return a.mode === b.mode && a.placeId === b.placeId && a.lineName === b.lineName;
}

/** Relative prior weight of a cross-state transition, before per-row
 *  normalisation. 1 is the neutral default (the old uniform behaviour);
 *  values < 1 down-weight a physically-implausible pair. The cross mass is
 *  split across each row's valid destinations in proportion to this weight,
 *  so the matrix stays row-stochastic for any weighting. */
function transitionWeight(from: State, to: State): number {
	// Two different vehicles with no non-vehicle state between them.
	if (from.mode !== to.mode && VEHICLE_MODES.has(from.mode) && VEHICLE_MODES.has(to.mode)) {
		return Math.exp(INTER_VEHICLE_PENALTY_LOG);
	}
	return 1;
}

/**
 * Build a transition log-prob function over the given state space.
 *
 * Per-row normalised: for each `from` state, the self-loop holds
 * `exp(selfLoopLogProb)` of the probability mass, and the remaining
 * `1 - exp(selfLoopLogProb)` is split equally among the valid
 * (non-hard-zero) cross-state destinations. This keeps the matrix
 * a proper row-stochastic distribution regardless of state count
 * or how many hard-zeros apply to each row.
 *
 * `crossStateLogProb` is unused under the new normalisation but kept
 * in the options for API stability — future per-pair priors (e.g.
 * common vs rare transitions) will plug in here.
 */
export function buildTransitionMatrix(opts: BuildTransitionMatrixOpts): TransitionLogProbFn {
	const selfLoop = opts.selfLoopLogProb ?? DEFAULT_SELF_LOOP;
	const crossMass = 1 - Math.exp(selfLoop);
	const placeNearLine = opts.placeNearLine ?? null;

	const isHardZeroFn = (from: State, to: State): boolean => isHardZero(from, to, placeNearLine);

	// Pre-compute the per-row cross-state weight sum: for each from-state,
	// total the relative weights of its valid cross destinations. The cross
	// mass is then split in proportion to weight, so `log P(from→to) =
	// log(crossMass · w(from,to) / Σ w(from,·))`. Uniform weights reproduce
	// the old `crossMass / validCrossCount`. O(S²) once, then O(1) per query.
	const crossWeightSumByFrom = new Map<string, number>();
	for (const from of opts.states) {
		let weightSum = 0;
		for (const to of opts.states) {
			if (sameState(from, to)) continue;
			if (isHardZeroFn(from, to)) continue;
			weightSum += transitionWeight(from, to);
		}
		crossWeightSumByFrom.set(stateInternalKey(from), weightSum);
	}

	return (from: State, to: State): number => {
		if (sameState(from, to)) return selfLoop;
		if (isHardZeroFn(from, to)) return Number.NEGATIVE_INFINITY;
		const weightSum = crossWeightSumByFrom.get(stateInternalKey(from)) ?? 0;
		if (weightSum <= 0) return Number.NEGATIVE_INFINITY;
		return Math.log((crossMass * transitionWeight(from, to)) / weightSum);
	};
}

function isHardZero(
	from: State,
	to: State,
	placeNearLine: ((placeId: number, lineName: string) => boolean) | null,
): boolean {
	// Hard-zero: stationary @ A → stationary @ B with A ≠ B (whether
	// or not either side is a known place). The user can't teleport
	// between two stationary places without a moving state in
	// between. Includes the asymmetric case where one side is null
	// (off-network) — same principle, the user must move to get
	// there even if "there" is unobservable.
	if (from.mode === "stationary" && to.mode === "stationary" && from.placeId !== to.placeId) {
		return true;
	}

	// Station-graph hard-zero: a train on line L cannot alight at
	// place P if L doesn't serve any station near P, and (symmetric)
	// a stationary at P cannot board a train on L if L doesn't serve
	// P. Only fires when placeNearLine lookup is provided and the
	// line is a named line (not the unknown_rail catch-all).
	if (placeNearLine !== null) {
		if (
			from.mode === "train" &&
			to.mode === "stationary" &&
			to.placeId !== null &&
			from.lineName !== null &&
			from.lineName !== "unknown_rail"
		) {
			if (!placeNearLine(to.placeId, from.lineName)) return true;
		}
		if (
			from.mode === "stationary" &&
			to.mode === "train" &&
			from.placeId !== null &&
			to.lineName !== null &&
			to.lineName !== "unknown_rail"
		) {
			if (!placeNearLine(from.placeId, to.lineName)) return true;
		}
	}

	return false;
}

function stateInternalKey(s: State): string {
	return `${s.mode}|${s.placeId ?? "-"}|${s.lineName ?? "-"}`;
}
