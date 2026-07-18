/**
 * CLI: Lean-shadow A/B — the verified decoder on real captured days.
 *
 * Phase V2 of `docs/proposals/2026-07-verified-core-lean.md`: for each
 * fixture under tests/golden/decoded_days/, build the day's decode model
 * with `buildHsmmModel` (the exact model the production decode runs),
 * quantise every score to integers (×2²⁰ — exactly representable in
 * doubles), then decode the quantised problem with BOTH the TS trellis
 * and the verified Lean decoder (`lean/.lake/build/bin/verified_cli`)
 * and demand exact agreement — identical paths and best scores, both
 * re-scored by an independent referee here.
 *
 * Quantisation fidelity is measured separately: the float-model decode
 * (= the production path) is compared against the quantised decode as a
 * per-minute agreement rate plus the float-score delta between the two
 * paths. Rounding may legitimately flip near-ties, so this half is a
 * *metric*, not a gate.
 *
 * Duration priors are `segEnd`-independent on the minute grid except for
 * isolated cells (the train-hop relaxation), exported as sparse
 * overrides; transitions must be time-constant (chain-context off) —
 * the tool refuses days where that doesn't hold rather than shadowing
 * a different model.
 *
 * Usage: node dist/cli/lean-shadow.js [YYYY-MM-DD]
 * Exit 0 = every day's Lean↔TS-quantised decode agrees exactly.
 */

import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildHsmmModel, type HsmmModel } from "../hmm/decode.js";
import { DEFAULT_MAX_DURATION, hsmmViterbi } from "../hmm/hsmm-viterbi.js";
import type { Observation } from "../hmm/observation.js";
import type { State } from "../hmm/state-space.js";
import { type HsmmCapturedDay, hsmmInputsFromFixture } from "./hsmm-fixture.js";

const DECODED_DIR = path.join(process.cwd(), "tests", "golden", "decoded_days");
const LEAN_BIN = path.join(process.cwd(), "lean", ".lake", "build", "bin", "verified_cli");
const SCALE = 2 ** 20;
const NEG = Number.NEGATIVE_INFINITY;
/** Reference segEnd for the duration baseline (midday; any valid window). */
const REF_E = 720;

type Q = number | null;

function quantize(x: number): Q {
	if (x === NEG) return null;
	if (!Number.isFinite(x)) throw new Error(`non-finite score ${x}`);
	return Math.round(x * SCALE);
}

const sc = (v: Q): number => (v === null ? NEG : v);
const ovKey = (s: number, d: number, e: number, maxD: number, T: number): number => (s * maxD + (d - 1)) * T + e;

interface QuantProblem {
	T: number;
	S: number;
	maxD: number;
	emit: Q[][];
	trans: Q[][];
	dur: Q[][];
	durOverrides: [number, number, number, Q][];
	init: Q[];
	entry: Q[][];
}

/** Quantise the model into tensors, refusing shapes the export can't
 *  represent faithfully (time-varying transitions). */
function quantizeModel(model: HsmmModel): QuantProblem {
	const T = model.tensor.length;
	const S = model.states.length;
	const maxD = DEFAULT_MAX_DURATION;
	const st = model.states;
	const obs = model.tensor;

	const emit = Array.from({ length: T }, (_, t) => st.map((s) => quantize(model.emissionLogProb(s, obs[t]))));
	const entry = Array.from({ length: T }, (_, t) => st.map((s) => quantize(model.entryLogProb(s, obs[t]))));
	const init = st.map((s) => quantize(model.initialLogProb(s)));

	// Transitions: must be time-constant (chain-context off).
	const trans = st.map((a) => st.map((b) => quantize(model.transitionLogProb(a, b, obs[0]))));
	for (const t of [1, Math.floor(T / 3), Math.floor((2 * T) / 3), T - 1]) {
		for (let a = 0; a < S; a += 11) {
			for (let b = 0; b < S; b += 11) {
				if (quantize(model.transitionLogProb(st[a], st[b], obs[t])) !== trans[a][b]) {
					throw new Error("time-varying transitions (chain-context on?) — export unsupported");
				}
			}
		}
	}

	// Durations: baseline at REF_E + sparse per-segEnd overrides. Small d
	// is always scanned exhaustively (the train-hop relaxation lives
	// there); larger d is stride-sampled for dependence first.
	const dur = st.map((s) => Array.from({ length: maxD }, (_, d0) => quantize(model.durationLogProb(s, d0 + 1, REF_E))));
	const durOverrides: [number, number, number, Q][] = [];
	for (let si = 0; si < S; si++) {
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
				if (v !== base) durOverrides.push([si, d, e, v]);
			}
		}
	}
	return { T, S, maxD, emit, trans, dur, durOverrides, init, entry };
}

/** Independent referee: score a per-minute path under the quantised model. */
function scoreQuant(q: QuantProblem, pathStates: readonly number[]): number {
	if (pathStates.length !== q.T) return NEG;
	const ov = new Map<number, Q>();
	for (const [s, d, e, v] of q.durOverrides) ov.set(ovKey(s, d, e, q.maxD, q.T), v);
	const durAt = (s: number, d: number, e: number): number => {
		if (d < 1 || d > q.maxD) return NEG;
		const o = ov.get(ovKey(s, d, e, q.maxD, q.T));
		return o !== undefined ? sc(o) : sc(q.dur[s][d - 1]);
	};
	let total = 0;
	let i = 0;
	let prev: number | null = null;
	while (i < q.T) {
		let j = i;
		while (j + 1 < q.T && pathStates[j + 1] === pathStates[i]) j++;
		const s = pathStates[i];
		const d = j - i + 1;
		total += prev === null ? sc(q.init[s]) : sc(q.trans[prev][s]);
		total += sc(q.entry[i][s]);
		for (let t = i; t <= j; t++) total += sc(q.emit[t][s]);
		total += durAt(s, d, j);
		prev = s;
		i = j + 1;
	}
	return total;
}

/** Float referee: score a per-minute path under the real model callbacks. */
function scoreFloat(model: HsmmModel, pathStates: readonly number[]): number {
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
function decodeTsQuant(q: QuantProblem): number[] {
	const ov = new Map<number, Q>();
	for (const [s, d, e, v] of q.durOverrides) ov.set(ovKey(s, d, e, q.maxD, q.T), v);
	return hsmmViterbi<number, number>({
		observations: Array.from({ length: q.T }, (_, t) => t),
		states: Array.from({ length: q.S }, (_, s) => s),
		transitionLogProb: (from, to) => sc(q.trans[from][to]),
		emissionLogProb: (state, t) => sc(q.emit[t][state]),
		durationLogProb: (state, d, segEnd) => {
			if (d < 1 || d > q.maxD) return NEG;
			const o = ov.get(ovKey(state, d, segEnd, q.maxD, q.T));
			return o !== undefined ? sc(o) : sc(q.dur[state][d - 1]);
		},
		initialLogProb: (state) => sc(q.init[state]),
		entryLogProb: (state, t) => sc(q.entry[t][state]),
		maxDurationMinutes: q.maxD,
	});
}

function decodeLean(q: QuantProblem): { path?: number[]; best?: number; degenerate?: boolean } {
	const res = spawnSync(LEAN_BIN, [], {
		input: JSON.stringify(q),
		encoding: "utf8",
		maxBuffer: 1 << 28,
	});
	if (res.status !== 0) throw new Error(`verified_cli failed: ${res.stderr || res.stdout}`);
	return JSON.parse(res.stdout);
}

/** Decode with the float model — the production trellis path. */
function decodeTsFloat(model: HsmmModel): number[] {
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

async function main(): Promise<void> {
	const onlyDate = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? null;
	const files = (await readdir(DECODED_DIR)).filter((f) => f.endsWith(".json")).sort();
	let failures = 0;
	let checked = 0;
	for (const file of files) {
		const captured = JSON.parse(await readFile(path.join(DECODED_DIR, file), "utf8")) as HsmmCapturedDay;
		if (onlyDate !== null && captured.meta.date !== onlyDate) continue;
		checked++;
		const t0 = performance.now();
		const model = buildHsmmModel(hsmmInputsFromFixture(captured));
		const q = quantizeModel(model);
		const t1 = performance.now();
		const tsqPath = decodeTsQuant(q);
		const t2 = performance.now();
		const lean = decodeLean(q);
		const t3 = performance.now();

		const tsqScore = scoreQuant(q, tsqPath);
		let verdict: string;
		if (lean.degenerate === true) {
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
		if (verdict.startsWith("MISMATCH")) failures++;

		// Quantisation fidelity: production float decode vs quantised decode.
		const floatPath = decodeTsFloat(model);
		const agree = floatPath.filter((s, i) => s === tsqPath[i]).length;
		const delta = scoreFloat(model, tsqPath) - scoreFloat(model, floatPath);

		console.log(
			`${captured.meta.date}  lean↔tsQuant: ${verdict.padEnd(16)} ` +
				`float↔quant: ${agree}/${q.T} minutes (${((100 * agree) / q.T).toFixed(2)}%), scoreΔ ${delta.toExponential(2)}  ` +
				`[S=${q.S} ov=${q.durOverrides.length} quantise ${(t1 - t0).toFixed(0)}ms, ts ${(t2 - t1).toFixed(0)}ms, lean ${(t3 - t2).toFixed(0)}ms]`,
		);
	}
	if (checked === 0) {
		console.error("no fixtures matched");
		process.exit(2);
	}
	console.log(failures === 0 ? "\nSHADOW OK — verified decoder exact on all days" : `\n${failures} day(s) MISMATCHED`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
