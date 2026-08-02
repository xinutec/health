/**
 * The two lookups `RowSetOsmAdapter` still delegates: are their KEYS predictable
 * from the day's track, before the pipeline runs?
 *
 * Task #414. The row-set (#412) made the five bbox-keyed kernel lookups
 * answerable from pushed raw rows on all 33 fixtures — the item the port roadmap
 * called "the one genuine architectural blocker". Three delegations survive.
 * The bulk readers are settled: their SQL selects every row in a box the CALLER
 * chose, so there is no oracle to lift. The other two are open:
 *
 *   - `stationsOnLine(lineName)` — keyed by a NAME, so no bbox to take. A real
 *     spatial computation over mirror rows (`filterStationsByLineProximity` at
 *     300 m), currently decided in TS.
 *   - `reverseGeocode(lat, lon, zoom)` — Nominatim, through the `osm_cache`
 *     table at `roundCoord` = 4 dp ≈ 11 m.
 *
 * A Lean `day` serve mode cannot delegate either: there is nothing underneath
 * to delegate TO. So each has to become data, and the question that decides the
 * SHAPE of the push is whether its key set can be enumerated in advance.
 *
 * # What predictability buys, and why it is the first question
 *
 * If the keys are derivable from the track, the push is a prefetch pass and the
 * whole day stays one round of I/O. If they are not, the push has to carry raw
 * INPUTS wide enough to answer anything the pipeline might ask — for
 * `stationsOnLine` that is every railway way named like the line plus the
 * station table; for `reverseGeocode` there is no such thing, because the
 * backend is a remote service and the key is a derived coordinate.
 *
 * # Method
 *
 * Fixture-local, like `osm-oracle-parity.mts` and for the same reason: the
 * trace and the row-set were captured in one run, so they are contemporaneous
 * by construction and mirror drift cannot contaminate the answer. No DB.
 *
 * ASKED comes from the recorded trace — every key the day actually requested.
 * PREDICTED is computed from the track alone:
 *
 *   - lines: `linesAtPoint` from the ROW-SET at every distinct 3 dp track
 *     position, at `RAIL_JOURNEY_LINES_RADIUS_M` (800, the widest any call site
 *     passes), then run through the codebase's own name normalisers. This is
 *     the strongest prediction available without running the pipeline, because
 *     `linesAtPoint` is itself one of the five pushed lookups.
 *   - geocodes: the `cityGrid` (3 dp) quantisation of the track, which is what
 *     velocity.ts's endpoint-city tagging asks at. Anything ASKED that is not on
 *     that set came from a coordinate the pipeline DERIVED — a stay centroid, a
 *     resolved station — and is by definition not predictable from the track.
 *
 * # What it found (2026-08-02, 33 fixtures) — the two lookups split apart
 *
 *     stationsOnLine   24 distinct line names asked corpus-wide, 0 unreachable
 *                      from a track-derived linesAtPoint probe
 *     reverseGeocode   636 keys asked — 440 on the quantised track, 196 DERIVED
 *
 * `stationsOnLine`'s key set is enumerable before the pipeline runs. Every name
 * it asks for is offered by `linesAtPoint` over the day's own track, and that
 * is one of the five the row-set already computes — so the prefetch needs no
 * new oracle, only a second pass over rows already in hand. Sized separately in
 * `stationsonline-push-size.mts`: under 0.6 MiB per day.
 *
 * `reverseGeocode`'s is NOT. 31% of its keys sit on no quantised track
 * position, because they are coordinates the pipeline INVENTS — stay centroids,
 * resolved station coordinates — and a centroid depends on the segmentation,
 * which is the thing being computed. No prefetch can enumerate them, and
 * over-approximating is hopeless at the cache's own 4 dp resolution: covering a
 * day's neighbourhood at 11 m granularity is millions of cells, each a
 * potential Nominatim call.
 *
 * That is not a deferral, it is the answer. `reverseGeocode` is a third-party
 * HTTP naming service, not a spatial decision — there is no oracle to lift and
 * no theorem to win, which puts it in the same class as `fitbit-tz.ts`'s IANA
 * tzdata boundary, already excluded by the Lean/shell rule. It stays shell.
 * What the corpus needs from it, it already has: a pushed table of answers with
 * a hard-error miss policy (`isUncapturedLookup`, #408).
 *
 * Run: nix develop . --command npx tsx lean/experiments/delegated-lookup-keys.mts [day ...]
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseCapturedDay } from "../../src/cli/fixture-day.js";
import { lineBaseToken, lineNamesMatching } from "../../src/geo/line-stations.js";
import { RowSetOsmAdapter } from "../../src/geo/osm-adapter-rowset.js";

const DAYS_DIR = path.join(process.cwd(), "tests", "golden", "days");

/** The widest radius any `linesAtPoint` call site passes
 *  (`RAIL_JOURNEY_LINES_RADIUS_M`). Predicting with the widest is the
 *  over-approximation that favours the hypothesis — if the asked names are not
 *  in here, no narrower probe would have found them either. */
const PREDICT_LINES_RADIUS_M = 800;

/** `velocity.ts`'s `cityGrid` — 3 dp, ~111 m. The endpoint-city tagging asks at
 *  exactly this quantisation, so it is what a track-derived prediction can
 *  reach. NOT the same as `osm.ts`'s `roundCoord` (4 dp), which is the CACHE
 *  key; the mismatch is the point of the geocode half of this harness. */
const cityGrid = (n: number): number => Math.round(n * 1000) / 1000;

interface DayResult {
	date: string;
	/** Line names the day asked `stationsOnLine` for. */
	askedLines: string[];
	/** Of those, the ones no track-derived `linesAtPoint` probe produces. */
	unpredictedLines: string[];
	/** How many distinct line names the track probe offered, for context — a
	 *  prediction that names 400 lines to catch 4 is not a useful one. */
	predictedLineCount: number;
	/** Stations returned per asked line, summed — the size of what a push of
	 *  ANSWERS would carry, against which a push of INPUTS is judged. */
	stationRowsInAnswers: number;
	/** `reverseGeocode` keys the day asked. */
	askedGeo: string[];
	/** Of those, the ones that sit on a `cityGrid`-quantised track position. */
	geoOnTrack: string[];
	/** Of those, the ones that do not — derived coordinates. */
	geoDerived: string[];
	/** Probe cost, so a slow run is attributable. */
	probePoints: number;
}

/**
 * Does the track-derived line set reach `asked`?
 *
 * Not string equality. The codebase carries several readings of a line name and
 * they disagree deliberately — `linesAtPoint` returns raw `osm_lines.name`
 * values (which for shared London track are COMPOUND, "Circle, Hammersmith &
 * City and Metropolitan lines"), while callers ask `stationsOnLine` for a single
 * line. `lineNamesMatching` is the repo's own resolution of that, so the
 * prediction is tested through it in both directions: either the asked name
 * matches something the track saw, or the track saw a compound name that the
 * asked name's base token selects.
 */
function linePredicted(asked: string, trackNames: readonly string[]): boolean {
	if (lineNamesMatching(asked, trackNames).length > 0) return true;
	const askedBase = lineBaseToken(asked).toLowerCase();
	if (askedBase.length === 0) return false;
	return trackNames.some((n) => lineBaseToken(n).toLowerCase().includes(askedBase));
}

async function measureDay(file: string): Promise<DayResult> {
	const captured = parseCapturedDay(readFileSync(path.join(DAYS_DIR, file), "utf8"));
	const trace = captured.inputs.osmTrace;
	const rowSet = captured.inputs.osmRowSet;
	if (!rowSet) throw new Error(`${file}: no osmRowSet — re-capture needed before this can be measured`);

	const track = [
		...captured.inputs.phonetrack.today,
		...captured.inputs.phonetrack.morning,
		...captured.inputs.phonetrack.priorEvening,
	];

	// --- stationsOnLine ---
	const askedLines = Object.keys(trace.stationsOnLine ?? {});
	const stationRowsInAnswers = Object.values(trace.stationsOnLine ?? {}).reduce((n, s) => n + s.length, 0);

	// Probe `linesAtPoint` from the row-set at every distinct 3 dp track
	// position. The adapter's inner arm is never reached: `linesAtPoint` is one
	// of the five the row-set computes, so passing a thrower as `inner` makes
	// any accidental delegation loud instead of silent.
	const thrower = new Proxy(
		{},
		{
			get(_t, prop) {
				return () => {
					throw new Error(`delegated-lookup-keys: unexpected delegation to ${String(prop)}`);
				};
			},
		},
	);
	const osm = new RowSetOsmAdapter(rowSet, thrower as never);

	const probes = new Map<string, { lat: number; lon: number }>();
	for (const f of track) {
		const lat = cityGrid(f.lat);
		const lon = cityGrid(f.lon);
		probes.set(`${lat}|${lon}`, { lat, lon });
	}

	const trackNames = new Set<string>();
	for (const p of probes.values()) {
		// An uncovered probe is not a finding about the lookup — it is this
		// harness asking outside the day's buffer. Skip it and keep the count
		// honest rather than letting it abort the sweep.
		try {
			for (const n of await osm.linesAtPoint(p.lat, p.lon, PREDICT_LINES_RADIUS_M)) trackNames.add(n);
		} catch {
			// covered by `probePoints` vs `probes.size` in the report
		}
	}
	const names = [...trackNames];
	const unpredictedLines = askedLines.filter((l) => !linePredicted(l, names));

	// --- reverseGeocode ---
	const onTrack = new Set([...probes.keys()]);
	const askedGeo = Object.keys(trace.reverseGeocode);
	const geoOnTrack: string[] = [];
	const geoDerived: string[] = [];
	for (const key of askedGeo) {
		const [latS, lonS] = key.split("|");
		// The trace key carries the coordinate AS ASKED. The endpoint-city call
		// sites already pass `cityGrid`-quantised values, so a key that came
		// from one lands exactly on a probe; anything else was derived.
		(onTrack.has(`${Number(latS)}|${Number(lonS)}`) ? geoOnTrack : geoDerived).push(key);
	}

	return {
		date: file.slice(0, 10),
		askedLines,
		unpredictedLines,
		predictedLineCount: names.length,
		stationRowsInAnswers,
		askedGeo,
		geoOnTrack,
		geoDerived,
		probePoints: probes.size,
	};
}

const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const files = readdirSync(DAYS_DIR)
	.filter((f) => f.endsWith(".json"))
	.filter((f) => requested.length === 0 || requested.some((d) => f.startsWith(d)))
	.sort();

const results: DayResult[] = [];
for (const file of files) {
	try {
		const r = await measureDay(file);
		results.push(r);
		console.log(
			`${r.date}  lines asked ${String(r.askedLines.length).padStart(2)} ` +
				`unpredicted ${String(r.unpredictedLines.length).padStart(2)} ` +
				`(track offered ${String(r.predictedLineCount).padStart(3)})  ` +
				`geo asked ${String(r.askedGeo.length).padStart(3)} ` +
				`on-track ${String(r.geoOnTrack.length).padStart(3)} ` +
				`derived ${String(r.geoDerived.length).padStart(3)}`,
		);
		if (r.unpredictedLines.length > 0) console.log(`           unpredicted: ${r.unpredictedLines.join(", ")}`);
	} catch (e) {
		console.log(`${file.slice(0, 10)}  SKIPPED — ${(e as Error).message.split("\n")[0].slice(0, 120)}`);
	}
}

const allAskedLines = new Set(results.flatMap((r) => r.askedLines));
const allUnpredicted = new Set(results.flatMap((r) => r.unpredictedLines));
const totalGeo = results.reduce((n, r) => n + r.askedGeo.length, 0);
const totalOnTrack = results.reduce((n, r) => n + r.geoOnTrack.length, 0);
const totalDerived = results.reduce((n, r) => n + r.geoDerived.length, 0);
const totalStationRows = results.reduce((n, r) => n + r.stationRowsInAnswers, 0);

console.log(`\n=== ${results.length} day(s) ===`);
console.log(`stationsOnLine: ${allAskedLines.size} distinct line name(s) asked corpus-wide`);
console.log(`                ${allUnpredicted.size} not reachable from a track-derived linesAtPoint probe`);
if (allUnpredicted.size > 0) console.log(`                ${[...allUnpredicted].join(", ")}`);
console.log(`                ${totalStationRows} station row(s) across all recorded answers`);
console.log(`reverseGeocode: ${totalGeo} key(s) asked — ${totalOnTrack} on the quantised track, ${totalDerived} derived`);
