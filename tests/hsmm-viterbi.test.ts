/**
 * `hsmm-viterbi` — explicit-duration HSMM MAP decoder.
 *
 * Tests pin:
 *   - Empty observations → empty path.
 *   - Single observation → highest-emission state.
 *   - Self-loop chain decoded correctly (3 same-state minutes →
 *     one segment).
 *   - Duration prior prevents short bridges: a state pair that
 *     would mode-thrash under per-minute Viterbi (A → B → A
 *     with a 1-minute B) gets collapsed into A → A → A when
 *     P_d(d=1 | B) is much lower than P_d(d=3 | A).
 *   - Hard-zero transitions blocked.
 *   - -Infinity emissions for unreachable states tolerated.
 *   - Long sequence (1440 obs) without underflow.
 *   - Initial-state prior shifts the t=0 choice.
 */

import { describe, expect, it } from "vitest";
import { hsmmViterbi } from "../src/hmm/hsmm-viterbi.js";

interface ToyState {
	id: string;
}

const A: ToyState = { id: "A" };
const B: ToyState = { id: "B" };

/** Uniform duration prior — every duration has the same log-prob.
 *  Lets the test isolate transition / emission effects. */
const uniformDuration = (): number => 0;

describe("hsmmViterbi", () => {
	it("returns empty path for empty observations", () => {
		const path = hsmmViterbi({
			observations: [],
			states: [A, B],
			transitionLogProb: () => 0,
			emissionLogProb: () => 0,
			durationLogProb: uniformDuration,
		});
		expect(path).toEqual([]);
	});

	it("single observation: picks the highest-emission state", () => {
		const path = hsmmViterbi({
			observations: [{ idx: 0 }],
			states: [A, B],
			transitionLogProb: () => 0,
			emissionLogProb: (s) => (s.id === "B" ? 0 : -10),
			durationLogProb: uniformDuration,
		});
		expect(path.map((s) => s.id)).toEqual(["B"]);
	});

	it("self-loop chain: 3 minutes of A → A,A,A as one segment", () => {
		const path = hsmmViterbi({
			observations: [{ idx: 0 }, { idx: 1 }, { idx: 2 }],
			states: [A, B],
			transitionLogProb: () => -10, // discourage switching
			emissionLogProb: (s) => (s.id === "A" ? 0 : -1),
			durationLogProb: uniformDuration,
		});
		expect(path.map((s) => s.id)).toEqual(["A", "A", "A"]);
	});

	it("duration prior prevents 1-minute B bridge: A,B,A → A,A,A when P_d(1|B) is low", () => {
		// Middle minute emission slightly favours B; per-minute Viterbi
		// would pick [A, B, A]. HSMM with strong P_d(1|B) penalty
		// should pick [A, A, A] — the B segment of duration 1 is
		// physically implausible.
		const path = hsmmViterbi({
			observations: [{ idx: 0 }, { idx: 1 }, { idx: 2 }],
			states: [A, B],
			transitionLogProb: () => 0,
			emissionLogProb: (s, o) => {
				if ((o as { idx: number }).idx === 1) return s.id === "B" ? 0 : -0.5;
				return s.id === "A" ? 0 : -10;
			},
			// B segments of duration 1 are very unlikely; longer ones
			// allowed. A is uniform.
			durationLogProb: (s, d) => {
				if (s.id === "B" && d === 1) return -20; // hard penalty
				return 0;
			},
		});
		expect(path.map((s) => s.id)).toEqual(["A", "A", "A"]);
	});

	it("respects long-duration prior — extends segments rather than bouncing", () => {
		// Two states emit equally. Duration prior strongly prefers
		// long A and long B (>= 2 min). The MAP path should not
		// alternate.
		const path = hsmmViterbi({
			observations: [{ idx: 0 }, { idx: 1 }, { idx: 2 }, { idx: 3 }],
			states: [A, B],
			transitionLogProb: () => 0,
			emissionLogProb: () => 0,
			durationLogProb: (_s, d) => (d >= 2 ? 0 : -20),
		});
		// With short-duration penalty, the path must use one or two
		// segments of length >= 2 (e.g. AAAA or AABB or AAAB cannot
		// happen with short-segment penalty).
		const ids = path.map((s) => s.id);
		expect(ids.length).toBe(4);
		// No length-1 runs allowed.
		let i = 0;
		while (i < ids.length) {
			let j = i;
			while (j < ids.length && ids[j] === ids[i]) j++;
			expect(j - i).toBeGreaterThanOrEqual(2);
			i = j;
		}
	});

	it("hard-zero transitions: forbidden A → B routes around", () => {
		const path = hsmmViterbi({
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
			durationLogProb: uniformDuration,
		});
		// Without the hard-zero [A, B] would win. With it, must be [B, B].
		expect(path.map((s) => s.id)).toEqual(["B", "B"]);
	});

	it("handles -Infinity emission for unreachable states cleanly", () => {
		const path = hsmmViterbi({
			observations: [{ idx: 0 }, { idx: 1 }],
			states: [A, B],
			transitionLogProb: () => 0,
			emissionLogProb: (s) => (s.id === "A" ? -Infinity : 0),
			durationLogProb: uniformDuration,
		});
		expect(path.map((s) => s.id)).toEqual(["B", "B"]);
	});

	it("handles long sequences without log-space underflow", () => {
		const N = 1440;
		const observations = Array.from({ length: N }, (_, idx) => ({ idx }));
		const path = hsmmViterbi({
			observations,
			states: [A, B],
			transitionLogProb: () => -0.1,
			emissionLogProb: (s, o) =>
				(o as { idx: number }).idx % 60 < 30 ? (s.id === "A" ? 0 : -0.5) : s.id === "B" ? 0 : -0.5,
			durationLogProb: uniformDuration,
		});
		expect(path.length).toBe(N);
		expect(path.every((s) => s.id === "A" || s.id === "B")).toBe(true);
	});

	it("initial-state prior breaks ties at t=0", () => {
		// Emissions identical for both states; without init prior,
		// deterministic tie-break picks first state (A). With init
		// prior favouring B, B wins at t=0 (and self-loops carry it).
		const pathDefault = hsmmViterbi({
			observations: [{ idx: 0 }, { idx: 1 }],
			states: [A, B],
			transitionLogProb: () => -10, // discourage switching
			emissionLogProb: () => 0,
			durationLogProb: uniformDuration,
		});
		const pathWithPrior = hsmmViterbi({
			observations: [{ idx: 0 }, { idx: 1 }],
			states: [A, B],
			transitionLogProb: () => -10,
			emissionLogProb: () => 0,
			durationLogProb: uniformDuration,
			initialLogProb: (s) => (s.id === "B" ? 5 : 0),
		});
		expect(pathDefault.map((s) => s.id)).toEqual(["A", "A"]);
		expect(pathWithPrior.map((s) => s.id)).toEqual(["B", "B"]);
	});
});
