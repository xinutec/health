import { describe, expect, it } from "vitest";
import type { Observation } from "../src/hmm/observation.js";
import type { State } from "../src/hmm/state-space.js";
import type { TrainCandidate } from "../src/hmm/train-candidate-generator.js";
import { buildTrainEntryFromCandidates } from "../src/hmm/train-generator-prior.js";

/**
 * `buildTrainEntryFromCandidates` turns structural `(board, line, alight)`
 * candidates into a per-segment entry prior over `train @ L` states plus an
 * `isCovered` coverage predicate. These tests pin the decision table without
 * a synthetic route graph — they feed candidates directly.
 *
 * Magnitudes are the module constants `VALID_LINE_BOOST = 3` /
 * `INVALID_LINE_PENALTY = 8` (asserted by sign + magnitude, not re-derived).
 */

function train(lineName: string | null): State {
	return { mode: "train", placeId: null, lineName, trainEdgeId: null };
}

function obs(ts: number, over: Partial<Observation> = {}): Observation {
	return {
		ts,
		gps: null,
		hr: null,
		cadence: null,
		hourLocal: 12,
		dayOfWeekLocal: 1,
		inBed: false,
		prevGpsFix: null,
		nextGpsFix: null,
		...over,
	};
}

/** Contiguous minute tensor: ts = base + index*60, so `startMin`/`endMin`
 *  indices line up with `observations[m].ts`. */
const BASE_TS = 1_700_000_000;
function tensor(n: number): Observation[] {
	return Array.from({ length: n }, (_unused, i) => obs(BASE_TS + i * 60));
}

/** Indexed access that narrows away `undefined` — keeps the assertions
 *  readable without non-null bangs. */
function at(obsv: readonly Observation[], i: number): Observation {
	const o = obsv[i];
	if (o === undefined) throw new Error(`no observation at index ${i}`);
	return o;
}

function candidate(over: Partial<TrainCandidate>): TrainCandidate {
	return {
		startMin: 0,
		endMin: 0,
		line: "Jubilee Line",
		boardStationId: "board",
		alightStationId: "alight",
		...over,
	};
}

describe("buildTrainEntryFromCandidates", () => {
	it("returns 0 for non-train states", () => {
		const obsv = tensor(10);
		const { entry } = buildTrainEntryFromCandidates([candidate({ startMin: 2, endMin: 5 })], obsv);
		const stationary: State = { mode: "stationary", placeId: 1, lineName: null, trainEdgeId: null };
		expect(entry(stationary, at(obsv, 3))).toBe(0);
	});

	it("boosts a structurally valid line on a covered minute", () => {
		const obsv = tensor(10);
		const { entry } = buildTrainEntryFromCandidates(
			[candidate({ startMin: 2, endMin: 5, line: "Jubilee Line" })],
			obsv,
		);
		expect(entry(train("Jubilee Line"), at(obsv, 3))).toBeGreaterThan(0);
	});

	it("penalises a structurally invalid line on a covered minute", () => {
		const obsv = tensor(10);
		const { entry } = buildTrainEntryFromCandidates(
			[candidate({ startMin: 2, endMin: 5, line: "Jubilee Line" })],
			obsv,
		);
		const score = entry(train("Metropolitan Line"), at(obsv, 3));
		expect(score).toBeLessThan(0);
		// Penalty must outweigh the boost so a valid line wins within train.
		expect(Math.abs(score)).toBeGreaterThan(entry(train("Jubilee Line"), at(obsv, 3)));
	});

	it("never penalises unknown_rail (the graceful-degradation fallback)", () => {
		const obsv = tensor(10);
		const { entry } = buildTrainEntryFromCandidates(
			[candidate({ startMin: 2, endMin: 5, line: "Jubilee Line" })],
			obsv,
		);
		expect(entry(train("unknown_rail"), at(obsv, 3))).toBe(0);
		expect(entry(train(null), at(obsv, 3))).toBe(0);
	});

	it("is silent (0) on a minute no candidate covers", () => {
		const obsv = tensor(10);
		const { entry, isCovered } = buildTrainEntryFromCandidates(
			[candidate({ startMin: 2, endMin: 5, line: "Jubilee Line" })],
			obsv,
		);
		expect(isCovered(at(obsv, 8).ts)).toBe(false);
		expect(entry(train("Metropolitan Line"), at(obsv, 8))).toBe(0);
		expect(entry(train("Jubilee Line"), at(obsv, 8))).toBe(0);
	});

	it("reports coverage exactly over the candidate window", () => {
		const obsv = tensor(10);
		const { isCovered } = buildTrainEntryFromCandidates(
			[candidate({ startMin: 2, endMin: 5, line: "Jubilee Line" })],
			obsv,
		);
		expect(isCovered(at(obsv, 1).ts)).toBe(false);
		expect(isCovered(at(obsv, 2).ts)).toBe(true);
		expect(isCovered(at(obsv, 5).ts)).toBe(true);
		expect(isCovered(at(obsv, 6).ts)).toBe(false);
	});

	it("blesses every line offered for the SAME window (multiple board/alight pairs)", () => {
		const obsv = tensor(10);
		// Two candidates over the same window on different lines (an
		// interchange-ambiguous stretch where both are structurally valid).
		const { entry } = buildTrainEntryFromCandidates(
			[
				candidate({ startMin: 2, endMin: 5, line: "Jubilee Line" }),
				candidate({ startMin: 2, endMin: 5, line: "Carfaxloo Line" }),
			],
			obsv,
		);
		expect(entry(train("Jubilee Line"), at(obsv, 3))).toBeGreaterThan(0);
		expect(entry(train("Carfaxloo Line"), at(obsv, 3))).toBeGreaterThan(0);
		// A third line not offered for the window is still penalised.
		expect(entry(train("Victoria Line"), at(obsv, 3))).toBeLessThan(0);
	});

	it("uses per-window line sets — never unions across disjoint windows", () => {
		const obsv = tensor(20);
		// Window A (Jubilee) at 2-5, window B (Metropolitan) at 12-15.
		const { entry } = buildTrainEntryFromCandidates(
			[
				candidate({ startMin: 2, endMin: 5, line: "Jubilee Line" }),
				candidate({ startMin: 12, endMin: 15, line: "Metropolitan Line" }),
			],
			obsv,
		);
		// In window A, Metropolitan is NOT valid (belongs to window B only).
		expect(entry(train("Metropolitan Line"), at(obsv, 3))).toBeLessThan(0);
		expect(entry(train("Jubilee Line"), at(obsv, 3))).toBeGreaterThan(0);
		// In window B, the reverse.
		expect(entry(train("Jubilee Line"), at(obsv, 13))).toBeLessThan(0);
		expect(entry(train("Metropolitan Line"), at(obsv, 13))).toBeGreaterThan(0);
	});
});
