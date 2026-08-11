// #766: WHY do the `lean-passes` simplify arms disagree about which vertex to
// keep? Answered 2026-08-11 — and the answer was the third hypothesis, so the
// two that failed are kept here as the reason this prints what it prints.
//
// Each divergence is a +/-1 shift in a kept index. Three candidate causes:
//
//   1. A FLOAT TIE — two candidates within a few ULP, flipped by `cos`/`hypot`.
//      REFUTED: the gaps are 1.4-7.7 mm, ~1e12 ULP. Rounding cannot do that.
//   2. INPUT QUANTISATION — the wire snaps coordinates to 1e-7 deg (1.11 cm of
//      latitude). REFUTED for 4 of 5 steps: re-running the float formula on
//      snapped inputs still picks the TS vertex.
//   3. THE QUANTISED METRIC ITSELF. Confirmed, 5 of 5. `qChordDist` snaps the
//      PERPENDICULAR FOOT back onto the grid before measuring to it, where the
//      float arm keeps the foot exact — worth several mm on the deviation,
//      which is the scale of every gap here.
//
// So the Lean arm is faithful to its own specification and the two arms answer
// slightly different questions. This prints all three tests side by side, so a
// future divergence can be classified rather than assumed to be the same one.
//
// The three columns are the whole point: a mechanism that merely COULD produce
// the observed shape is not evidence, and two of these looked plausible.
//
// Run: SIMPLIFY_DUMP_DIR=/tmp/simpdump pnpm run golden   (to collect)
//      node scripts/probe-simplify-divergence.mjs /tmp/simpdump

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectPointToSegment } from "../dist/geo/map-match-core.js";
import { qChordDist, quantPt } from "../dist/geo/quant-twin.js";

const dir = process.argv[2] ?? "/tmp/simpdump";

/** ULP gap between two doubles — the honest unit for "are these the same
 *  number". A raw difference means nothing without the magnitude. */
function ulpGap(x, y) {
	const buf = new DataView(new ArrayBuffer(8));
	const bits = (v) => {
		buf.setFloat64(0, v);
		return buf.getBigUint64(0);
	};
	const a = bits(x);
	const b = bits(y);
	return a > b ? a - b : b - a;
}

/** The TS scan, instrumented: every recursion step, with its winner and the
 *  runner-up. Mirrors `simplifyPath` exactly — same stack order, same strict
 *  `>` (so the FIRST of equal candidates wins). */
function scanSteps(pts, toleranceM) {
	const steps = [];
	const keep = new Uint8Array(pts.length);
	keep[0] = 1;
	keep[pts.length - 1] = 1;
	const stack = [[0, pts.length - 1]];
	while (stack.length > 0) {
		const [a, b] = stack.pop();
		let maxd = -1;
		let idx = -1;
		const all = [];
		for (let i = a + 1; i < b; i++) {
			const d = projectPointToSegment(pts[i], pts[a], pts[b]).distM;
			all.push([i, d]);
			if (d > maxd) {
				maxd = d;
				idx = i;
			}
		}
		if (maxd > toleranceM && idx > 0) {
			steps.push({ a, b, idx, maxd, all });
			keep[idx] = 1;
			stack.push([a, idx], [idx, b]);
		}
	}
	return steps;
}

/** The point as the LEAN ARM SEES IT: snapped to the 1e-7-degree grid that
 *  `quantPt` puts on the wire. ~1.11 cm in latitude, ~0.69 cm in longitude at
 *  London — coarser than any of the gaps this probe measures. */
function quantised(p) {
	return { lat: Math.round(p.lat * 1e7) / 1e7, lon: Math.round(p.lon * 1e7) / 1e7 };
}

let anyReal = false;
for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
	const d = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
	const pts = d.pts.map(([lat, lon]) => ({ lat, lon }));
	console.log(`\n=== ${f}  n=${d.n} tol=${d.toleranceM} m`);
	console.log(`    ts-only=[${d.tsOnly}]  lean-only=[${d.leanOnly}]`);

	const steps = scanSteps(pts, d.toleranceM);
	const disputed = new Set([...d.tsOnly, ...d.leanOnly]);
	const hits = steps.filter((s) => disputed.has(s.idx));
	if (hits.length === 0) {
		console.log("    no scan step chose a disputed index — the shift is downstream of the pick.");
		continue;
	}
	for (const s of hits) {
		// The runner-up is the best candidate OTHER than the winner. If the two
		// are a near-tie, a 1-ULP difference anywhere in the distance flips them.
		const sorted = [...s.all].sort((p, q) => q[1] - p[1]);
		const [wi, wd] = sorted[0];
		const [ri, rd] = sorted[1] ?? [-1, Number.NaN];
		const gap = Number.isNaN(rd) ? null : ulpGap(wd, rd);
		console.log(`    step [${s.a},${s.b}] chose ${s.idx}`);
		console.log(`      winner    ${wi}: ${wd}`);
		console.log(`      runner-up ${ri}: ${rd}`);
		// THE DECIDING TEST: re-run the SAME TS formula on the QUANTISED points.
		// If the argmax moves to the index Lean chose, quantisation alone explains
		// the divergence and the Lean implementation is faithful — no appeal to
		// float ties or a metric mismatch is needed.
		const q = pts.map(quantised);
		let qBest = -1;
		let qIdx = -1;
		for (let i = s.a + 1; i < s.b; i++) {
			const dq = projectPointToSegment(q[i], q[s.a], q[s.b]).distM;
			if (dq > qBest) {
				qBest = dq;
				qIdx = i;
			}
		}
		// And the SAME step through the QUANTISED TWIN — the TS mirror of Lean's
		// own fixed-point arithmetic. This is what the Lean arm actually computes,
		// rather than a model of it.
		const qp = pts.map((v) => quantPt(v));
		let tBest = -1n;
		let tIdx = -1;
		for (let i = s.a + 1; i < s.b; i++) {
			const dt = qChordDist(qp[i], qp[s.a], qp[s.b]);
			if (dt > tBest) {
				tBest = dt;
				tIdx = i;
			}
		}
		const predicted = d.leanOnly.find((i) => i > s.a && i < s.b);
		console.log(
			`      quantised argmax -> ${qIdx}` +
				(predicted === undefined
					? ""
					: qIdx === predicted
						? `  == lean's pick (${predicted})  QUANTISATION EXPLAINS IT`
						: `  != lean's pick (${predicted})  NOT explained by quantisation`),
		);
		console.log(
			`      quant-twin argmax -> ${tIdx}` +
				(predicted === undefined
					? ""
					: tIdx === predicted
						? `  == lean's pick (${predicted})  THE TWIN REPRODUCES LEAN`
						: `  != lean's pick (${predicted})  the twin does NOT reproduce lean`),
		);
		if (gap === null) console.log("      only one candidate — not a tie");
		else if (gap <= 4n) console.log(`      NEAR-TIE: ${gap} ULP apart — a 1-ULP arithmetic difference flips this`);
		else {
			anyReal = true;
			console.log(`      REAL GAP: ${gap} ULP (${Math.abs(wd - rd)} m) — rounding does not explain this`);
		}
	}
}
console.log(
	anyReal
		? "\nAt least one divergence has a real margin — NOT purely a float tie."
		: "\nEvery divergence sits on a near-tie in the argmax.",
);
