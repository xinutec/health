/**
 * Lean-shadow core: quantise a production HSMM model to integer tensors,
 * decode them with BOTH the TS trellis and the verified Lean decoder
 * (`verified_cli`), and demand exact agreement — identical paths and best
 * scores, re-scored by an independent referee here.
 *
 * Shared by the corpus tool (`src/cli/lean-shadow.ts`) and the per-day
 * shadow in the decode-recent cron (`src/cli/decode-day.ts`).
 *
 * Quantisation is ×2²⁰ (exactly representable in doubles). Fidelity of the
 * quantised model to the float model is measured separately (per-minute
 * agreement of the two decodes + float-score delta) — rounding may
 * legitimately flip near-ties, so that half is a *metric*, not a gate.
 *
 * Export shapes (mirroring `lean/Main.lean`'s input contract):
 * - `emit`/`entry` per minute; `init`; `dur` baseline at `REF_E`.
 * - Transitions: base `S×S` matrix; if time-varying (chain context), the
 *   deviating `(from,to)` pairs get full per-`t` rows (`transOv`) — the
 *   deviation support is a pairs×minutes product, so pair-major rows are
 *   the compact encoding.
 * - Durations: sparse per-`segEnd` overrides (`durOverrides`) when few
 *   cells deviate from the baseline (the train-hop relaxation); with
 *   segment evidence on, ~98% of cells deviate but the delta pattern
 *   factorises by state class (displacement physics sees the state's
 *   mode, not its identity), exported as `durClass` + `durDelta`
 *   (class × d × e). The class partition is verified cell-by-cell during
 *   export — this module REFUSES shapes it cannot represent faithfully
 *   rather than shadowing a different model. `refereeDurationExport`
 *   re-checks that export independently (pass 2 trusts pass 1 for most
 *   cells; the referee trusts neither), gated by the corpus tool.
 */

import { spawnSync } from "node:child_process";
import type { HsmmModel } from "./decode.js";
import { DEFAULT_MAX_DURATION, hsmmViterbi } from "./hsmm-viterbi.js";
import type { Observation } from "./observation.js";
import type { State } from "./state-space.js";

export const SCALE = 2 ** 20;
const NEG = Number.NEGATIVE_INFINITY;
/** Reference segEnd for the duration baseline (midday; any valid window). */
export const REF_E = 720;
/** Sparse-override budget before switching to the class-factorised form. */
const SPARSE_CAP = 100_000;
/** Class-partition cap — more classes than this means the factorisation
 *  assumption is wrong; refuse rather than emit a bogus export. */
const CLASS_CAP = 64;

export type Q = number | null;

export function quantize(x: number): Q {
	if (x === NEG) return null;
	if (!Number.isFinite(x)) throw new Error(`non-finite score ${x}`);
	return Math.round(x * SCALE);
}

const sc = (v: Q): number => (v === null ? NEG : v);

export interface QuantProblem {
	T: number;
	S: number;
	maxD: number;
	emit: Q[][];
	trans: Q[][];
	transOv: [number, number, Q[]][];
	dur: Q[][];
	durOverrides: [number, number, number, Q][];
	durClass: number[] | null;
	durDelta: number[][][] | null;
	init: Q[];
	entry: Q[][];
}

/** Uniform accessors over whichever representation the export chose —
 *  used identically by the TS-quant decode and the referee. */
export function quantAccessors(q: QuantProblem): {
	transAt: (from: number, to: number, t: number) => number;
	durAt: (s: number, d: number, e: number) => number;
} {
	const ovIdx = new Map<number, Q[]>();
	for (const [from, to, rowV] of q.transOv) ovIdx.set(from * q.S + to, rowV);
	const transAt = (from: number, to: number, t: number): number => {
		const row = ovIdx.get(from * q.S + to);
		return row !== undefined ? sc(row[t]) : sc(q.trans[from][to]);
	};

	const ovKey = (s: number, d: number, e: number): number => (s * q.maxD + (d - 1)) * q.T + e;
	const sparse = new Map<number, Q>();
	for (const [s, d, e, v] of q.durOverrides) sparse.set(ovKey(s, d, e), v);
	const durAt = (s: number, d: number, e: number): number => {
		if (d < 1 || d > q.maxD) return NEG;
		if (q.durClass !== null && q.durDelta !== null) {
			const base = q.dur[s][d - 1];
			if (base === null) return NEG;
			return base + q.durDelta[q.durClass[s]][d - 1][e];
		}
		const o = sparse.get(ovKey(s, d, e));
		return o !== undefined ? sc(o) : sc(q.dur[s][d - 1]);
	};
	return { transAt, durAt };
}

/** Quantise the model into tensors, refusing shapes the export can't
 *  represent faithfully. */
export function quantizeModel(model: HsmmModel): QuantProblem {
	const T = model.tensor.length;
	const S = model.states.length;
	const maxD = DEFAULT_MAX_DURATION;
	const st = model.states;
	const obs = model.tensor;

	const emit = Array.from({ length: T }, (_, t) => st.map((s) => quantize(model.emissionLogProb(s, obs[t]))));
	const entry = Array.from({ length: T }, (_, t) => st.map((s) => quantize(model.entryLogProb(s, obs[t]))));
	const init = st.map((s) => quantize(model.initialLogProb(s)));

	// Transitions: base at t=0; cheap sampled scan for time-variance, and if
	// found, a full per-pair scan exporting rows for the deviating pairs.
	const trans = st.map((a) => st.map((b) => quantize(model.transitionLogProb(a, b, obs[0]))));
	let varying = false;
	outer: for (const t of [1, Math.floor(T / 3), Math.floor((2 * T) / 3), T - 1]) {
		for (let a = 0; a < S; a += 11) {
			for (let b = 0; b < S; b += 11) {
				if (quantize(model.transitionLogProb(st[a], st[b], obs[t])) !== trans[a][b]) {
					varying = true;
					break outer;
				}
			}
		}
	}
	const transOv: [number, number, Q[]][] = [];
	if (varying) {
		for (let a = 0; a < S; a++) {
			for (let b = 0; b < S; b++) {
				let dev = false;
				for (let t = 1; t < T; t++) {
					if (quantize(model.transitionLogProb(st[a], st[b], obs[t])) !== trans[a][b]) {
						dev = true;
						break;
					}
				}
				if (dev) {
					transOv.push([
						a,
						b,
						Array.from({ length: T }, (_, t) => quantize(model.transitionLogProb(st[a], st[b], obs[t]))),
					]);
				}
			}
		}
	}

	// Durations: baseline at REF_E. Small d is always scanned exhaustively
	// (the train-hop relaxation lives there); larger d is stride-sampled for
	// dependence first. If the sparse form blows its budget (segment
	// evidence makes ~every cell e-dependent), fall through to the
	// class-factorised form.
	const dur = st.map((s) => Array.from({ length: maxD }, (_, d0) => quantize(model.durationLogProb(s, d0 + 1, REF_E))));
	const durOverrides: [number, number, number, Q][] = [];
	let sparseOk = true;
	sparseScan: for (let si = 0; si < S; si++) {
		for (let d = 1; d <= maxD; d++) {
			const base = dur[si][d - 1];
			let dependent = d <= 3;
			if (!dependent) {
				for (let e = d - 1; e < T; e += 89) {
					if (quantize(model.durationLogProb(st[si], d, e)) !== base) {
						dependent = true;
						break;
					}
				}
			}
			if (!dependent) continue;
			for (let e = 0; e < T; e++) {
				const v = quantize(model.durationLogProb(st[si], d, e));
				if (v !== base) {
					durOverrides.push([si, d, e, v]);
					if (durOverrides.length > SPARSE_CAP) {
						sparseOk = false;
						break sparseScan;
					}
				}
			}
		}
	}
	if (sparseOk) {
		return { T, S, maxD, emit, trans, transOv, dur, durOverrides, durClass: null, durDelta: null, init, entry };
	}

	// Class-factorised durations. Partition states so that any two states in
	// one class have the identical delta `q(dur(s,d,e)) - q(dur(s,d,REF_E))`
	// at EVERY (d,e) — refined and verified over the full tensor (55M cells,
	// seconds), refusing if the factorisation doesn't hold compactly or the
	// -∞ pattern is e-dependent (a delta can't encode a finite↔-∞ flip).
	const deltaAt = (si: number, d: number, e: number): number => {
		const base = dur[si][d - 1];
		const v = quantize(model.durationLogProb(st[si], d, e));
		if (base === null && v === null) return 0;
		if (base === null || v === null) {
			throw new Error(`dur -∞ pattern is segEnd-dependent at s=${si} d=${d} e=${e} — export unsupported`);
		}
		return v - base;
	};
	// Pass 1 — refine the partition. Fast path per (d,e): every state's
	// delta matches its class representative's (int compares only); a
	// mismatch triggers the rare split-by-delta-value step.
	let classOf = new Array<number>(S).fill(0);
	let reps: number[] = [0];
	const deltas = new Array<number>(S);
	// Linear index ((d−1)·T + e) of the last cell that refined the partition,
	// or −1 if it never did. See pass 2 for what this licenses.
	let lastSplitCell = -1;
	let cell = -1;
	for (let d = 1; d <= maxD; d++) {
		for (let e = 0; e < T; e++) {
			cell++;
			for (let si = 0; si < S; si++) deltas[si] = deltaAt(si, d, e);
			let split = false;
			for (let si = 0; si < S; si++) {
				if (deltas[si] !== deltas[reps[classOf[si]]]) {
					split = true;
					break;
				}
			}
			if (!split) continue;
			lastSplitCell = cell;
			const remap = new Map<string, number>();
			const newClass = new Array<number>(S);
			const newReps: number[] = [];
			for (let si = 0; si < S; si++) {
				const key = `${classOf[si]}:${deltas[si]}`;
				let nc = remap.get(key);
				if (nc === undefined) {
					nc = newReps.length;
					newReps.push(si);
					remap.set(key, nc);
				}
				newClass[si] = nc;
			}
			if (newReps.length > CLASS_CAP) {
				throw new Error(`dur delta needs >${CLASS_CAP} state classes at d=${d} e=${e} — export unsupported`);
			}
			classOf = newClass;
			reps = newReps;
		}
	}
	// Pass 2 — fill per-class delta rows from the representatives and verify
	// every state against its class.
	//
	// Pass 1's `!split` test IS the class verification: at every cell it fell
	// through, it had just compared all S states against their class
	// representative. For cells after `lastSplitCell` the partition it
	// compared under never changed again, so it was the final partition —
	// those cells are already verified and re-deriving all S deltas here
	// would only repeat the same comparison. They need the representatives'
	// values and nothing more (reps.length is ≤ CLASS_CAP and measured at 7–8
	// across the corpus, against S ≈ 150). Cells at or before
	// `lastSplitCell` were checked against a coarser partition, so those are
	// re-verified in full, exactly as before.
	const durDelta: number[][][] = Array.from({ length: reps.length }, () =>
		Array.from({ length: maxD }, () => new Array<number>(T).fill(0)),
	);
	cell = -1;
	for (let d = 1; d <= maxD; d++) {
		for (let e = 0; e < T; e++) {
			cell++;
			if (cell > lastSplitCell) {
				for (let c = 0; c < reps.length; c++) durDelta[c][d - 1][e] = deltaAt(reps[c], d, e);
				continue;
			}
			for (let si = 0; si < S; si++) deltas[si] = deltaAt(si, d, e);
			for (let c = 0; c < reps.length; c++) durDelta[c][d - 1][e] = deltas[reps[c]];
			for (let si = 0; si < S; si++) {
				if (deltas[si] !== durDelta[classOf[si]][d - 1][e]) {
					throw new Error(`dur class verification failed at s=${si} d=${d} e=${e} — export unsupported`);
				}
			}
		}
	}
	return { T, S, maxD, emit, trans, transOv, dur, durOverrides: [], durClass: classOf, durDelta, init, entry };
}

/** Verdict from the class-factorised duration export referee. */
export interface DurationExportVerdict {
	ok: boolean;
	/** Cells the referee re-derived and compared (0 = branch not exercised). */
	cellsChecked: number;
	message: string;
}

/**
 * Independent referee for the class-factorised duration export.
 *
 * `quantizeModel`'s pass 2 does NOT re-derive every cell: for cells after the
 * last partition split it fills only the class representatives' deltas and
 * trusts pass 1's `!split` fall-through as the per-state verification
 * (`cbb94f5`). That optimisation has no other gate — `shadowHsmmDay` decodes
 * the *exported* tensor two ways and demands they agree, but both decoders read
 * the same `durDelta`, so an export that misrepresents the float model would
 * pass silently as long as it misrepresents it identically to both.
 *
 * This closes that gap the way `scoreQuant` referees the decoder: re-derive the
 * baseline row and every `(s,d,e)` delta straight from the float model — with
 * no reference to how the export was built — and demand
 * `durDelta[class[s]][d][e]` equals it for every state. A no-op (cellsChecked 0)
 * when the sparse branch was taken; the sparse overrides are already an
 * exhaustive per-cell list, so they carry no equivalent trust.
 */
export function refereeDurationExport(model: HsmmModel, q: QuantProblem): DurationExportVerdict {
	if (q.durClass === null || q.durDelta === null) {
		return { ok: true, cellsChecked: 0, message: "sparse branch — no class export to referee" };
	}
	const { T, S, maxD, durClass, durDelta } = q;
	const st = model.states;
	// Re-derive the baseline row independently rather than trust `q.dur`: a wrong
	// baseline would otherwise cancel out of every delta below.
	const refDur = st.map((s) =>
		Array.from({ length: maxD }, (_, d0) => quantize(model.durationLogProb(s, d0 + 1, REF_E))),
	);
	for (let si = 0; si < S; si++) {
		for (let d0 = 0; d0 < maxD; d0++) {
			if (q.dur[si][d0] !== refDur[si][d0]) {
				return {
					ok: false,
					cellsChecked: 0,
					message: `baseline row s=${si} d=${d0 + 1}: referee ${refDur[si][d0]} ≠ export ${q.dur[si][d0]}`,
				};
			}
		}
	}
	const deltaAt = (si: number, d: number, e: number): number => {
		const base = refDur[si][d - 1];
		const v = quantize(model.durationLogProb(st[si], d, e));
		if (base === null && v === null) return 0;
		// A finite↔−∞ flip a scalar delta cannot encode — the export should have
		// refused it. NaN never equals the exported integer, so this fails.
		if (base === null || v === null) return Number.NaN;
		return v - base;
	};
	for (let d = 1; d <= maxD; d++) {
		for (let e = 0; e < T; e++) {
			for (let si = 0; si < S; si++) {
				const want = deltaAt(si, d, e);
				const got = durDelta[durClass[si]][d - 1][e];
				if (want !== got) {
					return {
						ok: false,
						cellsChecked: (d - 1) * T * S + e * S + si,
						message: `delta s=${si} d=${d} e=${e}: referee ${want} ≠ export ${got}`,
					};
				}
			}
		}
	}
	return {
		ok: true,
		cellsChecked: T * S * maxD,
		message: `all ${T * S * maxD} cells agree, classes=${durDelta.length}`,
	};
}

/** Independent referee: score a per-minute path under the quantised model. */
export function scoreQuant(q: QuantProblem, pathStates: readonly number[]): number {
	if (pathStates.length !== q.T) return NEG;
	const { transAt, durAt } = quantAccessors(q);
	let total = 0;
	let i = 0;
	let prev: number | null = null;
	while (i < q.T) {
		let j = i;
		while (j + 1 < q.T && pathStates[j + 1] === pathStates[i]) j++;
		const s = pathStates[i];
		const d = j - i + 1;
		total += prev === null ? sc(q.init[s]) : transAt(prev, s, i);
		total += sc(q.entry[i][s]);
		for (let t = i; t <= j; t++) total += sc(q.emit[t][s]);
		total += durAt(s, d, j);
		prev = s;
		i = j + 1;
	}
	return total;
}

/** Float referee: score a per-minute path under the real model callbacks. */
export function scoreFloat(model: HsmmModel, pathStates: readonly number[]): number {
	const T = model.tensor.length;
	if (pathStates.length !== T) return NEG;
	let total = 0;
	let i = 0;
	let prev: State | null = null;
	while (i < T) {
		let j = i;
		while (j + 1 < T && pathStates[j + 1] === pathStates[i]) j++;
		const s = model.states[pathStates[i]];
		total += prev === null ? model.initialLogProb(s) : model.transitionLogProb(prev, s, model.tensor[i]);
		total += model.entryLogProb(s, model.tensor[i]);
		for (let t = i; t <= j; t++) total += model.emissionLogProb(s, model.tensor[t]);
		total += model.durationLogProb(s, j - i + 1, j);
		prev = s;
		i = j + 1;
	}
	return total;
}

/** Decode the quantised problem with the TS trellis (integer scores are
 *  exact in doubles, so this is the trellis on the very tensors Lean sees). */
export function decodeTsQuant(q: QuantProblem): number[] {
	const { transAt, durAt } = quantAccessors(q);
	return hsmmViterbi<number, number>({
		observations: Array.from({ length: q.T }, (_, t) => t),
		states: Array.from({ length: q.S }, (_, s) => s),
		transitionLogProb: (from, to, t) => transAt(from, to, t),
		emissionLogProb: (state, t) => sc(q.emit[t][state]),
		durationLogProb: (state, d, segEnd) => durAt(state, d, segEnd),
		initialLogProb: (state) => sc(q.init[state]),
		entryLogProb: (state, t) => sc(q.entry[t][state]),
		maxDurationMinutes: q.maxD,
	});
}

/**
 * Run-length encode each innermost row of the class-factorised duration delta
 * tensor over `e`: `[class][d][e]` (T values per row) becomes `[class][d][run]`
 * of `[value, runLength]`. The rows are piecewise-constant over `e` (~10%
 * distinct runs on real days), so this shrinks the JSON payload — and, the
 * point, Lean's parse of it, which was ~2.2s of the day-scale decode dominated
 * by this tensor. The Lean parser expands it back to the identical flat tensor
 * before decoding; the verified decoder is untouched.
 */
export function rleDurDelta(durDelta: readonly number[][][]): [number, number][][][] {
	return durDelta.map((cls) =>
		cls.map((row) => {
			const runs: [number, number][] = [];
			for (const v of row) {
				const last = runs[runs.length - 1];
				if (last !== undefined && last[0] === v) last[1]++;
				else runs.push([v, 1]);
			}
			return runs;
		}),
	);
}

export function decodeLean(
	leanBin: string,
	q: QuantProblem,
): { path?: number[]; best?: number; degenerate?: boolean; error?: string } {
	const payload: Record<string, unknown> = {
		T: q.T,
		S: q.S,
		maxD: q.maxD,
		emit: q.emit,
		trans: q.trans,
		dur: q.dur,
		init: q.init,
		entry: q.entry,
	};
	if (q.durOverrides.length > 0) payload.durOverrides = q.durOverrides;
	if (q.transOv.length > 0) payload.transOv = q.transOv;
	if (q.durClass !== null && q.durDelta !== null) {
		payload.durClass = q.durClass;
		payload.durDelta = rleDurDelta(q.durDelta);
	}
	const res = spawnSync(leanBin, [], {
		input: JSON.stringify(payload),
		encoding: "utf8",
		maxBuffer: 1 << 28,
	});
	if (res.status !== 0) throw new Error(`verified_cli failed: ${res.stderr || res.stdout}`);
	return JSON.parse(res.stdout);
}

/** Decode with the float model — the production trellis path. */
export function decodeTsFloat(model: HsmmModel): number[] {
	const stateIndex = new Map<State, number>(model.states.map((s, i) => [s, i]));
	const decoded = hsmmViterbi<State, Observation>({
		observations: model.tensor,
		states: model.states,
		transitionLogProb: model.transitionLogProb,
		emissionLogProb: model.emissionLogProb,
		initialLogProb: model.initialLogProb,
		entryLogProb: model.entryLogProb,
		durationLogProb: model.durationLogProb,
	});
	return decoded.map((s) => stateIndex.get(s) as number);
}

export interface ShadowReport {
	/** lean↔tsQuant verdict — "EXACT", "ok (degenerate)", or "MISMATCH: …". */
	verdict: string;
	exact: boolean;
	/** float↔quant fidelity: minutes agreeing and float-score delta. */
	agreeMinutes: number;
	totalMinutes: number;
	scoreDelta: number;
	/** Export shape summary for the log line. */
	shape: string;
	quantiseMs: number;
	tsMs: number;
	leanMs: number;
	/** Class-export referee verdict — present only when requested (it costs a
	 *  full 55M-cell re-derivation, so the daily cron shadow omits it). */
	durationExport?: DurationExportVerdict;
}

/** Run the full A/B for one day's model. Throws only on export refusal or a
 *  crashed CLI — a wrong decode is reported, not thrown. When
 *  `opts.refereeDurations` is set, also re-derives the class-factorised
 *  duration export cell-by-cell (a no-op on sparse days) — the corpus tool
 *  turns this on; the per-day cron leaves it off to avoid the extra pass. */
export function shadowHsmmDay(
	model: HsmmModel,
	leanBin: string,
	opts: { refereeDurations?: boolean } = {},
): ShadowReport {
	const t0 = performance.now();
	const q = quantizeModel(model);
	const t1 = performance.now();
	const tsqPath = decodeTsQuant(q);
	const t2 = performance.now();
	const lean = decodeLean(leanBin, q);
	const t3 = performance.now();

	const tsqScore = scoreQuant(q, tsqPath);
	let verdict: string;
	if (lean.error !== undefined) {
		verdict = `MISMATCH: lean error: ${lean.error}`;
	} else if (lean.degenerate === true) {
		verdict = tsqScore === NEG ? "ok (degenerate)" : "MISMATCH: lean degenerate, TS finite";
	} else if (lean.path === undefined || lean.best === undefined) {
		verdict = "MISMATCH: lean returned no path";
	} else {
		const samePath = lean.path.length === tsqPath.length && tsqPath.every((s, i) => s === lean.path?.[i]);
		const leanScore = scoreQuant(q, lean.path);
		if (!samePath) verdict = "MISMATCH: paths differ";
		else if (leanScore !== lean.best) verdict = `MISMATCH: lean best ${lean.best} ≠ referee ${leanScore}`;
		else if (tsqScore !== lean.best) verdict = `MISMATCH: TS score ${tsqScore} ≠ lean best ${lean.best}`;
		else verdict = "EXACT";
	}

	const floatPath = decodeTsFloat(model);
	const agree = floatPath.filter((s, i) => s === tsqPath[i]).length;
	const delta = scoreFloat(model, tsqPath) - scoreFloat(model, floatPath);

	const shape =
		`S=${q.S}` +
		(q.transOv.length > 0 ? ` transOv=${q.transOv.length}` : "") +
		(q.durClass !== null ? ` durClasses=${q.durDelta?.length}` : ` ov=${q.durOverrides.length}`);
	return {
		verdict,
		exact: !verdict.startsWith("MISMATCH"),
		agreeMinutes: agree,
		totalMinutes: q.T,
		scoreDelta: delta,
		shape,
		quantiseMs: t1 - t0,
		tsMs: t2 - t1,
		leanMs: t3 - t2,
		durationExport: opts.refereeDurations === true ? refereeDurationExport(model, q) : undefined,
	};
}
