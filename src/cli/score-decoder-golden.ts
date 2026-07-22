/**
 * CLI: score the REAL HSMM decoder against ground truth — zero DB, zero
 * network, deterministic.
 *
 * The other eval CLI (`compare-vs-ground-truth.js --source hsmm`) runs a
 * *divergent inline copy* of the decode that predates the train-generator
 * prior and the proximity inputs, and it needs a live DB. This harness
 * instead replays each captured `decoded_days` fixture through the canonical
 * `decodeHsmm` (the exact production decode, incl. the train soft prior and
 * the osm_points station fix) and scores the result against the day's
 * user-confirmed ground-truth narrative with BOTH the per-minute scorer and
 * the journey-level scorer.
 *
 * This is the missing measurement: how good is the decoder we are actually
 * building — the truth-engine's central bet that it beats the heuristic
 * pipeline. It runs from any commit with no tunnel:
 *
 *   npm run score-decoder            # every captured day that has ground truth
 *   node dist/cli/score-decoder-golden.js --date 2026-05-22
 *
 * Fixtures + narratives are gitignored real data; the harness skips a
 * captured day with no ground-truth file, and exits 2 when there is no
 * corpus at all.
 *
 * C4.0 scoreboard ratchet: per-day journey-structure scores (trips,
 * legs, stations, phantom rides) are compared against the tracked
 * baseline `tests/golden/decoder-scoreboard.json` (dates + counts only —
 * no journey content). A C4 workstream ships only when the scoreboard
 * improves and nothing regresses; `--bless-scoreboard` records the new
 * baseline after adjudication.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { countPhantomRides, scoreStations } from "../eval/decoder-scoreboard.js";
import { parseGroundTruth } from "../eval/ground-truth.js";
import { decoderJourneys, groundTruthJourneys, scoreJourneys } from "../eval/journey-score.js";
import { type DecoderMinute, scoreDay } from "../eval/score-day.js";
import {
	useCadenceImputation,
	useChainContext,
	useReacquireRobustSpeed,
	useSegmentEvidence,
} from "../geo/factors/feature-flag.js";
import { decodeHsmm } from "../hmm/decode.js";
import type { HmmSegment } from "../hmm/persist.js";
import { type HsmmCapturedDay, hsmmInputsFromFixture } from "./hsmm-fixture.js";

const DECODED_DIR = path.join(process.cwd(), "tests", "golden", "decoded_days");
const GROUND_TRUTH_DIR = path.join(process.cwd(), "tests", "golden", "ground-truth");
const SCOREBOARD_PATH = path.join(process.cwd(), "tests", "golden", "decoder-scoreboard.json");

/** One day's journey-structure scores — the tracked ratchet unit. Counts
 *  only (dates are the keys); narrative content never enters the file. */
interface DayScoreboard {
	journeysExpected: number;
	journeysMatched: number;
	legModeScorable: number;
	legModeMatching: number;
	legLineScorable: number;
	legLineMatching: number;
	stationsAsserted: number;
	stationsMatching: number;
	stationsMissing: number;
	phantomRides: number;
}

/** Fields where MORE is better / fewer is a regression. */
const GAIN_FIELDS = ["journeysMatched", "legModeMatching", "legLineMatching", "stationsMatching"] as const;
/** Fields that define what was measured — a change means the narrative
 *  or fixture changed, which needs re-adjudication, not a silent pass. */
const DENOMINATOR_FIELDS = ["journeysExpected", "legModeScorable", "legLineScorable", "stationsAsserted"] as const;

/** Compare a run against the blessed baseline. Returns human-readable
 *  problem lines; empty = ratchet clean. */
function compareScoreboard(
	baseline: Record<string, DayScoreboard>,
	current: Record<string, DayScoreboard>,
): { problems: string[]; improvements: string[] } {
	const problems: string[] = [];
	const improvements: string[] = [];
	for (const [date, base] of Object.entries(baseline)) {
		const cur = current[date];
		if (cur === undefined) {
			problems.push(`${date}: in baseline but not scored (fixture or narrative gone)`);
			continue;
		}
		// dev-lint: allow-field-identity-eq every DayScoreboard field is a
		// number (the key unions are keyof-constrained), so identity equality
		// is exact — no array/object field can reach these comparisons.
		for (const f of DENOMINATOR_FIELDS) {
			if (cur[f] !== base[f]) problems.push(`${date}: ${f} ${base[f]} → ${cur[f]} (measurement changed — re-bless)`);
		}
		for (const f of GAIN_FIELDS) {
			if (cur[f] < base[f]) problems.push(`${date}: ${f} regressed ${base[f]} → ${cur[f]}`);
			else if (cur[f] > base[f]) improvements.push(`${date}: ${f} ${base[f]} → ${cur[f]}`);
		}
		// `missing` is not ratcheted on its own: wrong → missing is an
		// improvement (the decoder stops lying). What must never rise is
		// WRONG stations — asserted − matching − missing.
		const baseWrong = base.stationsAsserted - base.stationsMatching - base.stationsMissing;
		const curWrong = cur.stationsAsserted - cur.stationsMatching - cur.stationsMissing;
		if (curWrong > baseWrong) problems.push(`${date}: wrong stations rose ${baseWrong} → ${curWrong}`);
		else if (curWrong < baseWrong) improvements.push(`${date}: wrong stations ${baseWrong} → ${curWrong}`);
		if (cur.phantomRides > base.phantomRides)
			problems.push(`${date}: phantomRides rose ${base.phantomRides} → ${cur.phantomRides}`);
		else if (cur.phantomRides < base.phantomRides)
			improvements.push(`${date}: phantomRides ${base.phantomRides} → ${cur.phantomRides}`);
	}
	for (const date of Object.keys(current)) {
		if (!(date in baseline)) problems.push(`${date}: scored but not in baseline (new day — bless to record it)`);
	}
	return { problems, improvements };
}

/** Expand decode segments to the per-minute shape the scorers consume. */
function segmentsToMinutes(segs: readonly HmmSegment[]): DecoderMinute[] {
	const minutes: DecoderMinute[] = [];
	for (const s of segs) {
		for (let t = s.startTs; t < s.endTs; t += 60) {
			minutes.push({
				ts: t,
				mode: s.mode,
				placeId: s.placeId,
				lineName: s.lineName,
				board: s.boardStation ?? null,
				alight: s.alightStation ?? null,
			});
		}
	}
	return minutes;
}

function pct(n: number, d: number): string {
	return d === 0 ? "  n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

/** Compact one-line shape of a journey's legs, e.g.
 *  "walking → train:Jubilee Line [Wembley Park→Baker Street] → walking". */
function journeyShape(
	legs: readonly { mode: string; line: string | null; board: string | null; alight: string | null }[],
): string {
	return legs
		.map((l) => {
			const line = l.line !== null ? `:${l.line}` : "";
			const st = l.board !== null || l.alight !== null ? ` [${l.board ?? "?"}→${l.alight ?? "?"}]` : "";
			return l.mode + line + st;
		})
		.join(" → ");
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const onlyDate = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? null;
	const verbose = args.includes("--verbose") || args.includes("-v");
	const blessScoreboard = args.includes("--bless-scoreboard");

	let files: string[];
	try {
		files = readdirSync(DECODED_DIR)
			.filter((f) => f.endsWith(".json"))
			.sort();
	} catch {
		console.error(`no corpus at ${DECODED_DIR} — capture one with capture-hsmm-day.js`);
		process.exit(2);
	}

	let tScorable = 0;
	let tModeMatch = 0;
	let tPlaceScorable = 0;
	let tPlaceMatch = 0;
	let tLineScorable = 0;
	let tLineMatch = 0;
	let tJourneys = 0;
	let tJourneySeq = 0;
	let tLegMode = 0;
	let tLegModeMatch = 0;
	let tLegLine = 0;
	let tLegLineMatch = 0;
	let scoredDays = 0;
	const scoreboard: Record<string, DayScoreboard> = {};

	for (const file of files) {
		const captured = JSON.parse(readFileSync(path.join(DECODED_DIR, file), "utf8")) as HsmmCapturedDay;
		const date = captured.meta.date;
		if (onlyDate !== null && date !== onlyDate) continue;

		const gtPath = path.join(GROUND_TRUTH_DIR, `${date}.md`);
		if (!existsSync(gtPath)) {
			console.log(`SKIP  ${date} — no ground-truth narrative`);
			continue;
		}

		// Each day decodes under the configuration its fixture records — for a
		// v1 fixture, production's (see `decodeFlagsFor`). The env vars stay as
		// an EXPLICIT A/B override for shadow-measuring a candidate flag
		// (`USE_CADENCE_IMPUTATION=1 npm run score-decoder`), but they no longer
		// decide the default.
		//
		// They used to. The baseline was blessed "with the four continuity flags
		// on" (2026-07-17) while a bare `npm run score-decoder` still decoded
		// with all four OFF, so the ratchet reported eleven regressions across
		// six days — including 2026-06-12 losing both matched journeys and
		// gaining a phantom ride. None were real: with the flags on the ratchet
		// passes and every aggregate metric beats the baseline. A scoring tool
		// that measures a configuration nobody runs cannot be believed in either
		// direction. See `feedback_parity_tools_must_mirror_env`.
		const fixtureInputs = hsmmInputsFromFixture(captured);
		const envOr = (name: string, read: () => boolean, fromFixture: boolean | undefined): boolean =>
			process.env[name] === undefined ? fromFixture === true : read();
		const minutes = segmentsToMinutes(
			decodeHsmm({
				...fixtureInputs,
				imputeCadence: envOr("USE_CADENCE_IMPUTATION", useCadenceImputation, fixtureInputs.imputeCadence),
				segmentEvidence: envOr("USE_SEGMENT_EVIDENCE", useSegmentEvidence, fixtureInputs.segmentEvidence),
				chainContext: envOr("USE_CHAIN_CONTEXT", useChainContext, fixtureInputs.chainContext),
				reacquireRobustSpeed: envOr(
					"USE_REACQUIRE_ROBUST_SPEED",
					useReacquireRobustSpeed,
					fixtureInputs.reacquireRobustSpeed,
				),
			}),
		);
		const gt = parseGroundTruth(readFileSync(gtPath, "utf8"), date, captured.meta.tz);
		// Place-name → id from the fixture's own focus places (displayName).
		const placeNameToId = new Map<string, number>();
		for (const p of captured.inputs.places) {
			if (p.displayName !== null) placeNameToId.set(p.displayName.toLowerCase(), p.id);
		}
		const s = scoreDay(gt.rows, minutes, placeNameToId);
		const j = scoreJourneys(gt.rows, minutes);
		const gtJ = groundTruthJourneys(gt.rows);
		const decJ = decoderJourneys(minutes);
		const st = scoreStations(gtJ, decJ);
		const phantoms = countPhantomRides(gt.rows, decJ);
		scoreboard[date] = {
			journeysExpected: j.journeysExpected,
			journeysMatched: j.journeysModeSequenceMatched,
			legModeScorable: j.legModeScorable,
			legModeMatching: j.legModeMatching,
			legLineScorable: j.legLineScorable,
			legLineMatching: j.legLineMatching,
			stationsAsserted: st.stationsAsserted,
			stationsMatching: st.stationsMatching,
			stationsMissing: st.stationsMissing,
			phantomRides: phantoms,
		};
		scoredDays++;

		console.log(
			`\n## ${date}  (per-minute)  mode ${s.modeMatching}/${s.scorableMinutes} ${pct(s.modeMatching, s.scorableMinutes)} · place ${s.placeMatching}/${s.placeScorable} ${pct(s.placeMatching, s.placeScorable)} · line ${s.lineMatching}/${s.lineScorable} ${pct(s.lineMatching, s.lineScorable)}`,
		);
		console.log(
			`   (journey)  trips ${j.journeysModeSequenceMatched}/${j.journeysExpected} ${pct(j.journeysModeSequenceMatched, j.journeysExpected)} · legs-mode ${j.legModeMatching}/${j.legModeScorable} ${pct(j.legModeMatching, j.legModeScorable)} · legs-line ${j.legLineMatching}/${j.legLineScorable} ${pct(j.legLineMatching, j.legLineScorable)}`,
		);
		const stWrong = st.stationsAsserted - st.stationsMatching - st.stationsMissing;
		console.log(
			`   (structure) stations ${st.stationsMatching}/${st.stationsAsserted} matched, ${st.stationsMissing} missing, ${stWrong} wrong · phantom rides ${phantoms}`,
		);

		if (verbose) {
			console.log("   GT  journeys (the truth):");
			for (const jj of gtJ) console.log(`     · ${journeyShape(jj.legs)}`);
			console.log("   DEC journeys (decoder):");
			for (const jj of decJ) console.log(`     · ${journeyShape(jj.legs)}`);
		}

		tScorable += s.scorableMinutes;
		tModeMatch += s.modeMatching;
		tPlaceScorable += s.placeScorable;
		tPlaceMatch += s.placeMatching;
		tLineScorable += s.lineScorable;
		tLineMatch += s.lineMatching;
		tJourneys += j.journeysExpected;
		tJourneySeq += j.journeysModeSequenceMatched;
		tLegMode += j.legModeScorable;
		tLegModeMatch += j.legModeMatching;
		tLegLine += j.legLineScorable;
		tLegLineMatch += j.legLineMatching;
	}

	if (scoredDays === 0) {
		console.error(onlyDate ? `no scorable fixture for ${onlyDate}` : "no fixtures had ground-truth narratives");
		process.exit(2);
	}

	console.log(`\n## AGGREGATE — real decodeHsmm vs ground truth (${scoredDays} days)`);
	console.log(
		`  per-minute  mode ${tModeMatch}/${tScorable} ${pct(tModeMatch, tScorable)} · place ${tPlaceMatch}/${tPlaceScorable} ${pct(tPlaceMatch, tPlaceScorable)} · line ${tLineMatch}/${tLineScorable} ${pct(tLineMatch, tLineScorable)}`,
	);
	console.log(
		`  journey     trips ${tJourneySeq}/${tJourneys} ${pct(tJourneySeq, tJourneys)} · legs-mode ${tLegModeMatch}/${tLegMode} ${pct(tLegModeMatch, tLegMode)} · legs-line ${tLegLineMatch}/${tLegLine} ${pct(tLegLineMatch, tLegLine)}`,
	);

	// Scoreboard ratchet — full-corpus runs only (a --date run would
	// misreport every other baseline day as vanished).
	if (onlyDate === null) {
		if (blessScoreboard) {
			const sorted = Object.fromEntries(Object.entries(scoreboard).sort(([a], [b]) => a.localeCompare(b)));
			writeFileSync(SCOREBOARD_PATH, `${JSON.stringify(sorted, null, "\t")}\n`, "utf8");
			console.log(`\nscoreboard blessed → ${SCOREBOARD_PATH} (${scoredDays} days)`);
		} else if (existsSync(SCOREBOARD_PATH)) {
			const baseline = JSON.parse(readFileSync(SCOREBOARD_PATH, "utf8")) as Record<string, DayScoreboard>;
			const { problems, improvements } = compareScoreboard(baseline, scoreboard);
			for (const line of improvements) console.log(`  IMPROVED  ${line}`);
			if (improvements.length > 0 && problems.length === 0)
				console.log("  scoreboard improved — bless with --bless-scoreboard to ratchet the gains");
			if (problems.length > 0) {
				for (const line of problems) console.error(`  SCOREBOARD  ${line}`);
				console.error("  scoreboard ratchet FAILED — fix the regression or re-bless with adjudication");
				process.exit(1);
			}
			console.log(`  scoreboard ratchet OK (${Object.keys(baseline).length} days)`);
		} else {
			console.log(`\nno scoreboard baseline at ${SCOREBOARD_PATH} — record one with --bless-scoreboard`);
		}
	}
	process.exit(0);
}

await main();
