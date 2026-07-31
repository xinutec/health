/**
 * CLI: the matcher-level parity gate (the V4 matcher arc of
 * `docs/proposals/2026-07-verified-core-lean.md`).
 *
 * For every walking leg of every golden day fixture (zero DB — the
 * `score-walk-match` replay chassis): run the production `matchWalkSegment`
 * (float), the BigInt twin `qMatchWalkSegment`, and the verified Lean matcher
 * (`verified_cli match`) on identical leg-windowed input, via the shared
 * `walk-shadow-core` (the same per-leg A/B the `decode-day` cron shadow runs
 * on live days). Reports the float↔quant decision classes and GATES on
 * quant↔Lean bit-exactness.
 *
 * float↔quant classes per leg:
 *   EXACT — both null, or bit-identical quantised vertex rows;
 *   NEAR  — same null-ness + vertex counts, coords within 30 cm;
 *   DIFF  — different null-ness or geometry (a genuine decision flip).
 *
 * Exit 0 = every leg's Lean output matches the twin bit-for-bit; exit 1 on any
 * quant↔Lean mismatch. (The float↔quant classes are diagnostic, never gated.)
 *
 * With `--gate` this becomes the MATCHER FLIP GATE (the analogue of
 * `shadow-passes` for the geometry passes). On top of the quant↔Lean check it
 * asserts the three honest flip conditions:
 *   1. COVERAGE   — legs were actually matched (legs > 0).
 *   2. NO FALLBACK — quant↔Lean is bit-exact on every leg (serving Lean == the
 *                   twin; nothing silently diverges from the verified core).
 *   3. AGREEMENT  — every float↔quant NEAR/DIFF leg is in the accepted manifest
 *                   (src/lean/accepted-match-deltas.ts). Serving Lean adopts the
 *                   quant decision on exactly these legs, so each must be
 *                   signed off; a new/unexplained one fails the gate.
 * All three green ⇒ the matcher is ready to serve Lean (LEAN_MATCH=on) in prod.
 *
 * Usage: node dist/cli/compare-match.js [--gate] [--leg <fingerprint>] [date ...]
 *
 * `--leg <fingerprint>` is the ADJUDICATION view: instead of one line per leg,
 * it prints the named leg's two coarse/display paths vertex by vertex with the
 * separation in metres. The summary verdict says a leg diverges; it cannot say
 * WHERE or BY HOW MUCH, and that is the whole question when deciding whether a
 * divergence is a signed-off near-tie or a real route difference. Added while
 * adjudicating #395, where a `coarse=DIFF` at equal vertex count could only be
 * told apart from rounding by looking at the vertices.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { legFingerprint, legNote } from "../geo/leg-compare.js";
import { beginWalkLegCapture, endWalkLegCapture } from "../geo/pedestrian-match-annotate.js";
import { type QPt, quantPt } from "../geo/quant-twin.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { shadowWalkLeg } from "../geo/walk-shadow-core.js";
import { isAcceptedMatchDelta, type MatchLegClass } from "../lean/accepted-match-deltas.js";
import { inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

/** The Lean arm binary — `LEAN_CLI` in the built image, else the local build. */
const LEAN_BIN = process.env.LEAN_CLI ?? path.join(process.cwd(), "lean", ".lake", "build", "bin", "verified_cli");

const allArgs = process.argv.slice(2);
const gate = allArgs.includes("--gate");
const legIdx = allArgs.indexOf("--leg");
/** Fingerprint to dump vertex-by-vertex, or null for the normal summary. */
const legFilter = legIdx === -1 ? null : (allArgs[legIdx + 1] ?? null);
if (legIdx !== -1 && legFilter === null) {
	console.error("--leg takes a leg fingerprint (16 hex chars, as printed by --gate)");
	process.exit(2);
}
const argDates = allArgs.filter((a, i) => a !== "--gate" && a !== "--leg" && i !== legIdx + 1);

/** Metres between two lat/lon points, equirectangular — exact enough at the
 *  sub-kilometre scale a walk leg spans. */
function metres(a: LL, b: LL): number {
	const R = 6371000;
	const dLat = ((b.lat - a.lat) * Math.PI) / 180;
	const dLon = (((b.lon - a.lon) * Math.PI) / 180) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon) * R;
}

/** Shortest distance in metres from `p` to the segment `a`–`b`. */
function distToSegment(p: LL, a: LL, b: LL): number {
	const len = metres(a, b);
	if (len === 0) return metres(p, a);
	// Project in a local flat frame scaled the same way `metres` scales.
	const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	const ax = a.lon * k;
	const ay = a.lat;
	const bx = b.lon * k;
	const by = b.lat;
	const px = p.lon * k;
	const py = p.lat;
	const t = Math.max(
		0,
		Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)),
	);
	return metres(p, { lat: ay + t * (by - ay), lon: (ax + t * (bx - ax)) / k });
}

/** Greatest distance from any vertex of `from` to the polyline `to`. */
function maxDeviation(from: readonly LL[], to: readonly LL[]): number {
	if (to.length === 0) return Number.POSITIVE_INFINITY;
	if (to.length === 1) return Math.max(...from.map((p) => metres(p, to[0])));
	let worst = 0;
	for (const p of from) {
		let best = Number.POSITIVE_INFINITY;
		for (let i = 1; i < to.length; i++) best = Math.min(best, distToSegment(p, to[i - 1], to[i]));
		if (best > worst) worst = best;
	}
	return worst;
}

/**
 * Vertex-by-vertex dump of one leg's two arms — the `--leg` adjudication view.
 *
 * Prints both the decision (`coarsePath`) and display (`path`) layers with the
 * separation between them, so a divergence can be told apart from a rounding
 * wobble by looking rather than by guessing. The summary verdict says a leg
 * diverges; it cannot say where or by how much.
 *
 * TWO MEASURES, because a positional one is a trap. When the arms have the SAME
 * vertex count, `f[i]` vs `q[i]` is meaningful and is reported per vertex in
 * centimetres against the classifier's 30-unit `NEAR` bar. When the counts
 * DIFFER, that comparison silently goes off-by-one at the insertion point and
 * every subsequent row compares two unrelated vertices — it reported a 133 m
 * "divergence" on 2026-07-12 that was nothing of the kind. So on a length
 * mismatch this reports the symmetric max deviation between the two POLYLINES
 * instead: the furthest either line strays from the other, which is the
 * question actually being asked and is insensitive to how each is sampled.
 *
 * Longitude is scaled by cos(lat) throughout: 1e-7° of longitude is ~1.11 cm at
 * the equator but ~0.69 cm at London's latitude, and not correcting for that
 * would overstate every east-west separation by ~45%.
 */
function dumpLeg(
	date: string,
	hhmm: string,
	fp: string,
	r: { coarse: string; path: string; exact: boolean; float: FloatArmish; quant: QuantArmish },
): void {
	console.log(`\n=== leg ${fp} — ${date} ${hhmm} ===`);
	console.log(`coarse=${r.coarse} path=${r.path}  quant↔lean ${r.exact ? "EXACT" : "MISMATCH"}`);
	if (r.float === null || r.quant === null) {
		console.log(
			`  one arm is null: float=${r.float === null ? "null" : "path"} quant=${r.quant === null ? "null" : "path"}`,
		);
		return;
	}
	for (const layer of ["coarsePath", "path"] as const) {
		const f = r.float[layer];
		const q = r.quant[layer];
		const qLL = q.map((p) => ({ lat: Number(p.la) / 1e7, lon: Number(p.lo) / 1e7 }));
		console.log(`\n  --- ${layer} — float ${f.length}v, quant ${q.length}v ---`);
		if (f.length !== q.length) {
			// Positional comparison is meaningless here; measure line-to-line.
			const fwd = maxDeviation(f, qLL);
			const back = maxDeviation(qLL, f);
			console.log(
				`  vertex counts differ by ${Math.abs(f.length - q.length)} — comparing POLYLINES, not indices.\n` +
					`  float strays at most ${fwd.toFixed(2)} m from the quant line\n` +
					`  quant strays at most ${back.toFixed(2)} m from the float line\n` +
					`  symmetric max deviation: ${Math.max(fwd, back).toFixed(2)} m`,
			);
			continue;
		}
		let worst = 0;
		for (let i = 0; i < f.length; i++) {
			const a = f[i];
			const b = q[i];
			const qa = quantPt(a);
			const dLa = Number(qa.la - b.la);
			const dLo = Number(qa.lo - b.lo);
			const dTs = Number(qa.ts - b.ts);
			if (dLa === 0 && dLo === 0 && dTs === 0) continue;
			const cmLa = dLa * 1.11;
			const cmLo = dLo * 1.11 * Math.cos((a.lat * Math.PI) / 180);
			const cm = Math.hypot(cmLa, cmLo);
			if (cm > worst) worst = cm;
			console.log(
				`  [${i}] Δlat=${dLa} Δlon=${dLo} Δts=${dTs} units → ${cm.toFixed(1)} cm` +
					`${cm > 30 * 1.11 ? "   <-- BEYOND the 30-unit NEAR bar" : ""}`,
			);
		}
		console.log(`  worst separation: ${worst.toFixed(1)} cm`);
	}
}

interface LL {
	lat: number;
	lon: number;
}

type FloatArmish = {
	coarsePath: ReadonlyArray<{ lat: number; lon: number; ts: number }>;
	path: ReadonlyArray<{ lat: number; lon: number; ts: number }>;
} | null;
type QuantArmish = { coarsePath: readonly QPt[]; path: readonly QPt[] } | null;

/** A measured float↔quant divergence, for the --gate manifest check. */
interface DivergentLeg {
	leg: string;
	date: string;
	hhmm: string;
	coarse: MatchLegClass;
	path: MatchLegClass;
	note: string;
}
const divergent: DivergentLeg[] = [];
const files = readdirSync("tests/golden/days")
	.filter((f) => f.endsWith(".json"))
	.filter((f) => argDates.length === 0 || argDates.some((d) => f.startsWith(d)))
	.sort();

let legs = 0;
const coarseTotals = { EXACT: 0, NEAR: 0, DIFF: 0 };
const pathTotals = { EXACT: 0, NEAR: 0, DIFF: 0 };
let nullBoth = 0;
let nullFlips = 0;
let leanExact = 0;
const leanMismatches: string[] = [];

for (const file of files) {
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${file}`, "utf8"));
	const inputs = inputsFromFixture(captured);
	const capture = beginWalkLegCapture();
	await computeVelocityFromInputs(inputs, { walkMatch: true });
	const legInputs = endWalkLegCapture(capture);
	const perDay: string[] = [];
	for (const leg of legInputs) {
		const fp = legFingerprint(leg.clean);
		if (legFilter !== null && fp !== legFilter) continue;
		const r = shadowWalkLeg(leg, LEAN_BIN);
		legs++;
		const date = file.slice(0, 10);
		const hhmm = new Date(leg.startTs * 1000).toISOString().slice(11, 16);
		if (legFilter !== null) {
			dumpLeg(date, hhmm, fp, r);
			continue;
		}
		if (r.exact) leanExact++;
		else leanMismatches.push(`${date} ${hhmm}`);
		coarseTotals[r.coarse]++;
		pathTotals[r.path]++;
		if (r.float === null && r.quant === null) nullBoth++;
		if ((r.float === null) !== (r.quant === null)) nullFlips++;
		const note = legNote(r.float, r.quant);
		if (r.coarse !== "EXACT" || r.path !== "EXACT") {
			divergent.push({ leg: legFingerprint(leg.clean), date, hhmm, coarse: r.coarse, path: r.path, note });
		}
		perDay.push(
			`${hhmm} coarse=${r.coarse}/path=${r.path}${r.coarse !== "EXACT" || r.path !== "EXACT" ? ` (${note})` : ""}`,
		);
	}
	// Under --leg the per-day roll-up is noise: 31 of 32 days have nothing to say.
	if (legFilter === null) console.log(`${file.slice(0, 10)}: ${perDay.length} leg(s) — ${perDay.join(", ") || "none"}`);
}

if (legFilter !== null) {
	// Adjudication view: the summary and the gate say nothing useful about one leg.
	if (legs === 0) console.error(`no leg with fingerprint ${legFilter} in the replayed corpus`);
	process.exit(legs === 0 ? 2 : 0);
}

console.log(
	`\ncompare-match: ${legs} legs — coarse EXACT=${coarseTotals.EXACT} NEAR=${coarseTotals.NEAR} ` +
		`DIFF=${coarseTotals.DIFF}; path EXACT=${pathTotals.EXACT} NEAR=${pathTotals.NEAR} ` +
		`DIFF=${pathTotals.DIFF} (both-null ${nullBoth}, null-flips ${nullFlips})`,
);
console.log(
	`compare-match: quant↔lean ${leanExact}/${legs} EXACT, ${leanMismatches.length} mismatch` +
		(leanMismatches.length > 0 ? ` — ${leanMismatches.join(", ")}` : ""),
);

if (!gate) {
	// Pure-referee contract: gate only on quant↔Lean bit-exactness.
	process.exit(leanMismatches.length === 0 ? 0 : 1);
}

// --gate: the matcher FLIP gate. Three honest conditions, mirroring
// shadow-passes: coverage, no-fallback (quant↔Lean exact), manifest agreement.
console.log(`\n=== matcher flip gate ===`);
const unexplained = divergent.filter((d) => !isAcceptedMatchDelta(d.leg, d.coarse, d.path, d.note));
if (divergent.length > 0) {
	console.log(`float↔quant divergences (${divergent.length}; ${unexplained.length} unexplained):`);
	for (const d of divergent) {
		const tag = isAcceptedMatchDelta(d.leg, d.coarse, d.path, d.note) ? "accepted" : "UNEXPLAINED";
		console.log(`  [${tag}] ${d.date} ${d.hhmm} leg=${d.leg} coarse=${d.coarse}/path=${d.path} (${d.note})`);
	}
}

const problems: string[] = [];
if (legs === 0) problems.push("NO COVERAGE — no legs matched; nothing was verified");
if (leanMismatches.length > 0)
	problems.push(`${leanMismatches.length} quant↔Lean mismatch(es) — Lean diverges from the verified twin`);
if (unexplained.length > 0)
	problems.push(`${unexplained.length} unexplained float↔quant divergence(s) — not in the accepted manifest`);

console.log(`\n${files.length} day(s), ${legs} leg(s), ${divergent.length} float↔quant delta(s).`);
if (problems.length === 0) {
	console.log("GATE GREEN — every leg matched the verified twin, all float↔quant deltas accepted. Ready to flip.");
	process.exit(0);
}
console.log("GATE RED:");
for (const p of problems) console.log(`  ✗ ${p}`);
process.exit(1);
