/**
 * `viterbi` — pure-function MAP-sequence decoder over a discrete HMM.
 *
 * Standard forward + backpointer recovery in log-space (avoid
 * underflow on long sequences). Three core cases pin the algorithm:
 *
 *   1. **Deterministic chain**: known-correct hand-computed example.
 *      Two states A and B, observations clearly favour A then B then
 *      A; Viterbi must return [A, B, A].
 *
 *   2. **Transition prior wins over weak emission**: the "Station B"
 *      mechanism — when emission is ambiguous at a noisy minute,
 *      transition self-loop pulls the path through. Two states; the
 *      noisy minute's emission slightly prefers the wrong state but
 *      the transition prior + neighbour emissions dominate.
 *
 *   3. **Hard-zero transition**: a transition with -Infinity log-prob
 *      forbids that state pair. The MAP path must route around even
 *      if other factors would prefer it.
 *
 * Plus boundary cases: single-observation input, all-equal scores,
 * empty observations.
 */

import { describe, expect, it } from "vitest";
import { viterbi } from "../src/hmm/viterbi.js";

interface ToyState {
	id: string;
}

const A: ToyState = { id: "A" };
const B: ToyState = { id: "B" };

describe("viterbi", () => {
	it("returns empty path for empty observations", () => {
		const path = viterbi({
			observations: [],
			states: [A, B],
			transitionLogProb: () => 0,
			emissionLogProb: () => 0,
		});
		expect(path).toEqual([]);
	});

	it("returns the highest-emission single state for one observation", () => {
		// One observation, no transitions matter. The state with the
		// higher emission log-prob is the MAP path.
		const path = viterbi({
			observations: [{ idx: 0 }],
			states: [A, B],
			transitionLogProb: () => 0,
			emissionLogProb: (s, _o) => (s.id === "B" ? 0 : -10),
		});
		expect(path.map((s) => s.id)).toEqual(["B"]);
	});

	it("decodes a deterministic chain A → B → A by emissions alone", () => {
		// Emissions strongly favour A, B, A; transitions are uniform.
		const obsPreferences: Record<string, string> = { 0: "A", 1: "B", 2: "A" };
		const path = viterbi({
			observations: [{ idx: 0 }, { idx: 1 }, { idx: 2 }],
			states: [A, B],
			transitionLogProb: () => 0,
			emissionLogProb: (s, o) => (s.id === obsPreferences[(o as { idx: number }).idx] ? 0 : -10),
		});
		expect(path.map((s) => s.id)).toEqual(["A", "B", "A"]);
	});

	it("transition self-loop carries the path through a noisy minute (the Station B mechanism)", () => {
		// Three minutes. The middle minute's emission slightly prefers
		// B over A (delta of +0.5 for B). But the transition prior has
		// A→A at 0 (log-prob, i.e. probability 1) and A→B at -5 (very
		// unlikely). So Viterbi should pick A throughout — the
		// transition prior dominates the small emission preference.
		const path = viterbi({
			observations: [{ idx: 0 }, { idx: 1 }, { idx: 2 }],
			states: [A, B],
			transitionLogProb: (from, to) => {
				if (from.id === to.id) return 0; // self-loop free
				return -5; // switching is very expensive
			},
			emissionLogProb: (s, o) => {
				if ((o as { idx: number }).idx === 1) {
					// middle minute: B slightly preferred
					return s.id === "B" ? 0 : -0.5;
				}
				// edges: A strongly preferred
				return s.id === "A" ? 0 : -10;
			},
		});
		expect(path.map((s) => s.id)).toEqual(["A", "A", "A"]);
	});

	it("hard-zero transition forbids that state pair", () => {
		// Two minutes. Emission for minute 1 strongly prefers B. But
		// A → B is hard-zeroed (-Infinity). Viterbi must pick B for
		// minute 0 (so the path can stay in B for minute 1) even
		// though minute 0's emission slightly prefers A.
		const path = viterbi({
			observations: [{ idx: 0 }, { idx: 1 }],
			states: [A, B],
			transitionLogProb: (from, to) => {
				if (from.id === "A" && to.id === "B") return -Infinity;
				return 0;
			},
			emissionLogProb: (s, o) => {
				if ((o as { idx: number }).idx === 0) return s.id === "A" ? 0 : -0.3;
				return s.id === "B" ? 0 : -10;
			},
		});
		// Without the hard-zero, [A, B] would win (A slightly preferred
		// at idx 0, B strongly at idx 1). With it, must be [B, B].
		expect(path.map((s) => s.id)).toEqual(["B", "B"]);
	});

	it("handles -Infinity emission for unreachable states cleanly", () => {
		// A state with -Infinity emission can never be picked, even if
		// transitions are uniform. Should not produce NaN paths.
		const path = viterbi({
			observations: [{ idx: 0 }, { idx: 1 }],
			states: [A, B],
			transitionLogProb: () => 0,
			emissionLogProb: (s) => (s.id === "A" ? -Infinity : 0),
		});
		expect(path.map((s) => s.id)).toEqual(["B", "B"]);
	});

	it("breaks emission ties deterministically by state input order", () => {
		// Two states, identical scores everywhere. The MAP path should
		// be stable (same input → same output).
		const path = viterbi({
			observations: [{ idx: 0 }, { idx: 1 }],
			states: [A, B],
			transitionLogProb: () => 0,
			emissionLogProb: () => 0,
		});
		// First state (A) wins ties — stable, reproducible.
		expect(path.map((s) => s.id)).toEqual(["A", "A"]);
	});

	it("handles long sequences without log-space underflow", () => {
		// 1440 observations (one full day) with small but non-trivial
		// log-probs per step. Total log-prob is ~ -1440 × 0.5 = -720,
		// representing a probability of e^-720 which would underflow
		// to 0 in linear space. Log-space arithmetic must not produce
		// NaN or Infinity in the path.
		const N = 1440;
		const observations = Array.from({ length: N }, (_, idx) => ({ idx }));
		const path = viterbi({
			observations,
			states: [A, B],
			transitionLogProb: () => -0.1,
			emissionLogProb: (s, o) =>
				(o as { idx: number }).idx % 2 === 0 ? (s.id === "A" ? 0 : -0.5) : s.id === "B" ? 0 : -0.5,
		});
		expect(path.length).toBe(N);
		expect(path.every((s) => s.id === "A" || s.id === "B")).toBe(true);
	});
});
