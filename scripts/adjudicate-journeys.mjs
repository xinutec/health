/**
 * Adjudication dossier for broken journeys (#257 measured build).
 *
 * For every ground-truth journey the pipeline does NOT reconstruct, print its
 * ground-truth rows and the pipeline's drawn states SIDE BY SIDE in the same
 * window (± a 12-min margin to show the bounding stays). This is the evidence
 * needed to classify each failure as a genuine mode error vs a journey-boundary
 * / over-split artifact — without which the "first factor" can't be chosen
 * honestly. Zero DB: replays the golden fixtures like `npm run golden`.
 *
 *   node scripts/adjudicate-journeys.mjs            # every day
 *   node scripts/adjudicate-journeys.mjs 2026-06-29 # one day
 */
import { readdirSync, readFileSync } from "node:fs";
import { parseGroundTruth } from "../dist/eval/ground-truth.js";
import { groundTruthJourneys, journeyShapeResults, statesToJourneys } from "../dist/eval/journey-score.js";
import { FixtureOsmAdapter } from "../dist/geo/osm-adapter-fixture.js";
import { computeVelocityFromInputs } from "../dist/geo/velocity.js";
import { inputsFromFixture, parseCapturedDay } from "../dist/cli/fixture-day.js";

const only = process.argv[2] ?? null;
const hm = (ts) => new Date(ts * 1000).toISOString().slice(11, 16);
const MARGIN = 12 * 60;

const days = readdirSync("tests/golden/days")
	.filter((f) => f.endsWith("-pippijn.json"))
	.map((f) => f.slice(0, 10))
	.filter((d) => !only || d === only)
	.sort();

for (const date of days) {
	let md;
	try {
		md = readFileSync(`tests/golden/ground-truth/${date}.md`, "utf8");
	} catch {
		continue;
	}
	const cap = parseCapturedDay(readFileSync(`tests/golden/days/${date}-pippijn.json`, "utf8"));
	const inp = { ...inputsFromFixture(cap), osm: new FixtureOsmAdapter(cap.inputs.osmTrace) };
	const v = await computeVelocityFromInputs(inp, { walkMatch: true });
	const gt = parseGroundTruth(md, date, cap.meta.tz);
	const gtJourneys = groundTruthJourneys(gt.rows);
	const results = journeyShapeResults(gtJourneys, statesToJourneys(v.states));

	const broken = results.filter((r) => !r.matched);
	if (broken.length === 0) continue;
	console.log(`\n==================== ${date} : ${broken.length} broken journey(s) ====================`);

	for (const r of broken) {
		const j = gtJourneys.find((g) => g.startTs === r.startTs);
		const lo = r.startTs - MARGIN;
		const hi = r.endTs + MARGIN;
		console.log(`\n  JOURNEY ${hm(r.startTs)}-${hm(r.endTs)}  expected [${r.expectedShape.join(",")}]  got [${(r.actualShape ?? []).join(",")}]`);
		console.log(`  --- ground truth (rows in window ±12m) ---`);
		for (const row of gt.rows) {
			if (row.endTs <= lo || row.startTs >= hi) continue;
			const inJ = j && row.startTs >= j.startTs && row.endTs <= j.endTs ? " *" : "  ";
			console.log(`   ${inJ}${hm(row.startTs)}-${hm(row.endTs)}  ${row.status.padEnd(7)}  ${row.blessedText}`);
		}
		console.log(`  --- pipeline drew ---`);
		for (const s of v.states) {
			if (s.endTs <= lo || s.startTs >= hi) continue;
			console.log(`     ${hm(s.startTs)}-${hm(s.endTs)}  ${s.mode.padEnd(10)}  ${s.place ?? s.wayName ?? ""}`);
		}
	}
}
process.exit(0);
