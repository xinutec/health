#!/usr/bin/env node
/**
 * Lean ↔ TypeScript HSMM decoder parity harness.
 *
 * Generates seeded random integer-score problems (with -∞ hard zeros),
 * decodes each with BOTH the production TS trellis (dist/hmm/hsmm-viterbi.js)
 * and the verified Lean decoder (lean/.lake/build/bin/verified_cli), and
 * demands exact agreement: identical per-minute paths and identical best
 * scores (integer scores are exact in IEEE doubles, and the Lean port mirrors
 * the TS loop order, so even tie-breaks must match).
 *
 * The independent referee is a from-scratch segmentation scorer in this file:
 * both decoders' paths are re-scored here and must achieve the same best.
 *
 * Usage: node lean/experiments/compare.mjs   (from the repo root, after
 *        `npm run build` and `lake build` in lean/)
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const { hsmmViterbi } = await import(path.join(repo, "dist/hmm/hsmm-viterbi.js"));
const leanBin = path.join(here, "..", ".lake", "build", "bin", "verified_cli");

// mulberry32 — deterministic seeded PRNG.
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A random integer score in [-15, 12], or null (-∞) with probability pNull. */
function randScore(r, pNull) {
	if (r() < pNull) return null;
	return Math.floor(r() * 28) - 15;
}

function genProblem(seed, T, S, maxD, { perT = false, pNull = 0.15 } = {}) {
	const r = rng(seed);
	const emit = Array.from({ length: T }, () => Array.from({ length: S }, () => randScore(r, pNull)));
	const transRow = () =>
		Array.from({ length: S }, (_, sp) =>
			Array.from({ length: S }, (_, s) => (sp === s ? null : randScore(r, pNull))),
		);
	const trans = perT ? Array.from({ length: T }, transRow) : transRow();
	const dur = Array.from({ length: S }, () => Array.from({ length: maxD }, () => randScore(r, pNull / 2)));
	const init = Array.from({ length: S }, () => randScore(r, pNull / 2));
	const entry = Array.from({ length: T }, () => Array.from({ length: S }, () => randScore(r, pNull / 2)));
	return { T, S, maxD, emit, trans, dur, init, entry };
}

const NEG = Number.NEGATIVE_INFINITY;
const sc = (v) => (v === null || v === undefined ? NEG : v);

/** Model accessors shared by the TS-callback adapter and the referee scorer. */
function model(P) {
	const transAt = (t, sp, s) => sc(Array.isArray(P.trans[0][0]) ? P.trans[t][sp][s] : P.trans[sp][s]);
	return {
		emit: (t, s) => sc(P.emit[t][s]),
		trans: transAt,
		dur: (s, d, _e) => (d < 1 || d > P.maxD ? NEG : sc(P.dur[s][d - 1])),
		init: (s) => sc(P.init[s]),
		entry: (s, t) => sc(P.entry[t][s]),
	};
}

/** Independent referee: score a per-minute path under the segmentation spec. */
function scorePath(P, pathStates) {
	const m = model(P);
	if (pathStates.length !== P.T) return NEG;
	let total = 0;
	let i = 0;
	let prev = null;
	while (i < P.T) {
		let j = i;
		while (j + 1 < P.T && pathStates[j + 1] === pathStates[i]) j++;
		const s = pathStates[i];
		const d = j - i + 1;
		total += prev === null ? m.init(s) : m.trans(i, prev, s);
		total += m.entry(s, i);
		for (let t = i; t <= j; t++) total += m.emit(t, s);
		total += m.dur(s, d, j);
		prev = s;
		i = j + 1;
	}
	return total;
}

function decodeTs(P) {
	const m = model(P);
	return hsmmViterbi({
		observations: Array.from({ length: P.T }, (_, t) => t),
		states: Array.from({ length: P.S }, (_, s) => s),
		transitionLogProb: (from, to, toObs) => m.trans(toObs, from, to),
		emissionLogProb: (state, obs) => m.emit(obs, state),
		durationLogProb: (state, d, segEnd) => m.dur(state, d, segEnd),
		initialLogProb: (state) => m.init(state),
		entryLogProb: (state, obs) => m.entry(state, obs),
		maxDurationMinutes: P.maxD,
	});
}

function decodeLean(P) {
	const res = spawnSync(leanBin, [], { input: JSON.stringify(P), encoding: "utf8", maxBuffer: 1 << 26 });
	if (res.status !== 0) throw new Error(`lean decoder failed: ${res.stderr || res.stdout}`);
	return JSON.parse(res.stdout);
}

let failures = 0;
function runCase(label, P) {
	const t0 = performance.now();
	const tsPath = decodeTs(P);
	const t1 = performance.now();
	const lean = decodeLean(P);
	const t2 = performance.now();
	const tsScore = scorePath(P, tsPath);

	let verdict;
	if (lean.degenerate) {
		// Lean signals "no finite path"; the TS fallback path must indeed be -∞.
		verdict = tsScore === NEG ? "ok (degenerate)" : "MISMATCH: lean degenerate but TS path is finite";
	} else {
		const leanScore = scorePath(P, lean.path);
		const samePath = tsPath.length === lean.path.length && tsPath.every((s, i) => s === lean.path[i]);
		if (!samePath) verdict = "MISMATCH: paths differ";
		else if (leanScore !== lean.best) verdict = `MISMATCH: lean best ${lean.best} but referee scores ${leanScore}`;
		else if (tsScore !== lean.best) verdict = `MISMATCH: TS path scores ${tsScore}, lean best ${lean.best}`;
		else verdict = "ok";
	}
	if (verdict.startsWith("MISMATCH")) failures++;
	console.log(
		`${label.padEnd(34)} ${verdict.padEnd(18)} ts ${(t1 - t0).toFixed(1)}ms  lean ${(t2 - t1).toFixed(1)}ms (incl. spawn)`,
	);
}

// Sweep: many small shapes, both broadcast and per-t transitions.
for (let seed = 1; seed <= 30; seed++) {
	const r = rng(seed * 7919);
	const T = 5 + Math.floor(r() * 26);
	const S = 2 + Math.floor(r() * 4);
	const maxD = 2 + Math.floor(r() * 7);
	runCase(`small seed=${seed} T=${T} S=${S} D=${maxD}`, genProblem(seed, T, S, maxD, { perT: seed % 3 === 0 }));
}
// Dense -∞ to force degenerate and near-degenerate shapes.
for (let seed = 100; seed < 110; seed++) {
	runCase(`dense-neg seed=${seed}`, genProblem(seed, 12, 3, 3, { pNull: 0.6 }));
}
// Medium and realistic-scale (a decoded day: 1440 minutes).
runCase("medium T=200 S=6 D=30", genProblem(42, 200, 6, 30));
runCase("day T=1440 S=8 D=120", genProblem(43, 1440, 8, 120, { pNull: 0.1 }));

console.log(failures === 0 ? "\nPARITY OK — all cases agree" : `\n${failures} MISMATCHES`);
process.exit(failures === 0 ? 0 : 1);
