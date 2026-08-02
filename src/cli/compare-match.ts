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
 *   NEAR  — the same line drawn within ~33 cm, whether or not the two arms
 *           sampled it with the same number of vertices (#396);
 *   DIFF  — different null-ness, or a line that actually moved.
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
 * Usage: node dist/cli/compare-match.js [--gate] [--leg <fingerprint>]
 *                                       [--days <dir>] [date ...]
 *
 * `--leg <fingerprint>` is the ADJUDICATION view: instead of one line per leg,
 * it prints the named leg's two coarse/display paths vertex by vertex with the
 * separation in metres. The summary verdict says a leg diverges; it cannot say
 * WHERE or BY HOW MUCH, and that is the whole question when deciding whether a
 * divergence is a signed-off near-tie or a real route difference. Added while
 * adjudicating #395, where a `coarse=DIFF` at equal vertex count could only be
 * told apart from rounding by looking at the vertices.
 *
 * `--days <dir>` replays fixtures from somewhere other than the gated corpus.
 * The divergences that most need adjudicating are the ones the production
 * ledger reports on LIVE days, and the cron decodes the trailing 7 days — which
 * are by construction never in `tests/golden/days/`. Without this the only way
 * to inspect such a leg is to drop its fixture INTO the corpus, which silently
 * turns the corpus into a 33-day set with no blessed baseline for the new day
 * and reds every gate that enumerates it. Capture the day, point `--days` at it,
 * leave the corpus alone.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { legDeviations, legFingerprint, legNote, legVertexSeparations, maxDeviationM } from "../geo/leg-compare.js";
import { setCandidateSink } from "../geo/map-match-core.js";
import { setQCandidateSink } from "../geo/match-twin.js";
import { WALK_PROFILE } from "../geo/pedestrian-match.js";
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
/**
 * `--candidates`: measure the top-K cut instead of the matcher's output (#406).
 *
 * The summary classes say a leg diverged; they cannot say that the divergence
 * was BORN at the candidate cut, and the cut is the matcher's only
 * discontinuity — the one place a 1.1 cm coordinate perturbation flips a
 * decision rather than nudging a number. Two figures decide what to do about
 * it, and neither is recoverable from a matched path:
 *
 *   δ  the worst float↔quant disagreement in a projection DISTANCE, over every
 *      (fix, segment) pair both arms kept. This is what any tie tolerance has
 *      to exceed to be worth anything.
 *   g  the BOUNDARY GAP `d[K] − d[K−1]`: how far the first rejected candidate
 *      sits behind the last accepted one. A cut whose gap is comfortably above
 *      δ is stable; one below δ is a coin flip, and its leg's answer is
 *      arbitrary rather than merely different.
 *
 * Reports the joint distribution, so a tolerance can be read off the corpus
 * rather than guessed: the useful epsilon is the one above δ and below the bulk
 * of g.
 */
const candidatesMode = allArgs.includes("--candidates");
const daysIdx = allArgs.indexOf("--days");
if (daysIdx !== -1 && allArgs[daysIdx + 1] === undefined) {
	console.error("--days takes a directory of captured day fixtures");
	process.exit(2);
}
/** Where the day fixtures live — the gated corpus unless `--days` says else. */
const DAYS_DIR = daysIdx === -1 ? "tests/golden/days" : allArgs[daysIdx + 1];
// The index after a flag is that flag's VALUE, not a date. Guard each on
// `!== -1`: with the flag absent `indexOf` returns -1, so an unguarded
// `i !== idx + 1` drops argv[0] — which silently swallowed the ONLY date on
// `compare-match 2026-07-30` and replayed the whole corpus instead. Same shape
// of bug as #375, and just as quiet: the run still looks like it worked.
const argDates = allArgs.filter(
	(a, i) =>
		a !== "--gate" &&
		a !== "--leg" &&
		a !== "--days" &&
		a !== "--candidates" &&
		(legIdx === -1 || i !== legIdx + 1) &&
		(daysIdx === -1 || i !== daysIdx + 1),
);

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
			const fwd = maxDeviationM(f, qLL);
			const back = maxDeviationM(qLL, f);
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
	/** How far the two arms' lines actually are, per layer, in metres —
	 *  symmetric, so a truncated arm is as loud as a detour. `null` when one arm
	 *  matched and the other did not: there is no distance between a line and
	 *  nothing, and reporting 0 or ∞ would both be a claim. */
	coarseDevM: number | null;
	pathDevM: number | null;
	/** Worst CORRESPONDING-vertex separation, in metres, or `null` when the arms
	 *  have different vertex counts and no correspondence exists. Printed beside
	 *  the deviation because the two disagree exactly when a vertex slides ALONG
	 *  the line, and the class is derived from the deviation — so showing only
	 *  that one would hide the disagreement it resolves (#400). */
	coarseVtxM: number | null;
	pathVtxM: number | null;
}

/** Metres to two decimals, or `n/a` where the figure is undefined. */
const fmtDev = (d: number | null): string => (d === null ? "n/a" : `${d.toFixed(2)} m`);

/** One arm's pre-cut candidate list for one fix: distances (m) by segment id,
 *  in sorted order. */
interface CandObs {
	dist: number[];
	si: number[];
	/** How many the cut kept. Reported separately because the lists are emitted
	 *  BEFORE the cut — the boundary gap lives in the rejected candidates. */
	kept: number;
}

/** Buckets the boundary gap is counted into, in metres. The first is below any
 *  plausible δ, the last is wider than two parallel pavements. */
const GAP_BUCKETS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];

/**
 * Tie tolerances to ablate, in metres. `0` is the plain top-K cut — the rule
 * before #406 — so the sweep answers the question the constant cannot be chosen
 * without: how much of the disagreement is the SORT (which costs nothing) and
 * how much is the TOLERANCE (which grows the state space at every fix it
 * touches)?
 *
 * Simulated from the two arms' pre-cut lists rather than measured by re-running
 * the matcher, so all of it comes out of one replay and every row is over the
 * identical population.
 */
const TIE_SWEEP = [-1, 0, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25];

/**
 * How many candidates the tie-inclusive rule keeps, given a sorted distance
 * list. Mirrors `candidatesForFix`, including the 2K ceiling.
 *
 * `tieM < 0` is the PLAIN top-K cut — the rule before #406, and the one the
 * ablation exists to isolate. It is not the same as `tieM === 0`: a zero
 * tolerance still admits candidates at EXACTLY the K-th distance, which on this
 * corpus is a fifth of all cut fixes. Conflating the two would credit the
 * tolerance with everything the sort achieved on its own.
 */
function keptUnder(dist: readonly number[], k: number, tieM: number): number {
	if (dist.length <= k) return dist.length;
	if (tieM < 0) return k;
	const cutoff = dist[k - 1] + tieM;
	const ceiling = Math.min(dist.length, k * 2);
	let n = k;
	while (n < ceiling && dist[n] <= cutoff) n++;
	return n;
}

/** Everything `--candidates` folds across the corpus. */
const cand = {
	/** Fixes observed on both arms. */
	fixes: 0,
	/** Fixes where the two arms' pre-cut lists disagree about WHICH segments are
	 *  in radius at all — a different question from the cut, and worth keeping
	 *  apart from it. */
	radiusSetDiff: 0,
	/** Fixes with more candidates than the cut keeps — the only ones where the
	 *  cut decides anything. */
	cut: 0,
	/** …of those, fixes where the two arms' KEPT sets differ under the rule the
	 *  matcher is actually running: the defect. */
	cutSetDiff: 0,
	/** Per entry of `TIE_SWEEP`, over cut fixes: how many end with the arms
	 *  keeping different segments (the benefit), and how many extra candidates
	 *  the tolerance admitted in total (the cost). */
	sweepDiff: TIE_SWEEP.map(() => 0),
	sweepExtra: TIE_SWEEP.map(() => 0),
	/** Worst |float − quant| projection distance, metres, over segments both
	 *  arms kept, with the fix it came from. */
	maxDelta: 0,
	maxDeltaAt: "",
	/** Boundary gaps `d[K] − d[K−1]`, one per cut fix. */
	gaps: [] as number[],
	/** The narrowest gaps seen, with provenance — the legs whose answer is a
	 *  coin flip rather than a decision. */
	tightest: [] as Array<{ gap: number; where: string }>,
	/** Every fix where the arms actually KEPT different segments, with the
	 *  boundary gap that let it happen. This is the defect itself rather than a
	 *  proxy for it, and the gap column is what sizes a tolerance: a tolerance
	 *  only helps the rows whose gap it covers. */
	diffs: [] as Array<{ gap: number; where: string; float: number[]; quant: number[] }>,
};

const floatObs: CandObs[] = [];
const quantObs: CandObs[] = [];

if (candidatesMode) {
	setCandidateSink((dist, si, kept) => floatObs.push({ dist: [...dist], si: [...si], kept }));
	setQCandidateSink((dist, si, kept) => quantObs.push({ dist: dist.map((d) => Number(d) / 1e6), si: [...si], kept }));
}

/** Fold one leg's paired observations into `cand`. Called after both arms have
 *  run, with the sinks' buffers holding this leg's fixes in matcher order. */
function foldCandidates(where: string, maxCandidates: number): void {
	if (floatObs.length !== quantObs.length) {
		// The two loops walk the same `fixes` array; a length mismatch means the
		// pairing assumption is wrong and every figure below would be nonsense.
		console.error(
			`  candidate pairing broke on ${where}: float emitted ${floatObs.length} fixes, quant ${quantObs.length}`,
		);
		floatObs.length = 0;
		quantObs.length = 0;
		return;
	}
	for (let i = 0; i < floatObs.length; i++) {
		const f = floatObs[i];
		const q = quantObs[i];
		cand.fixes++;
		const qBySi = new Map(q.si.map((s, k) => [s, q.dist[k]]));
		let shared = 0;
		for (let k = 0; k < f.si.length; k++) {
			const qd = qBySi.get(f.si[k]);
			if (qd === undefined) continue;
			shared++;
			const d = Math.abs(f.dist[k] - qd);
			if (d > cand.maxDelta) {
				cand.maxDelta = d;
				cand.maxDeltaAt = `${where} fix ${i}`;
			}
		}
		if (shared !== f.si.length || shared !== q.si.length) cand.radiusSetDiff++;
		if (f.si.length <= maxCandidates) continue;
		cand.cut++;
		const gap = f.dist[maxCandidates] - f.dist[maxCandidates - 1];
		cand.gaps.push(gap);
		cand.tightest.push({ gap, where: `${where} fix ${i}` });
		cand.tightest.sort((a, b) => a.gap - b.gap);
		if (cand.tightest.length > 12) cand.tightest.length = 12;
		for (let e = 0; e < TIE_SWEEP.length; e++) {
			const nf = keptUnder(f.dist, maxCandidates, TIE_SWEEP[e]);
			const nq = keptUnder(q.dist, maxCandidates, TIE_SWEEP[e]);
			cand.sweepExtra[e] += nf - maxCandidates;
			const sf = new Set(f.si.slice(0, nf));
			const sq = q.si.slice(0, nq);
			if (sq.length !== sf.size || sq.some((x) => !sf.has(x))) cand.sweepDiff[e]++;
		}
		const fKept = new Set(f.si.slice(0, f.kept));
		const qKept = q.si.slice(0, q.kept);
		if (qKept.length !== fKept.size || qKept.some((s) => !fKept.has(s))) {
			cand.cutSetDiff++;
			cand.diffs.push({
				gap,
				where: `${where} fix ${i}`,
				float: [...fKept].filter((s) => !qKept.includes(s)),
				quant: qKept.filter((s) => !fKept.has(s)),
			});
		}
	}
	floatObs.length = 0;
	quantObs.length = 0;
}
const divergent: DivergentLeg[] = [];
const files = readdirSync(DAYS_DIR)
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
	const captured = parseCapturedDay(readFileSync(path.join(DAYS_DIR, file), "utf8"));
	const inputs = inputsFromFixture(captured);
	const capture = beginWalkLegCapture();
	await computeVelocityFromInputs(inputs, { walkMatch: true });
	const legInputs = endWalkLegCapture(capture);
	const perDay: string[] = [];
	for (const leg of legInputs) {
		const fp = legFingerprint(leg.clean);
		if (legFilter !== null && fp !== legFilter) continue;
		// The day replay above (`computeVelocityFromInputs`, walkMatch on) runs the
		// production matcher over every leg of the day before the shadow loop
		// starts, so the float sink has already seen a day's worth of fixes that
		// the quant arm never will. Drop them: only the A/B's own pair counts.
		floatObs.length = 0;
		quantObs.length = 0;
		const r = shadowWalkLeg(leg, LEAN_BIN);
		legs++;
		const date = file.slice(0, 10);
		const hhmm = new Date(leg.startTs * 1000).toISOString().slice(11, 16);
		if (candidatesMode) {
			foldCandidates(`${date} ${hhmm}`, WALK_PROFILE.maxCandidatesPerFix);
			continue;
		}
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
			const dev = legDeviations(r.float, r.quant);
			const vtx = legVertexSeparations(r.float, r.quant);
			divergent.push({
				leg: legFingerprint(leg.clean),
				date,
				hhmm,
				coarse: r.coarse,
				path: r.path,
				note,
				coarseDevM: dev.coarse,
				pathDevM: dev.path,
				coarseVtxM: vtx.coarse,
				pathVtxM: vtx.path,
			});
		}
		perDay.push(
			`${hhmm} coarse=${r.coarse}/path=${r.path}${r.coarse !== "EXACT" || r.path !== "EXACT" ? ` (${note})` : ""}`,
		);
	}
	// Under --leg the per-day roll-up is noise: 31 of 32 days have nothing to say.
	if (legFilter === null) console.log(`${file.slice(0, 10)}: ${perDay.length} leg(s) — ${perDay.join(", ") || "none"}`);
}

if (candidatesMode) {
	setCandidateSink(null);
	setQCandidateSink(null);
	const K = WALK_PROFILE.maxCandidatesPerFix;
	const gaps = [...cand.gaps].sort((a, b) => a - b);
	const pct = (n: number): string => (cand.cut === 0 ? "n/a" : `${((100 * n) / cand.cut).toFixed(1)}%`);
	console.log(`\n=== candidate cut, maxCandidatesPerFix=${K} ===`);
	console.log(`fixes observed on both arms: ${cand.fixes}`);
	console.log(`  in-radius SET differs between arms: ${cand.radiusSetDiff}`);
	console.log(`  more candidates than the cut keeps: ${cand.cut}  (the cut only decides here)`);
	console.log(`    …of those, the KEPT set differs:  ${cand.cutSetDiff}  ${pct(cand.cutSetDiff)}`);
	console.log(
		`\nδ — worst float↔quant projection-distance disagreement: ${(cand.maxDelta * 100).toFixed(3)} cm` +
			(cand.maxDeltaAt === "" ? "" : `  (${cand.maxDeltaAt})`),
	);
	console.log(`\nboundary gap d[${K}] − d[${K - 1}], cumulative over ${cand.cut} cut fixes:`);
	for (const b of GAP_BUCKETS) {
		const n = gaps.filter((g) => g <= b).length;
		console.log(`  ≤ ${`${(b * 100).toFixed(0)} cm`.padStart(7)}  ${String(n).padStart(6)}  ${pct(n).padStart(7)}`);
	}
	if (gaps.length > 0) {
		const q = (p: number): string =>
			`${(gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] * 100).toFixed(1)} cm`;
		console.log(`  median ${q(0.5)}, p10 ${q(0.1)}, p01 ${q(0.01)}, min ${(gaps[0] * 100).toFixed(2)} cm`);
	}
	console.log(`\ntie-tolerance ablation over the ${cand.cut} cut fixes — benefit vs cost:`);
	console.log("        tolerance   arms disagree      extra candidates admitted");
	for (let e = 0; e < TIE_SWEEP.length; e++) {
		const label =
			TIE_SWEEP[e] < 0
				? "plain top-K"
				: TIE_SWEEP[e] === 0
					? "exact ties only"
					: `${(TIE_SWEEP[e] * 100).toFixed(1)} cm`;
		const extra = cand.sweepExtra[e];
		console.log(
			`  ${label.padStart(16)}   ${String(cand.sweepDiff[e]).padStart(5)}  ${pct(cand.sweepDiff[e]).padStart(7)}` +
				`        ${String(extra).padStart(6)}  ${pct(extra).padStart(8)} of cut fixes`,
		);
	}

	console.log(`\ntightest boundaries — where the cut is a coin flip rather than a decision:`);
	for (const t of cand.tightest) console.log(`  ${(t.gap * 100).toFixed(3).padStart(9)} cm  ${t.where}`);
	if (cand.diffs.length > 0) {
		console.log(`\nfixes where the arms KEPT different segments (gap = what a tolerance must cover):`);
		for (const d of cand.diffs.sort((a, b) => a.gap - b.gap)) {
			console.log(
				`  ${(d.gap * 100).toFixed(3).padStart(9)} cm  ${d.where}` +
					`  float-only seg ${d.float.join(",")}  quant-only seg ${d.quant.join(",")}`,
			);
		}
	}
	process.exit(0);
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
// The measured deviations are part of the test, not decoration beside it: an
// entry is signed off AT a magnitude, so a leg that keeps its vertex counts and
// moves further than that is not the leg the sign-off was about (#395).
const accepts = (d: DivergentLeg): boolean =>
	isAcceptedMatchDelta(d.leg, d.coarse, d.path, d.note, { coarse: d.coarseDevM, path: d.pathDevM });
const unexplained = divergent.filter((d) => !accepts(d));
if (divergent.length > 0) {
	console.log(`float↔quant divergences (${divergent.length}; ${unexplained.length} unexplained):`);
	for (const d of divergent) {
		const tag = accepts(d) ? "accepted" : "UNEXPLAINED";
		console.log(
			`  [${tag}] ${d.date} ${d.hhmm} leg=${d.leg} coarse=${d.coarse}/path=${d.path} (${d.note})` +
				`  dev coarse=${fmtDev(d.coarseDevM)} path=${fmtDev(d.pathDevM)}` +
				`  vtx coarse=${fmtDev(d.coarseVtxM)} path=${fmtDev(d.pathVtxM)}`,
		);
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
