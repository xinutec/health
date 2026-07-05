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
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseGroundTruth } from "../eval/ground-truth.js";
import { decoderJourneys, groundTruthJourneys, scoreJourneys } from "../eval/journey-score.js";
import { type DecoderMinute, scoreDay } from "../eval/score-day.js";
import { decodeHsmm } from "../hmm/decode.js";
import type { HmmSegment } from "../hmm/persist.js";
import { type HsmmCapturedDay, hsmmInputsFromFixture } from "./hsmm-fixture.js";

const DECODED_DIR = path.join(process.cwd(), "tests", "golden", "decoded_days");
const GROUND_TRUTH_DIR = path.join(process.cwd(), "tests", "golden", "ground-truth");

/** Expand decode segments to the per-minute shape the scorers consume. */
function segmentsToMinutes(segs: readonly HmmSegment[]): DecoderMinute[] {
	const minutes: DecoderMinute[] = [];
	for (const s of segs) {
		for (let t = s.startTs; t < s.endTs; t += 60) {
			minutes.push({ ts: t, mode: s.mode, placeId: s.placeId, lineName: s.lineName });
		}
	}
	return minutes;
}

function pct(n: number, d: number): string {
	return d === 0 ? "  n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

/** Compact one-line shape of a journey's legs, e.g. "walking → train:Jubilee Line → walking". */
function journeyShape(legs: readonly { mode: string; line: string | null }[]): string {
	return legs.map((l) => l.mode + (l.line !== null ? `:${l.line}` : "")).join(" → ");
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const onlyDate = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? null;
	const verbose = args.includes("--verbose") || args.includes("-v");

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

	for (const file of files) {
		const captured = JSON.parse(readFileSync(path.join(DECODED_DIR, file), "utf8")) as HsmmCapturedDay;
		const date = captured.meta.date;
		if (onlyDate !== null && date !== onlyDate) continue;

		const gtPath = path.join(GROUND_TRUTH_DIR, `${date}.md`);
		if (!existsSync(gtPath)) {
			console.log(`SKIP  ${date} — no ground-truth narrative`);
			continue;
		}

		const minutes = segmentsToMinutes(decodeHsmm(hsmmInputsFromFixture(captured)));
		const gt = parseGroundTruth(readFileSync(gtPath, "utf8"), date, captured.meta.tz);
		// Place-name → id from the fixture's own focus places (displayName).
		const placeNameToId = new Map<string, number>();
		for (const p of captured.inputs.places) {
			if (p.displayName !== null) placeNameToId.set(p.displayName.toLowerCase(), p.id);
		}
		const s = scoreDay(gt.rows, minutes, placeNameToId);
		const j = scoreJourneys(gt.rows, minutes);
		scoredDays++;

		console.log(
			`\n## ${date}  (per-minute)  mode ${s.modeMatching}/${s.scorableMinutes} ${pct(s.modeMatching, s.scorableMinutes)} · place ${s.placeMatching}/${s.placeScorable} ${pct(s.placeMatching, s.placeScorable)} · line ${s.lineMatching}/${s.lineScorable} ${pct(s.lineMatching, s.lineScorable)}`,
		);
		console.log(
			`   (journey)  trips ${j.journeysModeSequenceMatched}/${j.journeysExpected} ${pct(j.journeysModeSequenceMatched, j.journeysExpected)} · legs-mode ${j.legModeMatching}/${j.legModeScorable} ${pct(j.legModeMatching, j.legModeScorable)} · legs-line ${j.legLineMatching}/${j.legLineScorable} ${pct(j.legLineMatching, j.legLineScorable)}`,
		);

		if (verbose) {
			const gtJ = groundTruthJourneys(gt.rows);
			const decJ = decoderJourneys(minutes);
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
	process.exit(0);
}

await main();
