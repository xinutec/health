/**
 * Does `pnpm run focus-gate` actually discriminate, or does it just pass?
 *
 * A green gate proves nothing on its own. This breaks one thing at a time in
 * `Verified.Geo.FocusPlaces` / `Verified.Geo.FocusIdentity` (and the one
 * `Verified.Geo.Velocity` definition they share), rebuilds, and asks whether the
 * gate notices. Every mutation that leaves it green is a hole — a change the
 * gate would let through.
 *
 * This is the evidence for #435. It was originally run from throwaway scripts,
 * which meant the RESULTS were recorded and the sweep was not; #436 moved it
 * here so the discrimination can be re-derived after the next change to either
 * arm, rather than cited from a doc.
 *
 * # The four things this has to get right
 *
 * Each of these was learned by getting it wrong first, so each is enforced
 * rather than intended.
 *
 *   1. **Strip the guards before mutating.** These modules carry `#guard`
 *      blocks pinning V8 reference values, and `#guard` is checked at
 *      elaboration. Mutate a constant and `lake build` fails before the gate
 *      ever runs — 13 of the first 31 probes died this way, and a sweep that
 *      stops at BUILD-FAILED is measuring the guards' discrimination, not the
 *      gate's. `stripGuards` cuts from the guard-section header to `end
 *      Verified…` so the gate is asked the question alone.
 *
 *   2. **A control, or nothing is readable.** Stripping the guards is itself a
 *      source edit. `CONTROL-noop` strips them and changes nothing else; if it
 *      reads anything but SILENT the strip moved behaviour and every verdict
 *      below it is void, so the run aborts.
 *
 *   3. **Anchors must be unique.** `(lon / 15) * 60` appears in BOTH
 *      `localSolarHour` and `localSolarHourFractional`, in both arms. A
 *      first-occurrence replace hit the wrong one and produced a SILENT/MOVES
 *      pair that read like a gate hole for as long as it took to notice the two
 *      probes were not about the same function. `--check` fails any anchor that
 *      does not occur EXACTLY once, and the sweep runs it first.
 *
 *   4. **A silent Lean probe is not yet a finding.** Silence can mean the gate
 *      is blind, or it can mean the corpus cannot tell the difference — no data
 *      reaches the branch, or the change is a provable no-op. So a SILENT Lean
 *      probe with a `twin` re-runs the identical mutation on the TS arm
 *      instead. TWIN-MOVES = the change is observable and the Lean arm's
 *      silence is a real hole. TWIN-SILENT = an invariance of this corpus, and
 *      no gate over this data could catch it.
 *
 * # What a verdict does and does not mean
 *
 * FIRES means the gate rejects that specific mutation on the current fixtures.
 * It is not a claim about mutations of the same constant in other directions,
 * and it says nothing about code paths the corpus never enters (`frequent` is
 * never reached by any case, so nothing here tests it).
 *
 * SILENT is bounded the same way. It is a statement about THIS corpus. Adding a
 * fixture far from Greenwich would very likely close the solar-hour hole
 * without any change to the gate.
 *
 * # Cost
 *
 * One `lake build` and one gate run per probe, ~1 minute each, so a full sweep
 * is roughly half an hour. It mutates TRACKED source in the working tree and
 * restores in a `finally`; it refuses to start if any file it touches is
 * already dirty, because the pre-commit gate reads the working tree and a
 * half-restored tree is a commit hazard.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/focus-mutation-sweep.mts
 *      …                                                                       --check    # anchors only, no builds
 *      …                                                                       solar match  # substring filter
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

const FP = "lean/Verified/Geo/FocusPlaces.lean";
const FI = "lean/Verified/Geo/FocusIdentity.lean";
const VE = "lean/Verified/Geo/Velocity.lean";
const TSP = "src/geo/focus-places.ts";
const TSI = "src/geo/focus-places-identity.ts";

/** Every file any probe may write. Restored wholesale between probes. */
const TOUCHED = [FP, FI, VE, TSP, TSI];

/** The files whose `#guard` blocks would fail elaboration before the gate runs.
 *  Stripped for every Lean-arm probe, including the control. */
const GUARDED = [FP, FI, VE];

/** Start of the guard section in each guarded module. The strip runs from here
 *  to the closing `end Verified…`. */
const GUARD_HEADERS = ["/-! ## Parity with Node/V8", "/-! ## Guards (V8 reference values)"];

interface Mutation {
	/** Stable label, also the `--` filter key. */
	name: string;
	file: string;
	from: string;
	to: string;
	/** The same semantic change applied to the TS arm. Run only when the Lean
	 *  probe reads SILENT — it separates "gate is blind" from "corpus cannot
	 *  tell". */
	twin?: { file: string; from: string; to: string };
	/** Why this mutation is interesting, when that isn't obvious from the diff. */
	note?: string;
}

/**
 * The mutations. One semantic change each: a threshold moved off its cliff, a
 * comparison flipped, an ordering reversed, a rounding dropped.
 *
 * Thresholds are moved by a LOT (20 → 200, not 20 → 21). A one-step move tests
 * whether the corpus happens to straddle that exact value, which is a question
 * about the fixtures; a large move tests whether the branch is reached at all,
 * which is the question the gate exists to answer.
 */
const MUTATIONS: Mutation[] = [
	// --- geometry and admission: the stay/cluster detector's four constants ---
	{ name: "stay-radius", file: FP, from: "def STAY_RADIUS_M : Float := 100", to: "def STAY_RADIUS_M : Float := 110" },
	{ name: "cluster-radius", file: FP, from: "def CLUSTER_RADIUS_M : Float := 150", to: "def CLUSTER_RADIUS_M : Float := 160" },
	{ name: "min-duration", file: FP, from: "def FOCUS_VISIT_MIN_S : Int := 10 * 60", to: "def FOCUS_VISIT_MIN_S : Int := 11 * 60" },
	{ name: "accuracy-filter", file: FP, from: "def ACCURACY_FILTER_M : Float := 200", to: "def ACCURACY_FILTER_M : Float := 150" },

	// --- splitCluster: the k-means lobe split ---
	{ name: "split-margin", file: FP, from: "def SPLIT_MARGIN_M : Float := 30", to: "def SPLIT_MARGIN_M : Float := 300" },
	{ name: "split-time-gap", file: FP, from: "def SPLIT_MIN_TIME_GAP_HOURS : Float := 1.5", to: "def SPLIT_MIN_TIME_GAP_HOURS : Float := 6.0" },
	{ name: "split-lobe-days", file: FP, from: "def SPLIT_MIN_LOBE_DAYS : Nat := 2", to: "def SPLIT_MIN_LOBE_DAYS : Nat := 3" },
	{
		name: "kmeans-iters",
		file: FP,
		from: "def KMEANS_MAX_ITERS : Nat := 50",
		to: "def KMEANS_MAX_ITERS : Nat := 1",
		twin: { file: TSP, from: "const KMEANS_MAX_ITERS = 50;", to: "const KMEANS_MAX_ITERS = 1;" },
		note: "Lloyd converges fast here, so the iteration cap may simply not bind.",
	},
	{
		name: "reid-after-sort",
		file: FP,
		from: "let reIded := split.zipIdx.map (fun (c, i) => { c with id := Int.ofNat i + 1 })",
		to: "let reIded := split",
		note: "Drops the post-split renumbering — ids stop being dense and 1-based.",
	},
	{
		name: "dwell-sort",
		file: FP,
		from: "reIded.mergeSort (fun a b => decide (b.totalDwellSec ≤ a.totalDwellSec))",
		to: "reIded.mergeSort (fun a b => decide (a.totalDwellSec ≤ b.totalDwellSec))",
		note: "Output order reversed. #409's point: index is not identity, so this must be caught by CONTENT.",
	},

	// --- classifyClusterLabel: the five label branches ---
	{ name: "home-unique-days", file: FP, from: "decide (uniqueDays ≥ 20) && decide (overnightFrac ≥ 0.25)", to: "decide (uniqueDays ≥ 200) && decide (overnightFrac ≥ 0.25)" },
	{
		name: "work-wkday-frac",
		file: FP,
		from: "decide (wkdayDaytimeFrac ≥ 0.35)",
		to: "decide (wkdayDaytimeFrac ≥ 0.05)",
		twin: { file: TSP, from: "wkdayDaytimeFrac >= 0.35", to: "wkdayDaytimeFrac >= 0.05" },
		note: "The long-running `work` branch. Loosening admits more, which the other conjuncts may still exclude.",
	},
	{ name: "hotel-overnight", file: FP, from: "decide (dateSpanDays ≤ 21) && decide (overnightFrac ≥ 0.15)", to: "decide (dateSpanDays ≤ 21) && decide (overnightFrac ≥ 0.95)" },
	{ name: "oneoff-days", file: FP, from: 'decide (uniqueDays ≤ 2) then "one-off"', to: 'decide (uniqueDays ≤ 1) then "one-off"' },

	// --- assignDisplayNames: the three tiers ---
	{ name: "home-tier-sleep", file: FP, from: "decide (span ≥ 30) && days ≥ 20 && decide (sleep ≥ 30)", to: "decide (span ≥ 30) && days ≥ 20 && decide (sleep ≥ 3000)" },
	{ name: "work-tier-hours", file: FP, from: "(fun (_, h) => decide (h ≥ 20))", to: "(fun (_, h) => decide (h ≥ 2000))" },
	{ name: "stay-tier-sleep", file: FP, from: "decide (sleepHoursOf c ≥ 5) && uniqueDayCount", to: "decide (sleepHoursOf c ≥ 500) && uniqueDayCount" },

	// --- the hour profile: serialisation, bucketing, rounding ---
	{
		name: "profile-rounding",
		file: FP,
		from: "Float.floor (x * 1000 + 0.5)",
		to: "Float.floor (x * 1000)",
		note: "Round-half-up becomes truncation at permille — the profile is compared as a STRING, so this is visible if any bucket is non-zero.",
	},
	{ name: "profile-step", file: FP, from: "private def HOUR_PROFILE_STEP_SEC : Int := 30 * 60", to: "private def HOUR_PROFILE_STEP_SEC : Int := 20 * 60" },
	{ name: "deep-night-end", file: FP, from: "private def DEEP_NIGHT_END_HOUR : Nat := 6", to: "private def DEEP_NIGHT_END_HOUR : Nat := 5" },
	{ name: "median-index", file: FP, from: "sorted.getD (xs.length / 2) 0", to: "sorted.getD ((xs.length - 1) / 2) 0", note: "Upper vs lower median — differs only on even-length inputs." },

	// --- local solar time. TWO functions, and they are not interchangeable ---
	{
		name: "solar-hour-lon",
		file: VE,
		from: "let localMin := utcMinutes + (lon / 15) * 60",
		to: "let localMin := utcMinutes + (lon / 14) * 60",
		note: "`localSolarHour` — the INTEGER hour, and it lives in Velocity.lean, not FocusPlaces.lean. Mistaking this for the one below is what #435's pass 2 got wrong.",
	},
	{
		name: "solar-hour-frac-lon",
		file: FP,
		from: "wrapTo (utcMinutes + (lon / 15) * 60) MIN_PER_DAY / 60",
		to: "wrapTo (utcMinutes + (lon / 14) * 60) MIN_PER_DAY / 60",
		twin: {
			file: TSP,
			// Anchored on the seconds term, which only `localSolarHourFractional` has.
			from: "const utcMinutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;\n\tconst local = utcMinutes + (lon / 15) * 60;",
			to: "const utcMinutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;\n\tconst local = utcMinutes + (lon / 14) * 60;",
		},
		note: "`localSolarHourFractional` — splitCluster's circular time-of-day embedding. At London longitude the whole offset is ~2 minutes, so 15→14 barely moves it.",
	},
	{ name: "solar-hour-floor", file: FP, from: "private def hourIdx (ts : Int) (lon : Float) : Nat := (localSolarHour ts lon).toUInt64.toNat", to: "private def hourIdx (ts : Int) (lon : Float) : Nat := ((localSolarHour ts lon).toUInt64.toNat + 1) % 24" },
	{ name: "solar-day-of-week", file: FP, from: "let utcDay := ((Int.fdiv localTs 86400) + 4).emod 7", to: "let utcDay := ((Int.fdiv localTs 86400) + 5).emod 7" },
	{ name: "day-index-offset", file: FP, from: "Int.fdiv (ts + offsetSec.toInt64.toInt) 86400", to: "Int.fdiv (ts + offsetSec.toInt64.toInt + 43200) 86400", note: "Half-day shift of the local-day boundary — moves which stays share a day." },

	// --- the Fitbit sleep join ---
	{
		name: "fitbit-overlap",
		file: FP,
		from: "if overlapEnd > overlapStart then a + (overlapEnd - overlapStart) else a",
		to: "if overlapEnd ≥ overlapStart then a + (overlapEnd - overlapStart) else a",
		note: "Admits the zero-length overlap, which adds zero. Provably a no-op — included so the sweep contains at least one mutation that CANNOT fire.",
	},

	// --- FocusIdentity: matching mined clusters to existing rows ---
	{ name: "match-radius", file: FI, from: "def MATCH_RADIUS_M : Float := 150", to: "def MATCH_RADIUS_M : Float := 15" },
	{ name: "match-greedy", file: FI, from: "if a.distanceM != b.distanceM then a.distanceM < b.distanceM", to: "if a.distanceM != b.distanceM then b.distanceM < a.distanceM", note: "Greedy takes the FARTHEST pair first instead of the nearest." },
	{
		name: "match-tiebreak",
		file: FI,
		from: "a.firstSeenTs ≤ b.firstSeenTs",
		to: "b.firstSeenTs ≤ a.firstSeenTs",
		note: "Only reachable on an EXACT float distance tie, which real coordinates almost never produce.",
	},
	{
		name: "match-skip-taken",
		file: FI,
		from: "if aOld.contains p.oldIndex || aNew.any (·.1 == p.newIndex) then (aOld, aNew)",
		to: "if aOld.contains p.oldIndex then (aOld, aNew)",
		twin: {
			file: TSI,
			from: "if (assignedOld.has(p.oldIndex) || assignedNew.has(p.newIndex)) continue;",
			to: "if (assignedOld.has(p.oldIndex)) continue;",
		},
		note: "Drops half the one-to-one check, so two old places could claim one new cluster — a MERGE. Needs the corpus to contain one.",
	},
];

/** The control. Guards stripped, semantics untouched: must read SILENT. */
const CONTROL: Mutation = {
	name: "CONTROL-noop",
	file: FP,
	from: "def KMEANS_MAX_ITERS : Nat := 50",
	to: "def KMEANS_MAX_ITERS : Nat := 50 -- noop",
	note: "Guards stripped, nothing else changed. Anything but SILENT voids the run.",
};

type Verdict = "FIRES" | "SILENT" | "BUILD-FAILED" | "GATE-ERROR";

interface Result {
	name: string;
	verdict: Verdict;
	detail: string;
	/** Set when a SILENT Lean probe had its TS twin run. */
	twin?: "TWIN-MOVES" | "TWIN-SILENT" | "TWIN-BUILD-FAILED";
	note?: string;
}

// ---------------------------------------------------------------------------

const abs = (f: string): string => path.join(ROOT, f);
const read = (f: string): string => readFileSync(abs(f), "utf8");

/** Literal substitution — no regex, so no character in the pattern is special.
 *  Requires exactly one occurrence; ambiguity is a bug in the mutation table,
 *  not something to resolve by picking the first. */
function substitute(file: string, from: string, to: string): void {
	const src = read(file);
	const n = src.split(from).length - 1;
	if (n !== 1) throw new Error(`anchor occurs ${n}× in ${file} (need exactly 1): ${from.slice(0, 60)}`);
	writeFileSync(abs(file), src.replace(from, to));
}

/** Cut the `#guard` block: from its section header to the closing `end
 *  Verified…`. Leaves the `end` in place so the namespace still closes. */
function stripGuards(file: string): void {
	const lines = read(file).split("\n");
	const start = lines.findIndex((l) => GUARD_HEADERS.some((h) => l.startsWith(h)));
	if (start < 0) throw new Error(`no guard-section header in ${file}`);
	let end = -1;
	for (let i = lines.length - 1; i > start; i--) {
		if (lines[i].startsWith("end Verified")) {
			end = i;
			break;
		}
	}
	if (end < 0) throw new Error(`no closing 'end Verified' in ${file}`);
	writeFileSync(abs(file), [...lines.slice(0, start), ...lines.slice(end)].join("\n"));
}

function run(cmd: string, args: string[], cwd = ROOT): { ok: boolean; out: string } {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
	return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const buildLean = (): { ok: boolean; out: string } => run("lake", ["build"], path.join(ROOT, "lean"));
const buildTs = (): { ok: boolean; out: string } => run("npx", ["tsc"]);

/** The gate itself, straight from its compiled entry point — deliberately NOT
 *  via `pnpm run focus-gate`, which would rebuild both arms and undo the
 *  mutation this probe just applied. */
function focusGate(): { red: boolean; out: string } {
	const { out } = run("node", ["dist/cli/compare-focus.js"]);
	return { red: out.includes("FOCUS GATE RED"), out };
}

/** First failing case line, squeezed onto one line for the report. ERROR counts:
 *  a mutation that makes the Lean arm throw is still one the gate rejects, and
 *  the report should say which kind of rejection it was. */
function firstDivergence(out: string): string {
	const line = out.split("\n").find((l) => l.includes("DIVERGED") || l.includes("ERROR"));
	return line ? line.trim().replace(/\s+/g, " ").slice(0, 96) : "";
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const filters = argv.filter((a) => !a.startsWith("--"));
const selected = [CONTROL, ...MUTATIONS].filter((m) => filters.length === 0 || filters.some((f) => m.name.includes(f)));

/** Every anchor occurs exactly once, in the pristine tree. This is the check
 *  that would have caught the `(lon / 15)` mix-up before it produced a verdict. */
function checkAnchors(): number {
	let bad = 0;
	for (const m of [CONTROL, ...MUTATIONS]) {
		for (const [kind, t] of [["lean", m], ["twin", m.twin]] as const) {
			if (!t) continue;
			const n = read(t.file).split(t.from).length - 1;
			if (n !== 1) {
				console.log(`  ANCHOR ${m.name} (${kind}) occurs ${n}× in ${t.file}`);
				bad++;
			}
		}
	}
	return bad;
}

function ensureClean(): void {
	const { out } = run("git", ["status", "--porcelain", "--", ...TOUCHED]);
	if (out.trim()) {
		throw new Error(`working tree is dirty in files this sweep rewrites:\n${out}\nrefusing to start — a crash mid-probe would be indistinguishable from your edits`);
	}
}

function restoreAll(): void {
	run("git", ["checkout", "--", ...TOUCHED]);
}

/** One probe: pristine → strip guards (Lean arm) → mutate → build → gate. */
function probe(m: Mutation): Result {
	restoreAll();
	const isLean = m.file.endsWith(".lean");
	if (isLean) for (const f of GUARDED) stripGuards(f);
	substitute(m.file, m.from, m.to);

	const built = isLean ? buildLean() : buildTs();
	if (!built.ok) {
		const err = built.out.split("\n").find((l) => l.includes("error")) ?? "";
		return { name: m.name, verdict: "BUILD-FAILED", detail: err.trim().slice(0, 96), note: m.note };
	}
	// The OTHER arm must be at its pristine build, or the comparison is between
	// two mutations. A TS probe left dist/ stale from the previous restore.
	if (!isLean) {
		const l = buildLean();
		if (!l.ok) return { name: m.name, verdict: "GATE-ERROR", detail: "pristine lean arm failed to build", note: m.note };
	}

	const { red, out } = focusGate();
	if (!red && !out.includes("IDENTICAL") && !out.includes("identical")) {
		return { name: m.name, verdict: "GATE-ERROR", detail: out.trim().split("\n").slice(-1)[0]?.slice(0, 96) ?? "", note: m.note };
	}
	return { name: m.name, verdict: red ? "FIRES" : "SILENT", detail: red ? firstDivergence(out) : "", note: m.note };
}

/** The same change on the TS arm. Separates a blind gate from a corpus that
 *  cannot tell the difference. */
function probeTwin(m: Mutation): Result["twin"] {
	const t = m.twin;
	if (!t) return undefined;
	restoreAll();
	const lean = buildLean();
	if (!lean.ok) return "TWIN-BUILD-FAILED";
	substitute(t.file, t.from, t.to);
	if (!buildTs().ok) return "TWIN-BUILD-FAILED";
	return focusGate().red ? "TWIN-MOVES" : "TWIN-SILENT";
}

// ---------------------------------------------------------------------------

console.log(`focus-gate mutation sweep — ${selected.length} probe(s)\n`);

const badAnchors = checkAnchors();
if (badAnchors > 0) {
	console.log(`\n${badAnchors} anchor(s) are missing or ambiguous — the mutation table is stale. Nothing was run.`);
	process.exit(1);
}
console.log(`anchors: all ${MUTATIONS.length + 1} unique\n`);
if (checkOnly) process.exit(0);

ensureClean();

const results: Result[] = [];
try {
	for (const m of selected) {
		process.stdout.write(`${m.name.padEnd(22)}`);
		const r = probe(m);
		if (r.verdict === "SILENT" && m.twin) r.twin = probeTwin(m);
		results.push(r);
		console.log(`${r.verdict}${r.twin ? ` / ${r.twin}` : ""}${r.detail ? `   ${r.detail}` : ""}`);

		if (m.name === CONTROL.name && r.verdict !== "SILENT") {
			console.log(`\nCONTROL read ${r.verdict}, not SILENT — stripping the guards changed behaviour, so no verdict below it would mean anything. Aborting.`);
			break;
		}
	}
} finally {
	restoreAll();
	buildLean();
	buildTs();
}

// --- report ---------------------------------------------------------------

const graded = results.filter((r) => r.name !== CONTROL.name);
const fires = graded.filter((r) => r.verdict === "FIRES");
const silent = graded.filter((r) => r.verdict === "SILENT");
const broken = graded.filter((r) => r.verdict === "BUILD-FAILED" || r.verdict === "GATE-ERROR");

console.log(`\n${"=".repeat(72)}`);
console.log(`${fires.length}/${graded.length} mutations FIRE the focus gate`);
if (broken.length > 0) console.log(`${broken.length} did not produce a verdict (BUILD-FAILED / GATE-ERROR) — those are not evidence either way`);

if (silent.length > 0) {
	console.log(`\n${silent.length} SILENT — each one is a change the gate would let through:\n`);
	for (const r of silent) {
		const cls =
			r.twin === "TWIN-MOVES"
				? "GATE HOLE — observable in the TS arm, so the gate is blind to it"
				: r.twin === "TWIN-SILENT"
					? "corpus invariance — neither arm moves, no gate over this data could catch it"
					: "not characterised (no TS twin)";
		console.log(`  ${r.name.padEnd(22)} ${cls}`);
		if (r.note) console.log(`  ${" ".repeat(22)} ${r.note}`);
	}
}

const holes = silent.filter((r) => r.twin === "TWIN-MOVES");
console.log(`\n${holes.length} genuine gate hole(s)${holes.length > 0 ? `: ${holes.map((r) => r.name).join(", ")}` : ""}`);
console.log("A SILENT verdict is about THIS corpus. Adding a fixture that enters the branch can close a hole without touching the gate.");
