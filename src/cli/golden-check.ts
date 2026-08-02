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
 * Layered on top of the snapshot diff are five ratchets, each with its own
 * committed baseline and `--bless-*` flag: `--bless-truth` (confirmed
 * ground-truth rows the pipeline satisfies), `--bless-journeys` (journeys it
 * reconstructs), `--bless-feasibility` and `--bless-rail-triples` (standing
 * counts of physically-impossible legs, which shrink rather than grow), and
 * `--bless-lean-deltas` (unexplained divergences between the TS and Lean arms —
 * the ceiling that lets a Lean tenant be staged here while it still carries
 * debt, #403).
 *
 * Exit 0 = every fixture matches (or was blessed).
 * Exit 1 = at least one regressed (or threw an uncaptured-query error).
 * Exit 2 = no corpus.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type FloorBaseline, gateFloor, ratchetUpFloor } from "../eval/floor-gate.js";
import { parseGroundTruth } from "../eval/ground-truth.js";
import { gateJourneys, type JourneyBaseline } from "../eval/journey-gate.js";
import { groundTruthJourneys, journeyShapeResults, statesToJourneys } from "../eval/journey-score.js";
import { classifyDay, parsePipelineState } from "../eval/truth-check.js";
import { checkWorldlineFeasibility } from "../eval/worldline-feasibility.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { ceilingSize, type DeltaCeiling, gateDeltaCeiling, ratchetDownCeiling } from "../lean/delta-ceiling.js";
import { logLeanBioLabelsLedger } from "../lean/lean-biometric-labels.js";
import { logLeanGpsQualityLedger } from "../lean/lean-gps-quality.js";
import { logLeanHsmmLedger } from "../lean/lean-hsmm.js";
import { logLeanKalmanLedger } from "../lean/lean-kalman.js";
import { logLeanMatchLedger } from "../lean/lean-match.js";
import { logLeanPassLedger } from "../lean/lean-passes.js";
import { logLeanRailLedger } from "../lean/lean-rail.js";
import { gateLedgers } from "../lean/ledger-verdict.js";
import {
	type CapturedDay,
	fixtureAnswersFromRows,
	inputsFromFixture,
	type OsmSource,
	parseCapturedDay,
} from "./fixture-day.js";
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
	/** Start times of EVERY ground-truth journey the narrative describes today,
	 *  matched or not. The ratchet needs both: a committed key still in this set
	 *  that is no longer matched is a regression and must keep failing, while one
	 *  that has left it belongs to a row that no longer exists — correcting a
	 *  narrative moves a journey's start, and the floor must follow rather than
	 *  hold a key nothing can ever satisfy again. */
	journeyAll: number[];
	/** Window starts of the rows whose verdict is `verified` — an enforceable
	 *  `correct` row the pipeline still satisfies. The truth floor's per-day set. */
	truthVerified: number[];
	/** Window starts of EVERY enforceable `correct` row the narrative states
	 *  today, satisfied or not — the truth floor's `described` set, playing the
	 *  same role `journeyAll` plays for journeys. A row honestly re-audited to
	 *  `wrong` leaves this set, which is what lets its floor key be dropped. */
	truthCorrect: number[];
	/** Window starts of the rows whose verdict is `regressed` — standing debt.
	 *  Not a failure on its own (the floor is what fails); reported so the debt
	 *  cannot go quiet. */
	truthRegressed: number[];
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
	const journeyAll = journeyResults.map((r) => r.startTs);
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
	return {
		text: lines.join("\n"),
		journeyMatched,
		journeyAll,
		truthVerified: res.verdicts.filter((v) => v.verdict === "verified").map((v) => v.row.startTs),
		// `verified | regressed` IS the enforceable-`correct` set: those are the
		// only two verdicts `rowVerdict` can give such a row.
		truthCorrect: res.verdicts
			.filter((v) => v.verdict === "verified" || v.verdict === "regressed")
			.map((v) => v.row.startTs),
		truthRegressed: res.verdicts.filter((v) => v.verdict === "regressed").map((v) => v.row.startTs),
	};
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
 *  visible, blessed into the ceiling rather than hidden.
 *
 *  AT ZERO since 2026-07-28 (#351 closed: the boarding anchor gained the
 *  membership veto its alight twin had carried since #377). A ceiling of zero
 *  enforces exactly like the hard-zero rail invariants — every occurrence is
 *  above it — while keeping `--bless-rail-triples` as the way a widened capture
 *  records genuinely new debt. The only difference from a bare assertion is
 *  that raising it leaves a reviewable diff in this file, which is the point.
 *  It is a physical law, so it belongs at zero and should stay there. */
const RAIL_TRIPLE_BASELINE_PATH = path.join(GOLDEN_DIR, "rail-triple-baseline.json");
/** Per-day set of ground-truth rows the pipeline still satisfies — the TRUTH
 *  FLOOR (#379). The narratives themselves are gitignored (real places, real
 *  times), so what is committed here is window starts only: enough to name a
 *  row, not enough to say anything about it.
 *
 *  Testimony, not law — so it ratchets rather than trending to zero. A
 *  confirmed row that stops holding is a regression and fails; a row that
 *  never held is standing debt, reported every run but not a failure, because
 *  new testimony revealing an old defect is a measurement, not a breakage. */
const TRUTH_BASELINE_PATH = path.join(GOLDEN_DIR, "truth-baseline.json");
/** Per-tenant set of UNEXPLAINED Lean divergence fingerprints — the ceiling
 *  that lets a tenant be staged in this gate while it still carries debt
 *  (#403).
 *
 *  `match` and `passes` were held out of the staged set for exactly one reason:
 *  both carry standing unexplained legs, so staging them failed the run on a
 *  pre-existing condition, and the only lever to hand was widening the
 *  accepted-delta manifests — which would have recorded "we checked this and it
 *  is fine" about legs nobody has checked. This file is the honest third
 *  option, and its entries mean the opposite of an accepted delta: NOT
 *  adjudicated, NOT permitted to grow.
 *
 *  Safe to commit — a `match` fingerprint is a hash of the quantised leg input
 *  and a `passes` one is `op/n/note`, so neither says where the user was. */
const LEAN_DELTA_BASELINE_PATH = path.join(GOLDEN_DIR, "lean-delta-baseline.json");

/**
 * Merge a fresh per-day count into a committed CEILING, keeping the ratchet
 * one-way: `min(committed, current)` per day.
 *
 * The gate's whole claim is that these ceilings "can only shrink", but until
 * 2026-07-27 the `--bless-*` flags wrote the current counts WHOLESALE — so a
 * bless run that fixed four days and left one red silently raised that day's
 * ceiling and the standing failure disappeared from the gate. A run may fix
 * some days without fixing all of them; blessing the wins must not also bless
 * the losses. A day above its ceiling keeps the lower committed value and goes
 * on failing until it is genuinely fixed.
 */
function ratchetDown(committed: FeasibilityBaseline | null, current: FeasibilityBaseline): FeasibilityBaseline {
	const ordered: FeasibilityBaseline = {};
	const dates = new Set([...Object.keys(committed ?? {}), ...Object.keys(current)]);
	for (const date of [...dates].sort()) {
		// A day MISSING from the committed baseline has a ceiling of ZERO —
		// that is how the gate reads it everywhere else (`baseline[date] ?? 0`),
		// so a newly-offending day cannot be blessed in by omission either.
		// `committed === null` is the distinct bootstrap case (no baseline file
		// at all): nothing to ratchet against, so the current counts establish
		// the first ceiling.
		const floor = committed === null ? (current[date] ?? 0) : Math.min(committed[date] ?? 0, current[date] ?? 0);
		if (floor > 0) ordered[date] = floor;
	}
	return ordered;
}

const args = process.argv.slice(2);
let bless = false;
let blessDate: string | null = null;
let blessJourneys = false;
let blessFeasibility = false;
let blessRailTriples = false;
let blessTruth = false;
let blessLeanDeltas = false;
/** Which OSM path to replay on. See `OsmSource` — `--osm trace` exists to
 *  attribute a corpus diff, by holding every other input fixed and varying
 *  only this. It is not a supported way to run the corpus. */
let osmSource: OsmSource = "rows";
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--osm") {
		const next = args[i + 1];
		if (next !== "rows" && next !== "trace") {
			console.error("--osm takes 'rows' or 'trace'");
			process.exit(2);
		}
		osmSource = next;
		i++;
		continue;
	}
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
	} else if (args[i] === "--bless-truth") {
		// Ratchet the truth floor UP to the current run: record which confirmed
		// ground-truth rows the pipeline now satisfies. Also the only way a row
		// re-audited from `correct` to `wrong` leaves the floor — and the run
		// names every key it drops, so a re-audit is a stated act rather than a
		// quiet one.
		blessTruth = true;
	} else if (args[i] === "--bless-lean-deltas") {
		// Ratchet the Lean delta ceiling DOWN onto the current run: drop the
		// fingerprints this run no longer produces. It can only shrink — a
		// divergence seen for the first time in the very run being blessed is
		// NOT recorded, so a change that fixes one leg and breaks another cannot
		// launder the breakage through the fix. Adding genuinely new standing
		// debt is a hand edit of the baseline, and is meant to be.
		blessLeanDeltas = true;
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

/** `null` = no ceiling file at all, the bootstrap case — deliberately distinct
 *  from an empty ceiling, which asserts every tenant is clean. */
async function loadLeanDeltaBaseline(): Promise<DeltaCeiling | null> {
	try {
		return JSON.parse(await readFile(LEAN_DELTA_BASELINE_PATH, "utf8")) as DeltaCeiling;
	} catch {
		return null;
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
/** Days whose kernel lookups came from pushed rows rather than the oracle. */
let fromRows = 0;
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
/** Every ground-truth journey each day DESCRIBES this run, matched or not. */
const journeysDescribed: JourneyBaseline = {};
/** Per-day set of confirmed truth rows the pipeline satisfies this run, the
 *  rows it states at all, and the ones it no longer satisfies (standing debt). */
const truthNow: FloorBaseline = {};
const truthDescribed: FloorBaseline = {};
const truthRegressedNow: FloorBaseline = {};
/** Days that produced a truth report at all. A day whose fixture THREW, or that
 *  has no narrative, measures nothing — and a floor gate cannot tell a silence
 *  from a regression, so those dates are excluded from the gate BY NAME rather
 *  than left to read as 100% regressed (the same trap as the aggregates that
 *  silently skip a throwing day). */
const truthReported = new Set<string>();

for (const file of files) {
	const full = path.join(DAYS_DIR, file);
	const captured = parseCapturedDay(await readFile(full, "utf8"));
	if (blessDate && captured.meta.date !== blessDate) continue;

	const label = `${captured.meta.date} ${captured.meta.user}${captured.meta.description ? ` — ${captured.meta.description}` : ""}`;

	let states: Awaited<ReturnType<typeof computeVelocityFromInputs>>["states"];
	let dayPoints: Awaited<ReturnType<typeof computeVelocityFromInputs>>["points"];
	let actual: ReturnType<typeof normalizeStates>;
	const dayInputs = inputsFromFixture(captured, osmSource);
	const answersFromRows = fixtureAnswersFromRows(captured) && osmSource === "rows";
	try {
		const result = await computeVelocityFromInputs(dayInputs);
		states = result.states;
		dayPoints = result.points;
		actual = normalizeStates(states, captured.meta.tz);
		// Counted only once the day actually replayed. Incremented before the
		// try, a refused day still scored as "answered from rows" while dropping
		// out of `checked`, and the summary read `33/31 … -2 still replaying`
		// (#408). Same shape as the truth cascade: a tally that survives the
		// thing it was counting.
		if (answersFromRows) fromRows++;
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
		journeysDescribed[captured.meta.date] = truth.journeyAll;
		truthReported.add(captured.meta.date);
		truthNow[captured.meta.date] = truth.truthVerified;
		truthDescribed[captured.meta.date] = truth.truthCorrect;
		if (truth.truthRegressed.length > 0) truthRegressedNow[captured.meta.date] = truth.truthRegressed;
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
// Every Lean tenant's ledger, whenever one is not `off`.
//
// Without this the corpus gate is read from SILENCE — no divergence warning
// printed — and silence is exactly what a bridge that failed and fell back to
// TS also produces, since both `shadow` and `on` swallow `LeanBridgeError`. A
// green 32/32 then means "the verified core was never consulted", which is the
// opposite of what it looks like. These lines make the call count and the
// failure count explicit, so the gate reports evidence rather than absence.
//
// Each returns its verdict as data as well as printing it, and `gateLedgers`
// turns that into part of this run's exit code — see the note on
// `unexercisable` below, and `ledger-verdict.ts` for why printing alone was
// not enough.
const leanVerdicts = [
	logLeanKalmanLedger("golden"),
	logLeanGpsQualityLedger("golden"),
	logLeanBioLabelsLedger("golden"),
	// `hsmm` and `rail` have had ledgers all along and were simply never called
	// here, so two of the seven tenants could serve the whole corpus and report
	// nothing.
	logLeanHsmmLedger("golden"),
	logLeanRailLedger("golden"),
	// `match` and `passes` had ledgers too — they were just private functions
	// inside `decode-day`, so the corpus gate could not reach them however much
	// it wanted to. Moved to their tenant modules alongside the other five.
	logLeanMatchLedger("golden"),
	logLeanPassLedger("golden"),
];
// Two tenants this corpus CANNOT exercise, both for the same reason and both by
// deliberate design rather than oversight: #233 made the corpus deterministic by
// replaying the cached decodes in `tests/golden/decoded_days` and preloading
// `rail_route_cache`, which is precisely to stop the decoder and the rail search
// from running at replay time. So a green golden has never been evidence about
// either of them, and staging them here must not be read as coverage.
//
// Written down rather than silently skipped: the run says so every time, and if
// the corpus ever grows a path that DOES reach one, the gate reports the waiver
// as stale instead of quietly continuing to excuse it.
const GOLDEN_UNEXERCISABLE: Record<string, string> = {
	hsmm: "the corpus replays cached decodes (#233), so the decoder never runs",
	rail: "the corpus preloads rail_route_cache (#233), so the Dijkstra never runs",
};
// The ceiling of un-adjudicated divergences (#403). Read BEFORE the gate runs,
// because it is what decides whether `match`/`passes` standing debt is a
// failure or a recorded note — the difference between those two is the whole
// reason both tenants could not be staged here.
const leanCeiling = await loadLeanDeltaBaseline();
const leanUnexplainedNow: DeltaCeiling = {};
for (const v of leanVerdicts) {
	if (v !== null && v.unexplained.length > 0) leanUnexplainedNow[v.tenant] = [...v.unexplained];
}
if (blessLeanDeltas) {
	const ordered = ratchetDownCeiling(leanCeiling, leanUnexplainedNow);
	await writeFile(LEAN_DELTA_BASELINE_PATH, `${JSON.stringify(ordered, null, "\t")}\n`, "utf8");
	console.log(
		`lean deltas: blessed ceiling — ${ceilingSize(ordered)} standing divergence(s) across ` +
			`${Object.keys(ordered).length} tenant(s).`,
	);
	process.exit(0);
}
const leanGate = gateLedgers(leanVerdicts, GOLDEN_UNEXERCISABLE, leanCeiling);
for (const n of leanGate.notes) console.log(`lean: ${n}`);
for (const f of leanGate.failures) console.log(`lean: FAIL — ${f}`);
const ceilingGate = gateDeltaCeiling(leanCeiling, leanUnexplainedNow);
if (leanCeiling === null && ceilingSize(leanUnexplainedNow) > 0) {
	console.log(
		`lean deltas: no ceiling yet — ${ceilingSize(leanUnexplainedNow)} unexplained divergence(s). ` +
			`Establish it with: npm run golden -- --bless-lean-deltas`,
	);
}
// `cleared` is never a failure — it is the ratchet's payoff, and naming it is
// what turns "the ceiling can shrink" from a claim into an instruction.
if (ceilingGate.cleared.length > 0) {
	console.log(
		`lean deltas: ${ceilingGate.cleared.length} standing divergence(s) gone — re-bless to ratchet the ceiling down (--bless-lean-deltas):`,
	);
	for (const c of ceilingGate.cleared) console.log(`      ✓ ${c.tenant}: ${c.fingerprint}`);
}
// Which side of the OSM port each fixture ran on. A day WITHOUT a captured
// row-set answered its kernel lookups from the recorded MariaDB answers — the
// oracle the port exists to remove — so a mixed corpus is a real state worth
// naming rather than something to be inferred from a diff.
console.log(
	fromRows === checked
		? `osm kernel: all ${checked} day(s) answered from pushed rows.`
		: `osm kernel: ${fromRows}/${checked} day(s) from pushed rows, ${checked - fromRows} still replaying captured answers.`,
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
	const ordered = ratchetDown(await loadFeasibilityBaseline(), kinematicNow);
	await writeFile(FEASIBILITY_BASELINE_PATH, `${JSON.stringify(ordered, null, "\t")}\n`, "utf8");
	const blessedTotal = Object.values(ordered).reduce((n, c) => n + c, 0);
	console.log(
		`feasibility (kinematic): blessed ceiling — ${blessedTotal} standing leg(s) across ${Object.keys(ordered).length} day(s).`,
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
	let committed: FeasibilityBaseline | null = null;
	try {
		committed = JSON.parse(await readFile(RAIL_TRIPLE_BASELINE_PATH, "utf8")) as FeasibilityBaseline;
	} catch {
		committed = null;
	}
	const ordered = ratchetDown(committed, railTripleNow);
	await writeFile(RAIL_TRIPLE_BASELINE_PATH, `${JSON.stringify(ordered, null, "\t")}\n`, "utf8");
	const blessedTotal = Object.values(ordered).reduce((n, c) => n + c, 0);
	console.log(
		`rail triples: blessed ceiling — ${blessedTotal} standing invalid leg(s) across ${Object.keys(ordered).length} day(s).`,
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

// --- truth ratchet --------------------------------------------------------
// The row-level counterpart of the journey floor, and the layer that had no
// gate at all until #379: a `correct {user}` ground-truth row is TESTIMONY, so
// it ratchets rather than trending to zero. Four confirmed rows rotted through
// a prod re-capture while the golden stayed green, because the truth report
// only ever printed them.
//
// The floor holds the rows the pipeline satisfies. A row that never held is
// not in the floor and does not fail — new testimony that reveals an old
// defect is a measurement, not a breakage — but it IS reported below every
// run, so standing debt cannot go quiet either.
let truthRegressedKeys = 0;
const truthStanding = Object.values(truthRegressedNow).reduce((n, a) => n + a.length, 0);
const truthHeld = Object.values(truthNow).reduce((n, a) => n + a.length, 0);
async function loadTruthBaseline(): Promise<FloorBaseline | null> {
	try {
		return JSON.parse(await readFile(TRUTH_BASELINE_PATH, "utf8")) as FloorBaseline;
	} catch {
		return null; // no baseline yet — first run bootstraps
	}
}
if (blessTruth) {
	const { floor, dropped } = ratchetUpFloor((await loadTruthBaseline()) ?? {}, truthNow, truthDescribed);
	await writeFile(TRUTH_BASELINE_PATH, `${JSON.stringify(floor, null, "\t")}\n`, "utf8");
	const blessedTotal = Object.values(floor).reduce((n, a) => n + a.length, 0);
	console.log(`truth: blessed floor — ${blessedTotal} confirmed row(s) across ${Object.keys(floor).length} day(s).`);
	// Naming the drops is the point: a row leaves the floor only by leaving the
	// narrative's `correct` set, which is exactly what an honest re-audit does
	// and exactly what "flip the row until the gate is green" does too. The gate
	// cannot tell them apart; stating each one out loud is what makes the
	// difference reviewable.
	for (const d of dropped)
		console.log(
			`      – dropped ${d.date} @${new Date(d.startTs * 1000).toISOString().slice(11, 16)}Z — no longer a confirmed row`,
		);
	process.exit(0);
}
const truthBaseline = await loadTruthBaseline();
if (truthBaseline === null) {
	console.log(
		`truth: no floor yet — ${truthHeld} confirmed row(s) held. Establish the floor with: npm run golden -- --bless-truth`,
	);
} else {
	// Only days that actually produced a truth report can be judged. A day whose
	// fixture threw, or whose narrative is gone, measures nothing — and to a
	// floor gate "measured nothing" is indistinguishable from "lost everything".
	// Excluded BY NAME rather than silently.
	// The day must leave BOTH sides. Dropping it only from `current` is what
	// `gateFloor` documents as the trap — an absent date reads as "satisfied
	// nothing", so every confirmed row on an unreplayable day reported as LOST
	// (#408: 26 rows across two days, two lines above a message naming those
	// same days as not measured). Nothing exercised this until an uncaptured
	// lookup started throwing, because before that every day was always
	// measured. A gate that claims 26 confirmed rows broke is one re-bless away
	// from destroying them.
	const measured: FloorBaseline = {};
	const measuredBaseline: FloorBaseline = {};
	const unmeasured: string[] = [];
	for (const date of Object.keys(truthBaseline)) {
		if (truthReported.has(date)) {
			measured[date] = truthNow[date] ?? [];
			measuredBaseline[date] = truthBaseline[date];
		} else unmeasured.push(date);
	}
	for (const [date, keys] of Object.entries(truthNow)) if (!(date in measured)) measured[date] = keys;
	const truthGate = gateFloor(measuredBaseline, measured);
	truthRegressedKeys = truthGate.regressed.length;
	if (truthRegressedKeys > 0) {
		console.log(`truth: FAIL — ${truthRegressedKeys} confirmed row(s) no longer hold:`);
		for (const r of truthGate.regressed)
			console.log(`      ✗ ${r.date} @${new Date(r.startTs * 1000).toISOString().slice(11, 16)}Z`);
	} else {
		console.log(`truth: ${truthHeld} confirmed row(s) held, none lost.`);
	}
	if (truthStanding > 0) {
		console.log(
			`truth: ${truthStanding} standing regressed row(s) across ${Object.keys(truthRegressedNow).length} day(s) — below the floor, reported not enforced.`,
		);
	}
	if (unmeasured.length > 0) {
		console.log(`truth: ${unmeasured.length} day(s) not measured this run, floor unchecked: ${unmeasured.join(", ")}`);
	}
	if (truthGate.improved.length > 0) {
		console.log(`truth: ${truthGate.improved.length} newly held — re-bless to ratchet the floor up (--bless-truth):`);
		for (const im of truthGate.improved)
			console.log(`      ✓ ${im.date} @${new Date(im.startTs * 1000).toISOString().slice(11, 16)}Z`);
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
	// Ratchet UP, the mirror of `ratchetDown`: the floor is the UNION of the
	// committed journeys and the ones this run reconstructed. A journey that
	// used to work and no longer does stays in the floor, so blessing the new
	// wins cannot quietly drop it — the regression keeps failing the gate
	// until it is actually fixed.
	// Keep a committed journey ONLY while the ground truth still describes it —
	// see `ratchetUpFloor`, which owns that rule for both floors.
	const { floor, dropped } = ratchetUpFloor(await loadJourneyBaseline(), journeysNow, journeysDescribed);
	await writeFile(JOURNEY_BASELINE_PATH, `${JSON.stringify(floor, null, "\t")}\n`, "utf8");
	const blessedTotal = Object.values(floor).reduce((n, a) => n + a.length, 0);
	console.log(
		`journeys: blessed floor — ${blessedTotal} journey(s) across ${Object.keys(floor).length} day(s): everything reconstructed now, plus every committed journey the ground truth still describes.`,
	);
	for (const d of dropped)
		console.log(
			`      – dropped ${d.date} @${new Date(d.startTs * 1000).toISOString().slice(11, 16)}Z — the narrative no longer describes it`,
		);
	process.exit(0);
}

const baseline = await loadJourneyBaseline();
// Same exclusion as the truth floor above, for the same reason: a day the
// replay refused reconstructed no journeys, and charging its floor entries as
// regressions reports a failure about work that never ran (#408). `truthReported`
// is the right predicate — it is set from the same successful replay that fills
// `journeysNow`.
const journeyBaselineMeasured: JourneyBaseline = {};
const journeysUnmeasured: string[] = [];
for (const [date, keys] of Object.entries(baseline)) {
	if (truthReported.has(date)) journeyBaselineMeasured[date] = keys;
	else journeysUnmeasured.push(date);
}
const gate = gateJourneys(journeyBaselineMeasured, journeysNow);
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
if (journeysUnmeasured.length > 0) {
	console.log(
		`journeys: ${journeysUnmeasured.length} day(s) not measured this run, floor unchecked: ${journeysUnmeasured.join(", ")}`,
	);
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
		truthRegressedKeys > 0 ||
		gate.regressed.length > 0 ||
		// Costs nothing when every tenant is `off`, which is the default and what
		// CI runs — `gateLedgers` sees five nulls and returns no failures.
		leanGate.failures.length > 0 ||
		// Redundant with `leanGate.failures` for any tenant that fingerprints its
		// divergences, and deliberately so: this catches a fingerprint arriving
		// under a tenant the gate never judged — a ceiling entry outliving the
		// tenant that produced it, or a new tenant appearing with debt already.
		ceilingGate.fresh.length > 0
		? 1
		: 0,
);
