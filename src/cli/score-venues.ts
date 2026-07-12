/**
 * CLI: venue-attribution referee (phase V0 of
 * `docs/proposals/2026-07-venue-measurement-model.md`).
 *
 * Replays every golden fixture through the pure classification core with a
 * trace sink installed on the venue scorer, joins each venue decision to the
 * ground-truth narrative for that day, and reports how the scorer did:
 *
 *   - accuracy on the stays the narratives name,
 *   - how often the `NEAR_FIELD_DECISIVE_M` short-circuit decided a stay
 *     instead of the summed evidence, and how often it was wrong to,
 *   - for every miss: whether the true venue was even a candidate, where it
 *     ranked, and how many nats behind — the difference between a tuning
 *     problem and a mirror/geometry problem.
 *
 * This is the number V1–V4 have to move. It is deliberately NOT a gate: it
 * reports, it does not fail. The gate is `scripts/golden.sh` (a confirmed
 * label must not regress) — this tells you WHY a number moved.
 *
 * Deterministic: same fixtures, same OSM trace, same answer. No DB, no
 * network. Usage:
 *
 *   scripts/score-venues.sh                  # the corpus report
 *   scripts/score-venues.sh --verbose        # every case, not just the misses
 *   scripts/score-venues.sh --json out.json  # dump the cases for analysis
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseGroundTruth } from "../eval/ground-truth.js";
import {
	fixSpreadM,
	median,
	reportVenues,
	type VenueCase,
	type VenueCaseResult,
	venueNameMatches,
} from "../eval/venue-referee.js";
import type { RawPhonetrackFix } from "../geo/classification-inputs.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { setVenueTraceSink, type VenueDecisionTrace } from "../geo/venue-trace.js";
import { inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

const GOLDEN_DIR = path.join(process.cwd(), "tests", "golden");
const DAYS_DIR = path.join(GOLDEN_DIR, "days");
const GROUND_TRUTH_DIR = path.join(GOLDEN_DIR, "ground-truth");

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const jsonAt = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

const hhmm = (unix: number, tz: string): string =>
	new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(
		new Date(unix * 1000),
	);

/** Seconds of overlap between two half-open windows. */
const overlap = (a: [number, number], b: [number, number]): number =>
	Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

let files: string[];
try {
	files = (await readdir(DAYS_DIR)).filter((f) => f.endsWith(".json")).sort();
} catch {
	files = [];
}
if (files.length === 0) {
	console.error(`No golden fixtures at ${DAYS_DIR}. Capture one: npm run capture-golden -- <date> <user> <tz>`);
	process.exit(2);
}

const cases: VenueCase[] = [];
/** Stays the narrative names after a mined focus place (Home, Work, …). The
 *  venue scorer is not the component that answers those — a focus place
 *  overrides it downstream — so counting them here would measure the wrong
 *  thing. Reported as a count so the exclusion is visible, never silent. */
let focusPlaceStays = 0;
let daysWithTruth = 0;

for (const file of files) {
	const captured = parseCapturedDay(await readFile(path.join(DAYS_DIR, file), "utf8"));
	const { date, tz } = captured.meta;

	let md: string;
	try {
		md = await readFile(path.join(GROUND_TRUTH_DIR, `${date}.md`), "utf8");
	} catch {
		continue; // no narrative — nothing to adjudicate against
	}
	const gt = parseGroundTruth(md, date, tz);
	const namedStays = gt.rows.filter(
		(r) => (r.truth?.mode === "stationary" || r.truth?.mode === "sleeping") && r.truth.place,
	);
	if (namedStays.length === 0) continue;
	daysWithTruth++;

	const traces: VenueDecisionTrace[] = [];
	const restore = setVenueTraceSink((t) => {
		if (t.stay) traces.push(t);
	});
	const inputs = inputsFromFixture(captured);
	let states: Awaited<ReturnType<typeof computeVelocityFromInputs>>["states"];
	try {
		({ states } = await computeVelocityFromInputs(inputs));
	} finally {
		restore();
	}

	const fixes: RawPhonetrackFix[] = inputs.phonetrack.today;
	const focusNames = inputs.knownPlaces.map((p) => p.displayName ?? p.amenityLabel ?? "").filter((n) => n.length > 0);

	for (const row of namedStays) {
		const truthPlace = row.truth?.place as string;
		// A stay the narrative names after a mined focus place (Home, Work) is
		// answered by the focus-place layer by construction. Counting those
		// would measure the wrong thing — and drown the venue signal in easy
		// wins. Excluded, but counted, so the exclusion is never silent.
		if (focusNames.some((n) => venueNameMatches(truthPlace, n))) {
			focusPlaceStays++;
			continue;
		}

		// The venue decision that survived for this stay: the LAST trace whose
		// window overlaps the truth row (later passes, e.g. the jitter-stay
		// consolidator, re-resolve a stay and their answer is the one that
		// reaches the timeline). No trace at all = the venue scorer never ran,
		// which is a finding, not a reason to drop the case.
		const overlapping = traces.filter(
			(t) => t.stay && overlap([t.stay.startUnix, t.stay.endUnix], [row.startTs, row.endTs]) > 0,
		);
		const trace = overlapping[overlapping.length - 1] ?? null;

		// What the TIMELINE ends up saying — the user-visible answer, after
		// every override. `placeLabel` appends a "(subtype)" qualifier; strip it.
		const mid = (row.startTs + row.endTs) / 2;
		const state = states.find((s) => s.startTs <= mid && mid < s.endTs);
		const finalPlace = (state?.place ?? null)?.replace(/\s*\([^)]*\)\s*$/, "") ?? null;

		const layer = !finalPlace
			? "other"
			: focusNames.some((n) => venueNameMatches(finalPlace, n))
				? "focus-place"
				: trace?.accepted && venueNameMatches(finalPlace, trace.ranked[0].landmark.name)
					? "scorer"
					: "other";

		const win: [number, number] = trace?.stay ? [trace.stay.startUnix, trace.stay.endUnix] : [row.startTs, row.endTs];
		const inWindow = fixes.filter((f) => f.ts >= win[0] && f.ts < win[1]);
		const accs = inWindow.map((f) => f.accuracy).filter((a): a is number => a != null);
		cases.push({
			date,
			window: `${hhmm(win[0], tz)}–${hhmm(win[1], tz)}`,
			durationSec: win[1] - win[0],
			truthPlace,
			finalPlace,
			layer,
			ranked: trace?.ranked ?? [],
			accepted: trace?.accepted ?? false,
			fixSpreadM: fixSpreadM(inWindow),
			medianAccM: median(accs),
		});
	}
}

const report = reportVenues(cases);

const pct = (n: number, of: number): string => (of === 0 ? "—" : `${((100 * n) / of).toFixed(0)}%`);
const m = (v: number | null): string => (v == null ? "—" : `${v.toFixed(0)}m`);

const describe = (r: VenueCaseResult): string => {
	const c = r.case;
	const gps = `spread ${m(c.fixSpreadM)}, acc ${m(c.medianAccM)}`;
	const head = `  ${c.date} ${c.window} (${Math.round(c.durationSec / 60)}min, ${gps}) [${c.layer}]`;
	const want = `truth "${c.truthPlace}"`;
	if (r.verdict === "correct")
		return `${head}\n      ✓ ${want} — named "${r.chosen}"${r.wonByNearField ? " [near-field]" : ""}`;
	if (r.verdict === "declined")
		return `${head}\n      · ${want} — NO venue named (nothing cleared the floor)${r.truthRank != null ? `; truth was candidate #${r.truthRank + 1}` : ""}`;
	const why =
		c.ranked.length === 0
			? "the venue scorer NEVER RAN on this stay — the label came from another layer, so no ranking change can reach it"
			: r.truthRank == null
				? "truth was NOT a candidate — unreachable by any ranking change (mirror/geometry)"
				: r.blockedByNearField
					? `truth ranked #${r.truthRank + 1} and OUTSCORED the winner by ${(-(r.truthGapNats as number)).toFixed(2)} nats — lost ONLY to the near-field short-circuit`
					: `truth ranked #${r.truthRank + 1}, ${(r.truthGapNats as number).toFixed(2)} nats behind${r.wonByNearField ? " (winner took near-field)" : ""}`;
	return `${head}\n      ✗ ${want} — named "${r.chosen}"; ${why}`;
};

console.log(
	`\nvenue-attribution referee — ${cases.length} named stay(s) across ${daysWithTruth} day(s) with narratives`,
);
console.log(`  excluded: ${focusPlaceStays} stay(s) the narrative names after a mined focus place (Home, Work — the`);
console.log(`            focus-place layer answers those by construction; counting them would measure nothing)\n`);

for (const r of report.results) {
	if (verbose || r.verdict !== "correct") console.log(describe(r));
}

const layerLine = (name: "scorer" | "focus-place" | "other"): string => {
	const l = report.byLayer[name];
	return `    ${name.padEnd(12)} ${String(l.correct).padStart(2)}/${String(l.total).padEnd(2)}  (${pct(l.correct, l.total)})`;
};

console.log(`
  correct           ${report.correct}/${report.total}  (${pct(report.correct, report.total)})
  wrong             ${report.wrong}
  declined          ${report.declined}   (no venue named at all — a non-answer, not a wrong answer)

  by the layer that produced the label the user sees:
${layerLine("scorer")}
${layerLine("focus-place")}
${layerLine("other")}

  venue scorer never ran   ${report.scorerNeverRan}/${report.total}   <-- rankVenues cannot fix these AT ALL

  of the stays the scorer DID decide:
    near-field short-circuited      ${report.nearFieldDecided}  (the summed evidence never ran)
      …and was wrong                ${report.nearFieldWrong}
      …truth outscored it, blocked ONLY by the short-circuit: ${report.blockedByNearField}   <-- what V1 would fix
    truth not a candidate           ${report.truthMissing}  (mirror/geometry — no ranking change reaches these)
`);

if (jsonAt) {
	await writeFile(jsonAt, `${JSON.stringify(report.results, null, "\t")}\n`, "utf8");
	console.log(`  cases written to ${jsonAt}\n`);
}
