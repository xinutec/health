/**
 * `buildInitialStatePrior` — initial-state log-prior at t=0.
 *
 * Currently uniform 0 — visit-frequency and hour-of-day are both
 * carried by the entry prior (which fires at t=0 and at every
 * new-segment transition). The module stays so callers have a
 * stable API for future t=0-specific priors.
 */

import { describe, expect, it } from "vitest";
import { buildInitialStatePrior } from "../src/hmm/initial-state.js";
import type { State } from "../src/hmm/state-space.js";

function state(mode: State["mode"], placeId: number | null = null, lineName: string | null = null): State {
	return { mode, placeId, lineName, trainEdgeId: null };
}

describe("buildInitialStatePrior", () => {
	it("returns uniform 0 across all states", () => {
		const prior = buildInitialStatePrior();
		expect(prior(state("stationary", 1))).toBe(0);
		expect(prior(state("stationary", null))).toBe(0);
		expect(prior(state("walking"))).toBe(0);
		expect(prior(state("cycling"))).toBe(0);
		expect(prior(state("driving"))).toBe(0);
		expect(prior(state("plane"))).toBe(0);
		expect(prior(state("train", null, "Metropolitan Line"))).toBe(0);
		expect(prior(state("unknown"))).toBe(0);
	});
});
