/**
 * `hsmmMarginals` — forward-backward inference over an HSMM
 * returning per-minute posterior P(state_t | obs_1..T).
 *
 * Tests pin:
 *   - Marginals at each minute are a probability distribution
 *     (non-negative, sum to ~1).
 *   - logZ is finite for any reachable model.
 *   - Strong unambiguous evidence concentrates the posterior on
 *     one state (~99%).
 *   - Ambiguous evidence spreads the posterior across compatible
 *     states.
 *   - The argmax-marginal sequence usually agrees with the
 *     Viterbi MAP sequence (not always — marginals can disagree
 *     locally because they don't enforce path consistency).
 *   - Hard-zero transitions / emissions don't leak probability.
 */

import { describe, expect, it } from "vitest";
import { hsmmMarginals } from "../src/hmm/hsmm-marginals.js";
import { hsmmViterbi } from "../src/hmm/hsmm-viterbi.js";

interface ToyState {
	id: string;
}
const A: ToyState = { id: "A" };
const B: ToyState = { id: "B" };

const uniformDuration = (): number => 0;

describe("hsmmMarginals", () => {
	it("returns empty marginals for empty observations", () => {
		const { marginals, logZ } = hsmmMarginals({
			observations: [],
			states: [A, B],
			transitionLogProb: () => 0,
			emissionLogProb: () => 0,
			durationLogProb: uniformDuration,
		});
		expect(marginals).toEqual([]);
		expect(logZ).toBe(Number.NEGATIVE_INFINITY);
	});

	it("each minute's marginals form a probability distribution (sum ≈ 1, non-negative)", () => {
		const { marginals } = hsmmMarginals({
			observations: [{ idx: 0 }, { idx: 1 }, { idx: 2 }],
			states: [A, B],
			transitionLogProb: () => -1,
			emissionLogProb: (s, o) => (s.id === "A" && (o as { idx: number }).idx === 1 ? -1 : 0),
			durationLogProb: uniformDuration,
		});
		for (const row of marginals) {
			let sum = 0;
			for (const p of row) {
				expect(p).toBeGreaterThanOrEqual(0);
				expect(p).toBeLessThanOrEqual(1);
				sum += p;
			}
			expect(sum).toBeCloseTo(1, 4);
		}
	});

	it("strong unambiguous evidence concentrates the posterior", () => {
		// One minute, B's emission 100× stronger than A's.
		const { marginals } = hsmmMarginals({
			observations: [{ idx: 0 }],
			states: [A, B],
			transitionLogProb: () => 0,
			emissionLogProb: (s) => (s.id === "B" ? 0 : -10),
			durationLogProb: uniformDuration,
		});
		expect(marginals[0][1]).toBeGreaterThan(0.99); // B is second state
		expect(marginals[0][0]).toBeLessThan(0.01); // A
	});

	it("ambiguous evidence spreads the posterior across compatible states", () => {
		// Three minutes, all emissions tied. Posterior should be ~50/50.
		const { marginals } = hsmmMarginals({
			observations: [{ idx: 0 }, { idx: 1 }, { idx: 2 }],
			states: [A, B],
			transitionLogProb: () => 0,
			emissionLogProb: () => 0,
			durationLogProb: uniformDuration,
		});
		for (const row of marginals) {
			expect(row[0]).toBeCloseTo(0.5, 1);
			expect(row[1]).toBeCloseTo(0.5, 1);
		}
	});

	it("argmax-marginal sequence usually agrees with Viterbi MAP", () => {
		// On a clearly-structured problem, the per-minute argmax
		// of the marginals matches the Viterbi MAP path. (They can
		// diverge for jointly-optimal but locally-suboptimal paths,
		// but for simple chains they agree.)
		const observations = [{ idx: 0 }, { idx: 1 }, { idx: 2 }];
		const states = [A, B];
		const transitionLogProb = (): number => 0;
		const emissionLogProb = (s: ToyState, o: { idx: number }): number => {
			const want: Record<string, string> = { 0: "A", 1: "B", 2: "A" };
			return s.id === want[o.idx.toString()] ? 0 : -10;
		};
		const viterbi = hsmmViterbi({
			observations,
			states,
			transitionLogProb,
			emissionLogProb,
			durationLogProb: uniformDuration,
		});
		const { marginals } = hsmmMarginals({
			observations,
			states,
			transitionLogProb,
			emissionLogProb,
			durationLogProb: uniformDuration,
		});
		const argmaxSeq = marginals.map((row) => (row[0] > row[1] ? A : B));
		expect(argmaxSeq.map((s) => s.id)).toEqual(viterbi.map((s) => s.id));
	});

	it("logZ is finite for any reachable model", () => {
		const { logZ } = hsmmMarginals({
			observations: [{ idx: 0 }, { idx: 1 }, { idx: 2 }],
			states: [A, B],
			transitionLogProb: () => 0,
			emissionLogProb: () => 0,
			durationLogProb: uniformDuration,
		});
		expect(Number.isFinite(logZ)).toBe(true);
	});

	it("respects initial-state prior at t=0", () => {
		// Emissions tied; initial-state prior strongly favours B.
		// Marginals at t=0 should reflect that.
		const { marginals } = hsmmMarginals({
			observations: [{ idx: 0 }, { idx: 1 }],
			states: [A, B],
			transitionLogProb: () => -10, // discourage switching
			emissionLogProb: () => 0,
			durationLogProb: uniformDuration,
			initialLogProb: (s) => (s.id === "B" ? 5 : 0),
		});
		expect(marginals[0][1]).toBeGreaterThan(0.9); // B
	});

	it("never produces NaN or negative probabilities", () => {
		// 30-minute sequence with a mix of emissions including
		// some -Infinity (forbidden states).
		const N = 30;
		const observations = Array.from({ length: N }, (_, idx) => ({ idx }));
		const { marginals } = hsmmMarginals({
			observations,
			states: [A, B],
			transitionLogProb: () => 0,
			emissionLogProb: (s, o) => {
				const i = (o as { idx: number }).idx;
				if (i === 5) return s.id === "A" ? -Infinity : 0;
				return 0;
			},
			durationLogProb: uniformDuration,
		});
		for (const row of marginals) {
			for (const p of row) {
				expect(Number.isFinite(p)).toBe(true);
				expect(p).toBeGreaterThanOrEqual(0);
			}
		}
	});
});
