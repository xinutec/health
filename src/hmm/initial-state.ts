/**
 * Initial-state log-prior for the Viterbi decoder.
 *
 * The Viterbi decoder accepts an optional `initialLogProb(state)`
 * callback that scores each state at t=0 before the first emission
 * is added. Today this returns uniform 0 — visit-frequency and
 * hour-of-day are both carried by the entry prior (which fires at
 * t=0 AND at every new-segment transition), so the init prior has
 * no additional work.
 *
 * The function and module stay so callers have a stable API to wire
 * future t=0-specific priors (e.g. a strong-prior on overnight stays
 * never starting at off-network places) without touching the HSMM
 * Viterbi signature.
 *
 * Pure function. No DB, no IO, no globals.
 */

import type { State } from "./state-space.js";

export type InitialLogProbFn = (state: State) => number;

export function buildInitialStatePrior(): InitialLogProbFn {
	return (): number => 0;
}
