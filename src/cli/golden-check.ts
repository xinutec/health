/**
 * CLI: golden-day regression check (deterministic).
 *
 * Replays each captured fixture under tests/golden/days/ — the input
 * closure of one real prod day (bounded row-sets + a recorded OSM trace)
 * — through the pure classification core and diffs the resulting
 * day-state timeline (the "Your Day" view) against the fixture's
 * `expected.velocity` baseline.
 *
 * No DB. No network. No port-forward. Re-running this on the same fixture
 * from any commit produces the same result: the OSM-mirror / decoded_days
 * drift that used to make the corpus rot between runs cannot reach it
 * (that nondeterminism is what motivated `docs/proposals/2026-06-
 * deterministic-fixtures.md`). A pipeline change that moves an OSM call
 * site surfaces as an "uncaptured query" error pointing at the cause,
 * not as a downstream diff.
 *
 * The corpus is local-only and gitignored — real prod days carry real
 * coordinates, place names and biometrics that must never enter the repo
 * (see the no-private-info-in-tests feedback memory):
 *
 *   tests/golden/days/<date>-<user>.json     — captured fixtures
 *   tests/golden/ground-truth/<date>.md      — user-confirmed truth
 *
 * Capture a day with `npm run capture-golden` (that is the only path that
 * touches prod). Then:
 *
 *   npm run golden                    # check every captured day
 *   npm run golden -- --bless         # re-derive every expected
 *   npm run golden -- --bless 2026-05-15
 *
 * `--bless` re-derives `expected.velocity` from the pipeline run against
 * the ALREADY-CAPTURED inputs; it never re-pulls from prod.
 *
 * Exit 0 = every fixture matches (or was blessed).
 * Exit 1 = at least one regressed (or threw an uncaptured-query error).
 * Exit 2 = no corpus.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseGroundTruth } from "../eval/ground-truth.js";
import { gateJourneys, type JourneyBaseline } from "../eval/journey-gate.js";
import { groundTruthJourneys, journeyShapeResults, statesToJourneys } from "../eval/journey-score.js";
import { classifyDay, parsePipelineState } from "../eval/truth-check.js";
import { checkWorldlineFeasibility } from "../eval/worldline-feasibility.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { type CapturedDay, inputsFromFixture, parseCapturedDay } from "./fixture-day.js";
import { diffStates, normalizeStates } from "./state-diff.js";

const GOLDEN_DIR = path.join(process.cwd(), "tests", "golden");
const DAYS_DIR = path.join(GOLDEN_DIR, "days");
const GROUND_TRUTH_DIR = path.join(GOLDEN_DIR, "ground-truth");

/** Minimal day-state shape the truth report needs from the replay's
 *  `states`. */
interface StateWindow {
	startTs: number;
	endTs: number;
	mode: string;
	place?: string | null;
	wayName?: string | null;
}

/**
 * Provenance-aware truth check, layered ON TOP of the snapshot diff. Loads
 * the day's `ground-truth/<date>.md` (if any), classifies each row against
 * the replayed states via {@link classifyDay}, and renders a one-line
 * summary plus any `regressed` (a confirmed truth broke) and `cleared` (a
 * known error got fixed) rows. Returns null when no ground-truth file or no
 * enforceable truth exists. Informational: the snapshot diff is the gate;
 * the truth layer is how a frozen-but-wrong day (e.g. the LSHTM / hospital
 * mislabels the deterministic capture preserves) stays honestly visible.
 */
interface TruthResult {
	text: string;
	/** Start times (unix seconds) of the ground-truth journeys the PIPELINE
	 *  reconstructed with the correct mode shape — the ratchet's per-day set. */
	journeyMatched: number[];
}

async function truthReport(date: string, tz: string, states: readonly StateWindow[]): Promise<TruthResult | null> {
	let md: string;
	try {
		md = await readFile(path.join(GROUND_TRUTH_DIR, `${date}.md`), "utf8");
	} catch {
		return null; // no ground-truth file for this day
	}
	const gt = parseGroundTruth(md, date, tz);

	// Journey-level score of the DRAWN timeline (not just the HSMM decoder):
	// does the day read as the right sequence of trips? Ground-truth journeys use
	// `correct`+`partial` rows (NOT provenance-gated); the pipeline side is built
	// from the drawn state legs directly (minute-free, so a sub-minute leg is not
	// dropped). The ratchet tracks per-journey matches.
	const gtJourneys = groundTruthJourneys(gt.rows);
	const journeyResults = journeyShapeResults(gtJourneys, statesToJourneys(states));
	const journeyMatched = journeyResults.filter((r) => r.matched).map((r) => r.startTs);
	const journeysMatchedCount = journeyResults.filter((r) => r.matched).length;

	// Per-row truth verdicts are provenance-gated (regressed/known-error need a
	// trusted provenance) — a stricter bar than journeys, so kept separate.
	const stateAt = (startTs: number, endTs: number): StateWindow | null => {
		const mid = (startTs + endTs) / 2;
		return states.find((s) => s.startTs <= mid && mid < s.endTs) ?? null;
	};
	const res = classifyDay(gt.rows, (row) => parsePipelineState(stateAt(row.startTs, row.endTs)));
	const enforceable = res.verified + res.regressed + res.knownError + res.cleared;
	if (enforceable === 0 && gtJourneys.length === 0) return null; // nothing to enforce or score

	const lines: string[] = [];
	if (enforceable > 0)
		lines.push(
			`    truth: ${res.verified} verified · ${res.knownError} known-error · ${res.cleared} cleared · ` +
				`${res.regressed} regressed  (${res.unverified} unverified)`,
		);
	if (gtJourneys.length > 0) lines.push(`    journeys: ${journeysMatchedCount}/${gtJourneys.length} reconstructed`);
	for (const { row, verdict } of res.verdicts) {
		if (verdict === "regressed")
			lines.push(`      ✗ REGRESSED ${row.windowText}: confirmed "${row.truthText}" no longer holds`);
		if (verdict === "cleared")
			lines.push(
				`      ✓ cleared    ${row.windowText}: now matches truth "${row.truthText}" — flip the row to correct`,
			);
	}
	// Per-journey failure diagnostic: expected vs reconstructed mode shape — the
	// signal that says WHICH factor (corridor / kinematic / cadence) each broken
	// journey needs. Only shown with GOLDEN_JOURNEY_DEBUG to keep the report terse.
	if (process.env.GOLDEN_JOURNEY_DEBUG) {
		for (const r of journeyResults.filter((x) => !x.matched)) {
			const at = new Date(r.startTs * 1000).toISOString().slice(11, 16);
			lines.push(
				`      ✗ journey @${at}Z  expected [${r.expectedShape.join(",")}]  got [${(r.actualShape ?? []).join(",")}]`,
			);
		}
	}
	return { text: lines.join("\n"), journeyMatched };
}

const JOURNEY_BASELINE_PATH = path.join(GOLDEN_DIR, "journey-baseline.json");
/** Per-day standing count of `impossible-mode-kinematics` legs — the ratcheted
 *  ceiling. Tracked in git like the other floors; safe to commit (counts only,
 *  no coordinates). */
const FEASIBILITY_BASELINE_PATH = path.join(GOLDEN_DIR, "feasibility-baseline.json");
type FeasibilityBaseline = Record<string, number>;
/** Per-day standing count of `invalid-rail-triple` legs — a labelled train
 *  leg whose line does not serve its board/alight station (#181/#351).
 *  Ratcheted like the kinematic ceiling: membership data comes from each
 *  fixture's recorded `stationsOnLine` trace, so a re-capture that widens
 *  coverage can surface NEW standing debt — that is a real defect becoming
 *  visible, blessed into the ceiling rather than hidden. */
const RAIL_TRIPLE_BASELINE_PATH = path.join(GOLDEN_DIR, "rail-triple-baseline.json");

const args = process.argv.slice(2);
let bless = false;
let blessDate: string | null = null;
let blessJourneys = false;
let blessFeasibility = false;
let blessRailTriples = false;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--bless") {
		bless = true;
		const next = args[i + 1];
		if (next && /^\d{4}-\d{2}-\d{2}$/.test(next)) {
			blessDate = next;
			i++;
		}
	} else if (args[i] === "--bless-journeys") {
		// Ratchet the journey floor UP to the current run: record which
		// ground-truth journeys the pipeline now reconstructs. Run after a
		// change that fixes a journey (the run prints it as an improvement).
		blessJourneys = true;
	} else if (args[i] === "--bless-feasibility") {
		// Ratchet the kinematic-feasibility ceiling DOWN to the current run:
		// record how many impossible-mode-kinematics legs each day still
		// emits. Run after a change that removes some (the run prints the
		// improvement).
		blessFeasibility = true;
	} else if (args[i] === "--bless-rail-triples") {
		// Ratchet the invalid-rail-triple ceiling to the current run. Down
		// after a fix; up only when a re-capture widens membership coverage
		// and surfaces pre-existing debt.
		blessRailTriples = true;
	} else {
		console.error(`unknown argument: ${args[i]}`);
		process.exit(2);
	}
}

async function loadJourneyBaseline(): Promise<JourneyBaseline> {
	try {
		return JSON.parse(await readFile(JOURNEY_BASELINE_PATH, "utf8")) as JourneyBaseline;
	} catch {
		return {}; // no baseline yet — first run bootstraps
	}
}

async function loadFeasibilityBaseline(): Promise<FeasibilityBaseline | null> {
	try {
		return JSON.parse(await readFile(FEASIBILITY_BASELINE_PATH, "utf8")) as FeasibilityBaseline;
	} catch {
		return null; // no baseline yet — first run bootstraps
	}
}

let files: string[];
try {
	files = (await readdir(DAYS_DIR)).filter((f) => f.endsWith(".json")).sort();
} catch {
	files = [];
}
if (files.length === 0) {
	console.error(
		`No golden fixtures found at ${DAYS_DIR}.\n` +
			`Capture one against the prod DB:\n` +
			`  npm run capture-golden -- <date> <user> <timezone>`,
	);
	process.exit(2);
}

let regressions = 0;
let blessed = 0;
let checked = 0;
// Worldline-feasibility accounting (Phase 0 of journey-worldline). Two
// severities: the label-only rail invariants are HARD-ZERO (the corpus has
// none; any occurrence is a regression), while the kinematic invariant
// carries a standing per-day count of pre-existing defects and is RATCHETED
// (can only shrink) against the committed baseline — the same only-shrink
// discipline as the journey floor.
let hardViolations = 0;
const kinematicNow: FeasibilityBaseline = {};
const railTripleNow: FeasibilityBaseline = {};
// Per-day set of ground-truth journeys the pipeline reconstructs this run —
// compared against the committed baseline by the journey ratchet gate below.
const journeysNow: JourneyBaseline = {};

for (const file of files) {
	const full = path.join(DAYS_DIR, file);
	const captured = parseCapturedDay(await readFile(full, "utf8"));
	if (blessDate && captured.meta.date !== blessDate) continue;

	const label = `${captured.meta.date} ${captured.meta.user}${captured.meta.description ? ` — ${captured.meta.description}` : ""}`;

	let states: Awaited<ReturnType<typeof computeVelocityFromInputs>>["states"];
	let dayPoints: Awaited<ReturnType<typeof computeVelocityFromInputs>>["points"];
	let actual: ReturnType<typeof normalizeStates>;
	const dayInputs = inputsFromFixture(captured);
	try {
		const result = await computeVelocityFromInputs(dayInputs);
		states = result.states;
		dayPoints = result.points;
		actual = normalizeStates(states, captured.meta.tz);
	} catch (e) {
		// An uncaptured-query throw means the pipeline reached an OSM call
		// site the fixture didn't record — a moved/added call site. That is
		// a real change to review, surfaced at its cause.
		regressions++;
		console.log(`\nFAIL     ${label}`);
		console.log(`    ${e instanceof Error ? e.message : String(e)}`);
		console.log(
			`    re-capture: npm run capture-golden -- ${captured.meta.date} ${captured.meta.user} ${captured.meta.tz}\n`,
		);
		continue;
	}

	if (bless) {
		const updated: CapturedDay = { ...captured, expected: { velocity: actual } };
		await writeFile(full, `${JSON.stringify(updated, null, "\t")}\n`, "utf8");
		blessed++;
		console.log(`blessed  ${label}  (${actual.length} states)`);
		continue;
	}

	checked++;
	const d = diffStates(captured.expected.velocity, actual);
	if (d.identical) {
		console.log(`PASS     ${label}`);
	} else {
		regressions++;
		console.log(`\nFAIL     ${label}`);
		for (const ln of d.lines) console.log(ln);
		console.log(
			`    captured ${captured.meta.capturedAt} @ ${captured.meta.capturedAtCodeSha.slice(0, 8)}.\n` +
				`    If intentional, re-bless: npm run golden -- --bless ${captured.meta.date}\n`,
		);
	}

	// Provenance-aware truth report + journey score (on top of the diff).
	const truth = await truthReport(captured.meta.date, captured.meta.tz, states as StateWindow[]);
	if (truth) {
		console.log(truth.text);
		journeysNow[captured.meta.date] = truth.journeyMatched;
	}

	// Worldline-feasibility report: physically-impossible outputs the cascade
	// emitted on this day's timeline. Points enable the kinematic invariant
	// (a walking leg sustaining vehicle pace); step data enables the
	// symmetric one (#356 — a train leg sustaining a pedestrian stepping
	// run) on top of the label-only rail-continuity checks. Line membership
	// comes from the fixture's recorded `stationsOnLine` trace (no live
	// queries at replay), enabling the valid-triple invariant (#181/#351) on
	// exactly the lines the captured pipeline run resolved.
	const lineStations = new Map(Object.entries(captured.inputs.osmTrace.stationsOnLine ?? {}));
	const violations = checkWorldlineFeasibility(states, dayPoints, dayInputs.biometrics.steps, lineStations);
	if (violations.length > 0) {
		const kinematic = violations.filter((v) => v.kind === "impossible-mode-kinematics").length;
		if (kinematic > 0) kinematicNow[captured.meta.date] = kinematic;
		const railTriples = violations.filter((v) => v.kind === "invalid-rail-triple").length;
		if (railTriples > 0) railTripleNow[captured.meta.date] = railTriples;
		hardViolations += violations.length - kinematic - railTriples;
		console.log(`    ⚠ feasibility: ${violations.length} physically-impossible leg(s)`);
		for (const v of violations) console.log(`      ✗ ${v.kind}: ${v.detail}`);
	}
}

if (bless) {
	console.log(`\nBlessed ${blessed} day(s).`);
	process.exit(0);
}

console.log(
	`\n${checked - regressions}/${checked} fixture(s) match baseline` +
		(regressions > 0 ? `, ${regressions} regressed.` : "."),
);
// Rail worldline invariants are a hard gate: the corpus baseline is zero
// (every blessed day is rail-consistent), so any occurrence is a failure,
// not a tolerated diff. This is independent of the snapshot diff — a change
// can keep the blessed states byte-identical and still introduce an
// impossibility on a non-blessed path, but on the corpus this guards the
// invariant directly.
console.log(
	hardViolations > 0
		? `worldline-feasibility (rail): FAIL — ${hardViolations} impossible leg(s).`
		: `worldline-feasibility (rail): all ${checked} day(s) consistent.`,
);

// Kinematic feasibility is a RATCHET: the corpus carries a standing count of
// pre-existing impossible-mode-kinematics legs (rides stranded inside walks
// that the boundary passes do not yet reclaim). The committed baseline is a
// ceiling that can only shrink — a day emitting MORE than its baseline is a
// regression; fixing legs prompts a re-bless that ratchets the ceiling down.
const kinematicTotal = Object.values(kinematicNow).reduce((n, c) => n + c, 0);
let kinematicRegressed = 0;
if (blessFeasibility) {
	const ordered: FeasibilityBaseline = {};
	for (const date of Object.keys(kinematicNow).sort()) ordered[date] = kinematicNow[date];
	await writeFile(FEASIBILITY_BASELINE_PATH, `${JSON.stringify(ordered, null, "\t")}\n`, "utf8");
	console.log(
		`feasibility (kinematic): blessed ceiling — ${kinematicTotal} standing leg(s) across ${Object.keys(ordered).length} day(s).`,
	);
	process.exit(0);
}
const feasBaseline = await loadFeasibilityBaseline();
if (feasBaseline === null) {
	console.log(
		`feasibility (kinematic): no baseline yet — ${kinematicTotal} standing leg(s). Establish the ceiling with: npm run golden -- --bless-feasibility`,
	);
} else {
	const dates = new Set([...Object.keys(feasBaseline), ...Object.keys(kinematicNow)]);
	let improvedDays = 0;
	for (const date of [...dates].sort()) {
		const was = feasBaseline[date] ?? 0;
		const now = kinematicNow[date] ?? 0;
		if (now > was) {
			kinematicRegressed += now - was;
			console.log(`      ✗ feasibility (kinematic): ${date} emits ${now} impossible leg(s), ceiling is ${was}`);
		} else if (now < was) {
			improvedDays++;
		}
	}
	console.log(
		kinematicRegressed > 0
			? `feasibility (kinematic): FAIL — ${kinematicRegressed} leg(s) above the committed ceiling.`
			: `feasibility (kinematic): ${kinematicTotal} standing leg(s), none above the ceiling.`,
	);
	if (improvedDays > 0) {
		console.log(
			`feasibility (kinematic): ${improvedDays} day(s) improved — ratchet the ceiling down with: npm run golden -- --bless-feasibility`,
		);
	}
}

// --- invalid-rail-triple ratchet ------------------------------------------
// Same only-shrink discipline as the kinematic ceiling, tracked separately:
// a labelled train leg naming a station its line does not serve (#181/#351).
// Coverage depends on each fixture's recorded stationsOnLine trace, so a
// re-capture can WIDEN coverage and surface pre-existing debt — bless the
// higher ceiling explicitly rather than let it hide.
const railTripleTotal = Object.values(railTripleNow).reduce((n, c) => n + c, 0);
let railTripleRegressed = 0;
if (blessRailTriples) {
	const ordered: FeasibilityBaseline = {};
	for (const date of Object.keys(railTripleNow).sort()) ordered[date] = railTripleNow[date];
	await writeFile(RAIL_TRIPLE_BASELINE_PATH, `${JSON.stringify(ordered, null, "\t")}\n`, "utf8");
	console.log(
		`rail triples: blessed ceiling — ${railTripleTotal} standing invalid leg(s) across ${Object.keys(ordered).length} day(s).`,
	);
	process.exit(0);
}
let railTripleBaseline: FeasibilityBaseline | null = null;
try {
	railTripleBaseline = JSON.parse(await readFile(RAIL_TRIPLE_BASELINE_PATH, "utf8")) as FeasibilityBaseline;
} catch {
	railTripleBaseline = null; // no baseline yet — first run bootstraps
}
if (railTripleBaseline === null) {
	console.log(
		`rail triples: no baseline yet — ${railTripleTotal} standing invalid leg(s). Establish the ceiling with: npm run golden -- --bless-rail-triples`,
	);
} else {
	const dates = new Set([...Object.keys(railTripleBaseline), ...Object.keys(railTripleNow)]);
	let improvedDays = 0;
	for (const date of [...dates].sort()) {
		const was = railTripleBaseline[date] ?? 0;
		const now = railTripleNow[date] ?? 0;
		if (now > was) {
			railTripleRegressed += now - was;
			console.log(`      ✗ rail triples: ${date} emits ${now} invalid leg(s), ceiling is ${was}`);
		} else if (now < was) {
			improvedDays++;
		}
	}
	console.log(
		railTripleRegressed > 0
			? `rail triples: FAIL — ${railTripleRegressed} leg(s) above the committed ceiling.`
			: `rail triples: ${railTripleTotal} standing invalid leg(s), none above the ceiling.`,
	);
	if (improvedDays > 0) {
		console.log(
			`rail triples: ${improvedDays} day(s) improved — ratchet the ceiling down with: npm run golden -- --bless-rail-triples`,
		);
	}
}

// --- journey ratchet -----------------------------------------------------
// Ratchet the story-correctness of the drawn timeline: a ground-truth journey
// the pipeline USED to reconstruct correctly (in the committed baseline) that
// no longer does is a hard failure, mirroring worldline-feasibility. The
// baseline is the current non-zero set of working journeys (most are not yet
// correct), so this makes the standing failures a floor that can only shrink —
// the measurement the joint mode+position model (#257) is built against.
const totalReconstructed = Object.values(journeysNow).reduce((n, a) => n + a.length, 0);
if (blessJourneys) {
	const ordered: JourneyBaseline = {};
	for (const date of Object.keys(journeysNow).sort()) ordered[date] = [...journeysNow[date]].sort((a, b) => a - b);
	await writeFile(JOURNEY_BASELINE_PATH, `${JSON.stringify(ordered, null, "\t")}\n`, "utf8");
	console.log(
		`journeys: blessed baseline — ${totalReconstructed} reconstructed journey(s) across ${Object.keys(ordered).length} day(s).`,
	);
	process.exit(0);
}

const baseline = await loadJourneyBaseline();
const gate = gateJourneys(baseline, journeysNow);
if (Object.keys(baseline).length === 0) {
	console.log(
		`journeys: no baseline yet — ${totalReconstructed} reconstructed. Establish the floor with: npm run golden -- --bless-journeys`,
	);
} else if (gate.regressed.length > 0) {
	console.log(`journeys: FAIL — ${gate.regressed.length} previously-reconstructed journey(s) regressed:`);
	for (const r of gate.regressed)
		console.log(`      ✗ ${r.date} @${new Date(r.startTs * 1000).toISOString().slice(11, 16)}Z`);
} else {
	console.log(`journeys: ${totalReconstructed} reconstructed, no regressions.`);
}
if (gate.improved.length > 0) {
	console.log(
		`journeys: ${gate.improved.length} newly reconstructed — re-bless to ratchet the floor up (--bless-journeys):`,
	);
	for (const im of gate.improved)
		console.log(`      ✓ ${im.date} @${new Date(im.startTs * 1000).toISOString().slice(11, 16)}Z`);
}

process.exit(
	regressions > 0 ||
		hardViolations > 0 ||
		kinematicRegressed > 0 ||
		railTripleRegressed > 0 ||
		gate.regressed.length > 0
		? 1
		: 0,
);
