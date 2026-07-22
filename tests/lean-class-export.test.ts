/**
 * The class-factorised duration export referee (`refereeDurationExport`).
 *
 * `quantizeModel`'s pass 2 does not re-derive every duration cell — after the
 * last partition split it fills only the class representatives and trusts pass
 * 1's fall-through (`cbb94f5`). The referee re-derives the whole tensor from the
 * float model with no reference to how the export was built. These tests build
 * a synthetic model whose duration deltas depend on `e` at (almost) every cell —
 * so the sparse budget blows and the class branch is taken — and factorise by a
 * two-valued state mode, so exactly two classes result. No bridge, no corpus.
 */

import { describe, expect, it } from "vitest";
import type { HsmmModel } from "../src/hmm/decode.js";
import { DEFAULT_MAX_DURATION } from "../src/hmm/hsmm-viterbi.js";
import { quantizeModel, refereeDurationExport } from "../src/hmm/lean-shadow-core.js";
import type { Observation } from "../src/hmm/observation.js";
import type { State } from "../src/hmm/state-space.js";

/** A state carrying only the mode its duration deltas factor by. */
interface SynthState {
	id: number;
	mode: 0 | 1;
}

const T = 260;
const S = 22;

/**
 * A model whose duration log-prob is a pure function of (mode, d, e): every
 * state of one mode has identical durations everywhere, so the partition is
 * exactly two classes. The linear `e` term makes nearly every cell deviate from
 * the REF_E baseline, overflowing the sparse budget into the class branch.
 * The other callbacks are finite constants — enough to quantise, irrelevant to
 * the duration referee.
 */
function synthModel(): HsmmModel {
	const states: SynthState[] = Array.from({ length: S }, (_, i) => ({ id: i, mode: (i % 2) as 0 | 1 }));
	const tensor: { ts: number }[] = Array.from({ length: T }, (_, t) => ({ ts: t * 60_000 }));
	const durationLogProb = (state: State, d: number, segEndIndex: number): number => {
		const mode = (state as unknown as SynthState).mode;
		return -0.002 * d - 0.0003 * (mode + 1) * segEndIndex;
	};
	return {
		tensor: tensor as unknown as readonly Observation[],
		states: states as unknown as readonly State[],
		transitionLogProb: () => -1,
		emissionLogProb: () => -1,
		initialLogProb: () => -1,
		entryLogProb: () => -1,
		durationLogProb,
	};
}

describe("refereeDurationExport", () => {
	it("takes the class branch and agrees with the export cell-for-cell", () => {
		const model = synthModel();
		const q = quantizeModel(model);
		// Guard the premise: if this ever falls into the sparse branch the test
		// would pass vacuously.
		expect(q.durClass).not.toBeNull();
		expect(q.durDelta?.length).toBe(2);

		const v = refereeDurationExport(model, q);
		expect(v.ok).toBe(true);
		expect(v.cellsChecked).toBe(T * S * DEFAULT_MAX_DURATION);
	});

	it("catches a corrupted delta row — the failure the pass-2 shortcut could hide", () => {
		const model = synthModel();
		const q = quantizeModel(model);
		expect(q.durDelta).not.toBeNull();
		// Poke a single cell in the LAST class's delta row: pass 2 filled this
		// from a representative and never re-checked the members against it.
		const cls = (q.durDelta?.length ?? 0) - 1;
		// Choose a late cell (after any plausible split) so it is one pass 2
		// took on trust.
		const d0 = DEFAULT_MAX_DURATION - 1;
		const e = T - 1;
		(q.durDelta as number[][][])[cls][d0][e] += 1;

		const v = refereeDurationExport(model, q);
		expect(v.ok).toBe(false);
		expect(v.message).toContain(`d=${d0 + 1} e=${e}`);
	});

	it("catches a corrupted baseline row before it can cancel out of the deltas", () => {
		const model = synthModel();
		const q = quantizeModel(model);
		(q.dur as number[][])[3][10] = (q.dur[3][10] ?? 0) + 1;

		const v = refereeDurationExport(model, q);
		expect(v.ok).toBe(false);
		expect(v.message).toContain("baseline row s=3");
	});

	it("is a no-op on a sparse export — the sparse overrides are already exhaustive", () => {
		// A duration that never depends on `e` stays in the sparse branch.
		const model = synthModel();
		const flat: HsmmModel = { ...model, durationLogProb: (_s, d) => -0.002 * d };
		const q = quantizeModel(flat);
		expect(q.durClass).toBeNull();

		const v = refereeDurationExport(flat, q);
		expect(v.ok).toBe(true);
		expect(v.cellsChecked).toBe(0);
	});
});
