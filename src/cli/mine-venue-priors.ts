/**
 * CLI: mine the venue visit-shape prior to a FILE, and measure whether soft
 * attribution is worth doing at all.
 *
 * Phase P0 of `docs/proposals/2026-07-soft-venue-attribution.md`. Two jobs:
 *
 * 1. **Break the measurement deadlock.** The priors blob is a captured *input*
 *    to the golden fixtures (`inputs.venuePriors`), so re-mining in prod is
 *    invisible to a replay unless all 27 fixtures are re-captured — which drags
 *    in unrelated OSM drift (#342). Writing the blob to a file, and teaching
 *    `score-venues --priors <file>` to inject it, makes every later phase
 *    falsifiable without touching prod or the corpus.
 *
 * 2. **Answer the stop condition.** Report the EFFECTIVE SAMPLE SIZE of the
 *    training set under soft attribution (Σ responsibilities) against what the
 *    hard gate admits today. The whole proposal rests on the claim that the
 *    hard gate throws most of the evidence away. If soft attribution takes the
 *    training set from 40 visits to ~60, the prior stays too thin to matter,
 *    this is the wrong lever, and we stop.
 *
 * The expensive part (a 180-day PhoneTrack fetch, then one OSM landmark query
 * per stay) runs ONCE and dumps a training-set artifact. P1/P2 iterate on that
 * file offline — no DB, no network, deterministic.
 *
 * This CLI is READ-ONLY with respect to prod: it never writes `venue_type_priors`.
 * `refresh-focus-places` remains the only thing that does.
 *
 *   scripts/prod-db.sh node dist/cli/mine-venue-priors.js pippijn \
 *       --dump-stays work/stays.json --out work/priors.json
 *   node dist/cli/mine-venue-priors.js --from-stays work/stays.json --out work/priors.json
 */

import { readFile, writeFile } from "node:fs/promises";
import tzLookup from "tz-lookup";
import { z } from "zod";
import { db, destroyPool, initPool } from "../db/pool.js";
import {
	detectFocusPlaces,
	type FitbitSleepWindow,
	type RawPoint,
	sleepHoursFromFitbit,
	sleepHoursOf,
} from "../geo/focus-places.js";
import type { NearbyLandmark } from "../geo/osm.js";
import { nearbyLandmarks } from "../geo/osm.js";
import {
	type AttributedStay,
	attributeStayVenue,
	categoryOfSubtype,
	DWELL_BUCKETS,
	dwellBucket,
	effectiveSampleSize,
	localHourOf,
	minePriors,
	type StayResponsibilities,
	type StayShape,
	stayResponsibilities,
} from "../geo/venue-prior.js";
import { fetchTrackPointsRange, openPhoneTrack } from "../nextcloud/phonetrack.js";

/** One stay plus the candidate venues the mirror offered at its centroid — the
 *  raw material of the prior, dumped so it can be re-mined offline. */
interface TrainingStay {
	startTs: number;
	endTs: number;
	durationSec: number;
	/** Local hour of the stay midpoint, in the stay's own timezone. */
	localHour: number;
	lat: number;
	lon: number;
	candidates: NearbyLandmark[];
}

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
	const i = args.indexOf(name);
	return i >= 0 ? (args[i + 1] ?? null) : null;
};
/** First bare (non-flag, non-flag-value) argument. */
const userId = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--"))) ?? "pippijn";
const fromStays = flag("--from-stays");
const dumpStays = flag("--dump-stays");
const outPriors = flag("--out");
const lookbackDays = Number.parseInt(flag("--days") ?? "", 10) || 180;

async function collectFromProd(): Promise<TrainingStay[]> {
	const config = z
		.object({
			db: z.object({
				host: z.string().default("health-db"),
				port: z.coerce.number().default(3306),
				user: z.string(),
				password: z.string(),
				database: z.string().default("health"),
			}),
			nextcloud: z.object({
				baseUrl: z.string().url().default("https://dash.xinutec.org"),
				clientId: z.string().min(1),
				clientSecret: z.string().min(1),
			}),
		})
		.parse({
			db: {
				host: process.env.DB_HOST,
				port: process.env.DB_PORT,
				user: process.env.DB_USER,
				password: process.env.DB_PASSWORD,
				database: process.env.DB_NAME,
			},
			nextcloud: {
				baseUrl: process.env.NC_BASE_URL,
				clientId: process.env.NC_CLIENT_ID,
				clientSecret: process.env.NC_CLIENT_SECRET,
			},
		});
	// NO migrate() here, deliberately. This CLI only reads: it must not be able
	// to alter the prod schema as a side effect of taking a measurement.
	// (`refresh-focus-places` migrates because it writes; this does not.)
	initPool(config.db);

	const ymdNDaysAgo = (n: number): string => {
		const d = new Date();
		d.setUTCDate(d.getUTCDate() - n);
		return d.toISOString().slice(0, 10);
	};
	const ctx = await openPhoneTrack(config, userId);
	const points: RawPoint[] = [];
	const seen = new Set<string>();
	for (let offset = lookbackDays; offset > 0; offset -= 7) {
		const chunk = await fetchTrackPointsRange(ctx, ymdNDaysAgo(offset), ymdNDaysAgo(Math.max(0, offset - 7)));
		for (const p of chunk) {
			const k = `${p.ts}/${p.lat.toFixed(6)}/${p.lon.toFixed(6)}`;
			if (seen.has(k)) continue;
			seen.add(k);
			points.push({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy });
		}
	}
	points.sort((a, b) => a.ts - b.ts);
	console.error(`[${userId}] ${points.length} points over ${lookbackDays}d`);

	const detected = detectFocusPlaces(points);
	console.error(`[${userId}] ${detected.stays.length} stays, ${detected.clusters.length} clusters`);

	// Mirror `refresh-focus-places` EXACTLY, or the A/B is measured against a
	// fiction. Two gates there, both upstream of the venue attribution:
	//   1. mining walks the CLUSTERS' stays, not every detected stay;
	//   2. a cluster whose Fitbit-confirmed sleep clears the residency
	//      threshold is skipped whole — a home does not train venue-type
	//      priors, and the shops near it must not inherit its dwells.
	// Getting this wrong is how the baseline stops being the baseline.
	const sleepRows = await db()
		.selectFrom("sleep")
		.select(["start_time", "end_time"])
		.where("user_id", "=", userId)
		.where("is_main_sleep", "=", true)
		.execute();
	const sleepWindows: FitbitSleepWindow[] = sleepRows.map((r) => ({
		startTs: Math.floor(new Date(r.start_time).getTime() / 1000),
		endTs: Math.floor(new Date(r.end_time).getTime() / 1000),
	}));
	const hasFitbitSleep = sleepWindows.length > 0;
	const RESIDENCE_SLEEP_THRESHOLD_H = 5;

	const out: TrainingStay[] = [];
	let residentialSkipped = 0;
	for (const c of detected.clusters) {
		const sleepH = hasFitbitSleep ? sleepHoursFromFitbit(c.stays, sleepWindows) : sleepHoursOf(c);
		if (sleepH >= RESIDENCE_SLEEP_THRESHOLD_H) {
			residentialSkipped += c.stays.length;
			continue;
		}
		for (const s of c.stays) {
			const tz = tzLookup(s.centroidLat, s.centroidLon);
			out.push({
				startTs: s.startTs,
				endTs: s.endTs,
				durationSec: s.durationSec,
				localHour: localHourOf(Math.floor((s.startTs + s.endTs) / 2), tz),
				lat: s.centroidLat,
				lon: s.centroidLon,
				candidates: await nearbyLandmarks(s.centroidLat, s.centroidLon, 100),
			});
		}
	}
	console.error(
		`[${userId}] ${out.length} mineable stays (${residentialSkipped} skipped as residential, ${detected.stays.length - out.length - residentialSkipped} not in any cluster)`,
	);
	await destroyPool();
	return out;
}

const stays: TrainingStay[] = fromStays
	? (JSON.parse(await readFile(fromStays, "utf8")) as TrainingStay[])
	: await collectFromProd();

if (dumpStays) {
	await writeFile(dumpStays, `${JSON.stringify(stays, null, "\t")}\n`, "utf8");
	console.error(`wrote ${stays.length} training stays to ${dumpStays}`);
}

// --- what the HARD gate admits today (current prod behaviour) ---------------

const hardStays: AttributedStay[] = [];
for (const s of stays) {
	const attributed = attributeStayVenue(s.candidates);
	if (attributed) {
		hardStays.push({ subtype: attributed.subtype, durationSec: s.durationSec, localHour: s.localHour });
	}
}
const hardPriors = minePriors(hardStays);

// --- does this harness actually reproduce prod? -----------------------------
// The A/B is worthless if the baseline arm is not the baseline. `--expect`
// takes prod's real blob (lift it out of any golden fixture's
// `inputs.venuePriors`) and diffs against what this CLI mines with the hard
// gate. They must match. If they don't, some gate upstream of the venue
// attribution differs, every later measurement is confounded, and the number
// to fix is this one — not the model.
const expectAt = flag("--expect");
if (expectAt) {
	const expected = JSON.parse(await readFile(expectAt, "utf8")) as ReturnType<typeof minePriors>;
	const subs = new Set([...Object.keys(expected.bySubtype), ...Object.keys(hardPriors.bySubtype)]);
	const diffs = [...subs]
		.map((s) => ({ s, want: expected.bySubtype[s]?.visits ?? 0, got: hardPriors.bySubtype[s]?.visits ?? 0 }))
		.filter((d) => d.want !== d.got);
	if (diffs.length === 0 && expected.totalVisits === hardPriors.totalVisits) {
		console.error(`✓ harness reproduces prod (${hardPriors.totalVisits} visits) — the baseline arm is honest`);
	} else {
		console.error(
			`✗ harness does NOT reproduce prod: ${expected.totalVisits} visits in prod vs ${hardPriors.totalVisits} mined here`,
		);
		for (const d of diffs.sort((a, b) => Math.abs(b.want - b.got) - Math.abs(a.want - a.got)).slice(0, 15)) {
			console.error(`    ${d.s.padEnd(18)} prod ${String(d.want).padStart(3)}   mined ${String(d.got).padStart(3)}`);
		}
		console.error(`  Every A/B below is confounded until this matches. Fix the harness, not the model.`);
	}
}

// --- what SOFT attribution would see (measurement only — nothing is mined
//     from it in P0; that is P1) -------------------------------------------

const shapeOf = (s: TrainingStay): StayShape => ({
	startUnix: s.startTs,
	endUnix: s.endTs,
	tz: tzLookup(s.lat, s.lon),
});

const soft: StayResponsibilities[] = stays.map((s) => stayResponsibilities(s.candidates, shapeOf(s)));
const ess = effectiveSampleSize(soft);
const meanOther = soft.reduce((a, s) => a + s.other, 0) / (soft.length || 1);

/** Soft mass per subtype, and how much of it lands in each dwell bucket — the
 *  side-by-side against the hard gate's counts. */
const softBySubtype = new Map<string, { mass: number; dwell: number[] }>();
stays.forEach((s, i) => {
	const bucket = dwellBucket(s.durationSec);
	for (const c of soft[i].candidates) {
		let e = softBySubtype.get(c.landmark.subtype);
		if (!e) {
			e = { mass: 0, dwell: new Array(DWELL_BUCKETS).fill(0) };
			softBySubtype.set(c.landmark.subtype, e);
		}
		e.mass += c.r;
		e.dwell[bucket] += c.r;
	}
});

if (outPriors) {
	// P0 writes the HARD-gate blob — byte-equivalent to what prod mines today.
	// That is the point: it proves the file path reproduces current behaviour,
	// so any later difference is attributable to the algorithm and not the
	// harness. P1 is what changes the blob.
	await writeFile(outPriors, `${JSON.stringify(hardPriors, null, "\t")}\n`, "utf8");
	console.error(`wrote priors (hard gate, = current prod) to ${outPriors}`);
}

const n = (x: number, w = 6): string => x.toFixed(1).padStart(w);

console.log(`
venue-prior training set — user=${userId}, ${stays.length} stays

                        hard gate      soft attribution
  training visits    ${String(hardStays.length).padStart(10)}      ${n(ess, 10)}   (effective, Σ responsibilities)
  stays that teach   ${String(hardStays.length).padStart(10)}      ${String(soft.filter((s) => s.other < 0.9).length).padStart(10)}
  discarded          ${String(stays.length - hardStays.length).padStart(10)}      ${String(soft.filter((s) => s.other >= 0.9).length).padStart(10)}

  mean 'other' mass: ${meanOther.toFixed(3)}
    The V0 referee measured the truth ABSENT from the candidate set on 3/36
    (~0.083) narrative-named stays. If these two numbers are far apart,
    OTHER_COMPONENT_NATS is miscalibrated — it is provisional by construction
    (see its docstring) and this is the number to fit it against.

  per-subtype, dwell bucket [<10, 10-40, 40-150, 150+] min:
`);

const subtypes = new Set([...Object.keys(hardPriors.bySubtype), ...softBySubtype.keys()]);
const rows = [...subtypes]
	.map((sub) => ({
		sub,
		hard: hardPriors.bySubtype[sub],
		soft: softBySubtype.get(sub),
	}))
	.sort((a, b) => (b.soft?.mass ?? 0) - (a.soft?.mass ?? 0));

console.log(`  ${"subtype".padEnd(18)} ${"cat".padEnd(12)} ${"hard".padStart(5)}  ${"soft".padStart(6)}   soft dwell`);
for (const r of rows.slice(0, 25)) {
	const hard = r.hard ? String(r.hard.visits) : "0";
	const softMass = r.soft ? r.soft.mass.toFixed(1) : "0.0";
	const dwell = r.soft ? `[${r.soft.dwell.map((d) => d.toFixed(1)).join(", ")}]` : "";
	console.log(
		`  ${r.sub.padEnd(18)} ${categoryOfSubtype(r.sub).padEnd(12)} ${hard.padStart(5)}  ${softMass.padStart(6)}   ${dwell}`,
	);
}
if (rows.length > 25) console.log(`  … ${rows.length - 25} more subtypes`);

console.log(`
  STOP CONDITION (proposal P0): soft attribution must materially enlarge the
  training set. ${hardStays.length} -> ${ess.toFixed(1)} effective visits is a ${(ess / Math.max(1, hardStays.length)).toFixed(1)}x change.
  If that ratio is near 1, the hard gate was not the bottleneck and P1 should
  NOT be built.
`);
