#!/usr/bin/env node
/**
 * V4 substrate probe: quantisation decision-flips vs float, on real walk legs.
 *
 * Replays every golden day fixture (zero DB, `score-walk-match`'s chassis),
 * takes each walking episode's raw fixes and drawn line, and compares the
 * float display-pass decisions against an integer fixed-point twin at
 * candidate coordinate scales and cos models:
 *
 *  - `metersBetween` absolute error (mm) over consecutive fix pairs;
 *  - `simplifyPath` keep-set flips at 1.5 m and 5 m tolerance;
 *  - `holdImplausibleSpeed` keep-set flips at the 12 km/h walk ceil;
 *  - `rejectSpikes` keep-set flips.
 *
 * The twin mirrors the TS arithmetic shape exactly — equirectangular metres
 * with a per-call cos (`metersBetween`: cos at the segment mid-latitude,
 * hypot; `equirectMeters` in episode-geometry: cos at the first point) — but
 * in integer µm with BigInt, an integer sqrt, and a fixed-point Q20 cos.
 * Two cos models bracket the design space: `ideal` (float cos rounded to
 * Q20 — the best any integer cos can do at that width) and `poly` (a
 * degree-6 fixed-point polynomial evaluated entirely in integers — what the
 * Lean side would actually compute).
 *
 * `simplifyPath` is internal to map-match-core, so the float side is a
 * faithful local copy (stack form) — this is a measurement probe, not the
 * parity gate; the eventual compare-geometry harness will import the real
 * exports.
 *
 * Run from the repo root after `npm run build`:
 *   node lean/experiments/quant-probe.mjs            # all golden days
 *   node lean/experiments/quant-probe.mjs 2026-06-24 # one day
 */

import { readdirSync, readFileSync } from "node:fs";
import { inputsFromFixture, parseCapturedDay } from "../../dist/cli/fixture-day.js";
import { holdImplausibleSpeed, rejectSpikes } from "../../dist/geo/episode-geometry.js";
import { metersBetween, projectPointToSegment } from "../../dist/geo/map-match-core.js";
import { computeVelocityFromInputs } from "../../dist/geo/velocity.js";

const WALK_CAP_KMH = 12;

// ---------- float twins of the internal pieces ----------

/** Faithful copy of map-match-core's internal `simplifyPath`, returning the
 *  kept index set. */
function simplifyKeepF(pts, toleranceM) {
	if (pts.length <= 2) return pts.map((_, i) => i);
	const keep = new Uint8Array(pts.length);
	keep[0] = 1;
	keep[pts.length - 1] = 1;
	const stack = [[0, pts.length - 1]];
	while (stack.length > 0) {
		const [a, b] = stack.pop();
		let maxd = -1;
		let idx = -1;
		for (let i = a + 1; i < b; i++) {
			const d = projectPointToSegment(pts[i], pts[a], pts[b]).distM;
			if (d > maxd) {
				maxd = d;
				idx = i;
			}
		}
		if (maxd > toleranceM && idx > 0) {
			keep[idx] = 1;
			stack.push([a, idx], [idx, b]);
		}
	}
	const out = [];
	for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(i);
	return out;
}

// ---------- integer fixed-point twin ----------

const MPD_UM = 111320000000n; // µm per degree of latitude (111 320 m)
const Q = 20n;
const QONE = 1n << Q;

function isqrt(n) {
	if (n < 2n) return n;
	let x = n;
	let y = (x + 1n) / 2n;
	while (y < x) {
		x = y;
		y = (x + n / x) / 2n;
	}
	return x;
}

/** round(p/q) for BigInt, q > 0. */
function roundDiv(p, q) {
	return p >= 0n ? (p + q / 2n) / q : -((-p + q / 2n) / q);
}

function quantPt(p, scale) {
	return { la: BigInt(Math.round(p.lat * scale)), lo: BigInt(Math.round(p.lon * scale)), ts: p.ts ?? 0 };
}

/** Q20 cos of a scaled-integer latitude — float cos correctly rounded.
 *  The ceiling for any Q20 integer cos implementation. */
function cosIdeal(la, scale) {
	return BigInt(Math.round(Math.cos((Number(la) / scale) * (Math.PI / 180)) * Number(QONE)));
}

// Degree-6 minimax cos on [0, π/2] (Hastings; |err| ≈ 1e-7), all-integer
// evaluation. Constants are derived once at startup (a probe convenience;
// the Lean design pins exact literals).
const RAD_Q40 = BigInt(Math.round((Math.PI / 180) * 2 ** 40));
const C0 = BigInt(Math.round(0.999999953464 * Number(QONE)));
const C2 = BigInt(Math.round(-0.499999053455 * Number(QONE)));
const C4 = BigInt(Math.round(0.0416635846769 * Number(QONE)));
const C6 = BigInt(Math.round(-0.0013853704264 * Number(QONE)));

/** Q20 cos of a scaled-integer latitude via integer Horner. */
function cosPoly(la, scale) {
	const abs = la < 0n ? -la : la;
	// x = lat in radians, Q20: la/scale * π/180.
	const x = (abs * RAD_Q40) / (BigInt(scale) << Q);
	const x2 = (x * x) >> Q;
	let r = C6;
	r = ((r * x2) >> Q) + C4;
	r = ((r * x2) >> Q) + C2;
	r = ((r * x2) >> Q) + C0;
	return r;
}

/** Integer µm distance mirroring `metersBetween` (cos at mid-latitude) or
 *  `equirectMeters` (cos at the first point) via `atMid`. */
function distQ(a, b, scale, cosQ, atMid) {
	const S = BigInt(scale);
	const dla = ((b.la - a.la) * MPD_UM) / S;
	const cref = atMid ? (a.la + b.la) / 2n : a.la;
	const c = cosQ(cref, scale);
	const dlo = (((b.lo - a.lo) * MPD_UM) / S) * c >> Q;
	return isqrt(dla * dla + dlo * dlo);
}

/** Integer µm segment distance mirroring `segmentDistM`. */
function segDistQ(p, a, b, scale, cosQ) {
	const S = BigInt(scale);
	const c = cosQ((a.la + b.la) / 2n, scale);
	const bx = (((b.lo - a.lo) * MPD_UM) / S) * c >> Q;
	const by = ((b.la - a.la) * MPD_UM) / S;
	const px = (((p.lo - a.lo) * MPD_UM) / S) * c >> Q;
	const py = ((p.la - a.la) * MPD_UM) / S;
	const len2 = bx * bx + by * by;
	let foot;
	if (len2 === 0n) {
		foot = a;
	} else {
		let dot = px * bx + py * by;
		if (dot < 0n) dot = 0n;
		else if (dot > len2) dot = len2;
		foot = {
			la: a.la + roundDiv(dot * (b.la - a.la), len2),
			lo: a.lo + roundDiv(dot * (b.lo - a.lo), len2),
		};
	}
	return distQ(p, foot, scale, cosQ, true);
}

/** Quantised `simplifyPath` keep set (recursive form — same set as the
 *  stack form; the Lean port proves this shape). */
function simplifyKeepQ(qpts, tolUm, scale, cosQ) {
	if (qpts.length <= 2) return qpts.map((_, i) => i);
	const keep = [0];
	const between = (a, b) => {
		let maxd = -1n;
		let idx = -1;
		for (let i = a + 1; i < b; i++) {
			const d = segDistQ(qpts[i], qpts[a], qpts[b], scale, cosQ);
			if (d > maxd) {
				maxd = d;
				idx = i;
			}
		}
		if (maxd > tolUm && idx > 0) {
			between(a, idx);
			keep.push(idx);
			between(idx, b);
		}
	};
	between(0, qpts.length - 1);
	keep.push(qpts.length - 1);
	return keep.sort((x, y) => x - y);
}

/** Quantised `holdImplausibleSpeed` keep set: longest plausible-speed run,
 *  speed test as exact integer cross-multiplication.
 *  d_µm/dt * 3.6 ≤ cap ⟺ 36·d_µm ≤ cap·dt·10⁷. */
function holdKeepQ(qfixes, capKmh, scale, cosQ) {
	if (qfixes.length < 2) return qfixes.map((_, i) => i);
	const cap = BigInt(capKmh);
	const runFrom = (s) => {
		const keep = [s];
		for (let i = s + 1; i < qfixes.length; i++) {
			const last = qfixes[keep[keep.length - 1]];
			const dt = BigInt(qfixes[i].ts - last.ts);
			if (dt <= 0n) continue;
			const d = distQ(last, qfixes[i], scale, cosQ, false);
			if (36n * d <= cap * dt * 10000000n) keep.push(i);
		}
		return keep;
	};
	let best = [];
	for (let s = 0; s < qfixes.length; s++) {
		const run = runFrom(s);
		if (run.length > best.length) best = run;
	}
	return best;
}

/** Quantised `rejectSpikes` keep set. 500 m = 5·10⁸ µm. */
function spikeKeepQ(qpts, scale, cosQ) {
	if (qpts.length < 3) return qpts.map((_, i) => i);
	const keep = [0];
	for (let i = 1; i < qpts.length - 1; i++) {
		const prev = qpts[keep[keep.length - 1]];
		const direct = distQ(prev, qpts[i + 1], scale, cosQ, false);
		const through =
			distQ(prev, qpts[i], scale, cosQ, false) + distQ(qpts[i], qpts[i + 1], scale, cosQ, false);
		if (through > direct * 3n && through - direct > 500000000n) continue;
		keep.push(i);
	}
	keep.push(qpts.length - 1);
	return keep;
}

// ---------- float keep-sets via the real exports ----------

function holdKeepF(fixes) {
	const kept = holdImplausibleSpeed(fixes, WALK_CAP_KMH);
	const set = new Set(kept);
	return fixes.map((f, i) => (set.has(f) ? i : -1)).filter((i) => i >= 0);
}

function spikeKeepF(pts) {
	const kept = new Set(rejectSpikes(pts));
	return pts.map((p, i) => (kept.has(p) ? i : -1)).filter((i) => i >= 0);
}

// ---------- the sweep ----------

const argDates = process.argv.slice(2);
const files = readdirSync("tests/golden/days")
	.filter((f) => f.endsWith(".json"))
	.filter((f) => argDates.length === 0 || argDates.some((d) => f.startsWith(d)))
	.sort();

const SCALES = [1e5, 1e6, 1e7];
const COS_MODELS = [
	["ideal", cosIdeal],
	["poly", cosPoly],
];

const stats = new Map(); // key -> {maxErrUm, sumErrUm, nPairs, flips per pass, legs}
for (const scale of SCALES)
	for (const [cname] of COS_MODELS)
		stats.set(`${scale}/${cname}`, {
			maxErrUm: 0n,
			sumErrUm: 0n,
			nPairs: 0,
			simp15: 0,
			simp50: 0,
			hold: 0,
			spikes: 0,
			legs: 0,
		});

const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

let totalLegs = 0;
for (const file of files) {
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${file}`, "utf8"));
	const inputs = inputsFromFixture(captured);
	const run = await computeVelocityFromInputs(inputs, { walkMatch: true });
	const walks = run.episodes.filter((e) => e.mode === "walking" && e.points.length >= 2);
	const fixes = inputs.phonetrack.today;
	for (const ep of walks) {
		const legFixes = fixes.filter((f) => f.ts >= ep.startTs && f.ts <= ep.endTs);
		if (legFixes.length < 3) continue;
		totalLegs++;

		const keepF15 = simplifyKeepF(legFixes, 1.5);
		const keepF50 = simplifyKeepF(legFixes, 5);
		const holdF = holdKeepF(legFixes);
		const spikeF = spikeKeepF(legFixes);

		for (const scale of SCALES) {
			const qf = legFixes.map((p) => quantPt(p, scale));
			for (const [cname, cosQ] of COS_MODELS) {
				const st = stats.get(`${scale}/${cname}`);
				st.legs++;
				for (let i = 1; i < legFixes.length; i++) {
					const dq = distQ(qf[i - 1], qf[i], scale, cosQ, true);
					const df = BigInt(
						Math.round(metersBetween(legFixes[i - 1].lat, legFixes[i - 1].lon, legFixes[i].lat, legFixes[i].lon) * 1e6),
					);
					const err = dq > df ? dq - df : df - dq;
					if (err > st.maxErrUm) st.maxErrUm = err;
					st.sumErrUm += err;
					st.nPairs++;
				}
				if (!eq(keepF15, simplifyKeepQ(qf, 1500000n, scale, cosQ))) st.simp15++;
				if (!eq(keepF50, simplifyKeepQ(qf, 5000000n, scale, cosQ))) st.simp50++;
				if (!eq(holdF, holdKeepQ(qf, WALK_CAP_KMH, scale, cosQ))) st.hold++;
				if (!eq(spikeF, spikeKeepQ(qf, scale, cosQ))) st.spikes++;
			}
		}
	}
	process.stdout.write(`${file.slice(0, 10)}: ${walks.length} walking leg(s)\n`);
}

console.log(`\n${totalLegs} legs probed across ${files.length} day(s)\n`);
console.log("scale/cos      maxErr(mm)  meanErr(mm)  simp1.5  simp5  hold  spikes  (legs with any keep-set flip)");
for (const [key, st] of stats) {
	const maxMm = Number(st.maxErrUm) / 1000;
	const meanMm = st.nPairs ? Number(st.sumErrUm / BigInt(st.nPairs)) / 1000 : 0;
	console.log(
		`${key.padEnd(13)} ${maxMm.toFixed(2).padStart(10)} ${meanMm.toFixed(3).padStart(12)} ${String(st.simp15).padStart(8)} ${String(st.simp50).padStart(6)} ${String(st.hold).padStart(5)} ${String(st.spikes).padStart(7)}   / ${st.legs}`,
	);
}
