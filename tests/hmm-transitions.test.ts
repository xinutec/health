/**
 * `buildTransitionMatrix` — rule-based static-prior transition log-
 * probabilities for the MVP HMM.
 *
 * Calibration intent (not learned from data — MVP stub):
 *   - Self-loops dominate (~ log 0.95); the HMM should stay in a
 *     state minute-to-minute most of the time.
 *   - Mode changes (e.g. stationary → walking) get a moderate
 *     prior (~ log 0.01) — common but rare per minute.
 *   - Mode-plus-place transitions (stationary @ A → train @ L) are
 *     similar.
 *   - Two different stationary places without a moving intermediate
 *     are physically impossible: hard-zeroed.
 *
 * The station-graph hard-zero ("train@L cannot serve place P far from
 * any station on L") is wired in at integration time, not here.
 * Tests here pin the structural rules only.
 */

import { describe, expect, it } from "vitest";
import { buildStateSpace } from "../src/hmm/state-space.js";
import { buildTransitionMatrix } from "../src/hmm/transitions.js";

describe("buildTransitionMatrix", () => {
	const states = buildStateSpace({
		focusPlaces: [
			{ id: 1, displayName: "Home" },
			{ id: 2, displayName: "Work" },
		],
		knownLines: ["Metropolitan Line"],
	});
	const transitionLogProb = buildTransitionMatrix({ states });

	function find(mode: string, placeId: number | null, lineName: string | null) {
		const s = states.find((s) => s.mode === mode && s.placeId === placeId && s.lineName === lineName);
		if (s === undefined) throw new Error(`state not found: ${mode}|${placeId}|${lineName}`);
		return s;
	}

	it("self-loops have higher log-prob than any cross-state transition", () => {
		const home = find("stationary", 1, null);
		const walking = find("walking", null, null);
		const self = transitionLogProb(home, home);
		const cross = transitionLogProb(home, walking);
		expect(self).toBeGreaterThan(cross);
		expect(self).toBeCloseTo(Math.log(0.95), 2);
	});

	it("hard-zeroes direct stationary@A → stationary@B transitions", () => {
		const home = find("stationary", 1, null);
		const work = find("stationary", 2, null);
		expect(transitionLogProb(home, work)).toBe(Number.NEGATIVE_INFINITY);
		expect(transitionLogProb(work, home)).toBe(Number.NEGATIVE_INFINITY);
	});

	it("permits stationary @ A → walking → stationary @ B via the walking transition", () => {
		const home = find("stationary", 1, null);
		const walking = find("walking", null, null);
		const work = find("stationary", 2, null);
		expect(transitionLogProb(home, walking)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
		expect(transitionLogProb(walking, work)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
	});

	it("permits off-network stationary regardless of source", () => {
		// stationary @ none → stationary @ none is allowed (self-loop).
		// stationary @ A → stationary @ none is NOT allowed (mode change without movement).
		const noneStay = find("stationary", null, null);
		const home = find("stationary", 1, null);
		expect(transitionLogProb(noneStay, noneStay)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
		expect(transitionLogProb(home, noneStay)).toBe(Number.NEGATIVE_INFINITY);
	});

	it("treats unknown as a regular non-place mode (allows entry/exit)", () => {
		const unknown = find("unknown", null, null);
		const walking = find("walking", null, null);
		const home = find("stationary", 1, null);
		// unknown can transition to/from walking, stationary, etc.
		expect(transitionLogProb(unknown, walking)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
		expect(transitionLogProb(walking, unknown)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
		expect(transitionLogProb(home, unknown)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
	});

	it("permits train @ L → walking (alighting)", () => {
		const train = find("train", null, "Metropolitan Line");
		const walking = find("walking", null, null);
		expect(transitionLogProb(train, walking)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
	});

	it("permits walking → train @ L (boarding)", () => {
		const walking = find("walking", null, null);
		const train = find("train", null, "Metropolitan Line");
		expect(transitionLogProb(walking, train)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
	});

	it("permits stationary @ A → train @ L (boarding at a station-cluster place)", () => {
		const home = find("stationary", 1, null);
		const train = find("train", null, "Metropolitan Line");
		// Static prior allows it — station-graph hard-zero (wired at
		// integration) will refine this for specific (L, place) pairs.
		expect(transitionLogProb(home, train)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
	});

	it("hard-zeroes train@L → stationary@P when L does not serve P (station-graph rule)", () => {
		const transitionLogProbWithGraph = buildTransitionMatrix({
			states,
			// Home (id=1) is on Met; Work (id=2) is NOT.
			placeNearLine: (placeId, lineName) => placeId === 1 && lineName === "Metropolitan Line",
		});
		const train = find("train", null, "Metropolitan Line");
		const home = find("stationary", 1, null);
		const work = find("stationary", 2, null);
		// train@Met → stationary@Home: allowed (home is on Met).
		expect(transitionLogProbWithGraph(train, home)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
		// train@Met → stationary@Work: forbidden (work is not on Met).
		expect(transitionLogProbWithGraph(train, work)).toBe(Number.NEGATIVE_INFINITY);
		// Symmetric: stationary@Work → train@Met also forbidden.
		expect(transitionLogProbWithGraph(work, train)).toBe(Number.NEGATIVE_INFINITY);
	});

	it("does not apply station-graph hard-zero for the unknown_rail catch-all", () => {
		const transitionLogProbWithGraph = buildTransitionMatrix({
			states,
			placeNearLine: () => false, // everything would be forbidden if applied
		});
		const unknownTrain = find("train", null, "unknown_rail");
		const home = find("stationary", 1, null);
		// unknown_rail bypasses the rule — used as a backstop when
		// the line isn't recognised.
		expect(transitionLogProbWithGraph(unknownTrain, home)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
	});

	it("penalises a direct vehicle→vehicle transition vs routing through walking", () => {
		const train = find("train", null, "Metropolitan Line");
		const driving = find("driving", null, null);
		const walking = find("walking", null, null);
		// train → driving directly is finite (not a hard zero — a sub-minute
		// interchange can be unobserved) but much cheaper to route through a
		// non-vehicle state: train → walking → driving.
		const direct = transitionLogProb(train, driving);
		const viaWalk = transitionLogProb(train, walking) + transitionLogProb(walking, driving);
		expect(direct).toBeGreaterThan(Number.NEGATIVE_INFINITY);
		expect(direct).toBeLessThan(viaWalk);
		// And the inter-vehicle pair is steeply below an ordinary cross-state
		// transition out of the same source (train → walking).
		expect(transitionLogProb(train, walking) - direct).toBeGreaterThan(5);
	});

	it("rows sum to <= 1 in probability space (proper probability distribution)", () => {
		// For each state, summing exp(logProb(state, *)) over all
		// destinations should be ≤ 1 (could be < 1 because hard-zeros
		// remove mass; the remaining mass is what the matrix actually
		// assigns).
		for (const from of states) {
			let sum = 0;
			for (const to of states) {
				const lp = transitionLogProb(from, to);
				if (lp === Number.NEGATIVE_INFINITY) continue;
				sum += Math.exp(lp);
			}
			expect(sum).toBeGreaterThan(0); // every state has at least one valid outgoing transition
			expect(sum).toBeLessThanOrEqual(1.01); // floating-point slop
		}
	});
});
