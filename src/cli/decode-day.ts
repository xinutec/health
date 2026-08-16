/**
 * Production HSMM decoder CLI: decode a (user, date) day and persist
 * the result to `decoded_days`. The output is what `velocity.ts`
 * reads for place-attribution override.
 *
 * Usage (via prod-db.sh):
 *
 *   scripts/prod-db.sh node dist/cli/decode-day.js --date 2026-05-22
 *   scripts/prod-db.sh node dist/cli/decode-day.js --user pippijn --days 14
 *
 * The `--days N` form decodes the last N days for the user. Used by
 * the cron task that keeps the cache warm. Idempotent — re-decoding
 * a day overwrites the existing row (with current classifier version).
 */

import { existsSync } from "node:fs";
import { z } from "zod";
import { initPool, db as kyselyDb, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import {
	placeReachabilityRadiusM,
	useCadenceImputation,
	useChainContext,
	usePlaceReachability,
	useReacquireRobustSpeed,
	useSegmentEvidence,
} from "../geo/factors/feature-flag.js";
import { parseHourProfile } from "../geo/focus-places.js";
import { stationsOnLine } from "../geo/line-stations.js";
import { loadClassificationInputs } from "../geo/load-classification-inputs.js";
import { dbOsmAdapter, type OsmAdapter } from "../geo/osm-adapter.js";
import { RecordingOsmAdapter } from "../geo/osm-adapter-recording.js";
import type { RailStopRelation } from "../geo/osm-rail-stops.js";
import { beginWalkLegCapture, endWalkLegCapture } from "../geo/pedestrian-match-annotate.js";
import { computeMinuteProximity } from "../geo/rail-road-proximity.js";
import { loadAllRailStopRelations } from "../geo/rail-stops-cache.js";
import type { RouteGraph } from "../geo/route-graph.js";
import { bboxFromFixes, loadRouteGraphForBbox } from "../geo/route-graph-loader.js";
import { dateBoundsUtc } from "../geo/timezone.js";
import { computeVelocity, computeVelocityFromInputs, loadBiometrics } from "../geo/velocity.js";
import { shadowWalkDay } from "../geo/walk-shadow-core.js";
import { loadContinuityContext } from "../hmm/continuity-context.js";
import { type HsmmInputs, type HsmmPlace, KNOWN_LINES } from "../hmm/decode.js";
import { dropGpsOutliers } from "../hmm/gps-outliers.js";
import { saveDecode } from "../hmm/persist.js";
import { reachablePlacesForDay } from "../hmm/place-reachability.js";
import { logLeanBioLabelsLedger } from "../lean/lean-biometric-labels.js";
import { logLeanDayLedger } from "../lean/lean-day.js";
import { logLeanGpsQualityLedger } from "../lean/lean-gps-quality.js";
import { decodeServed, logLeanHsmmLedger, shadowHsmmViaLean } from "../lean/lean-hsmm.js";
import { logLeanKalmanLedger } from "../lean/lean-kalman.js";
import { logLeanMatchLedger } from "../lean/lean-match.js";
import { logLeanPassLedger } from "../lean/lean-passes.js";
import { logLeanStationChainLedger } from "../lean/lean-station-chain.js";
import { leanShadowEnabled, setLeanRunScope } from "../lean/run-scope.js";
import { errorText } from "../util/error-text.js";

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

async function loadFocusPlacesForUser(userId: string): Promise<HsmmPlace[]> {
	const rows = await kyselyDb()
		.selectFrom("focus_places")
		.where("user_id", "=", userId)
		.select(["id", "display_name", "centroid_lat", "centroid_lon", "hour_profile", "total_dwell_sec"])
		.execute();
	return rows.map((r) => ({
		id: r.id,
		displayName: r.display_name,
		lat: Number(r.centroid_lat),
		lon: Number(r.centroid_lon),
		hourProfile: parseHourProfile(r.hour_profile),
		totalDwellSec: Number(r.total_dwell_sec),
	}));
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function buildPlaceNearLine(places: readonly HsmmPlace[], lines: readonly string[]): Promise<Set<string>> {
	const WALK_DIST_M = 400;
	const placeNearLine = new Set<string>();
	for (const line of lines) {
		const stations = await stationsOnLine(line);
		if (stations.length === 0) continue;
		for (const p of places) {
			for (const s of stations) {
				if (haversineMeters(p.lat, p.lon, s.lat, s.lon) <= WALK_DIST_M) {
					placeNearLine.add(`${p.id}|${line}`);
					break;
				}
			}
		}
	}
	return placeNearLine;
}

/** V2 shadow (docs/proposals/2026-07-verified-core-lean.md), now staged behind
 *  `LEAN_HSMM` (off/shadow/on) with an accumulating ledger — see `lean-hsmm.ts`.
 *  Needs the cron image's verified binary (`LEAN_CLI`). Purely observational:
 *  a mismatch or export refusal is recorded, never fails the decode run — the
 *  serving decision (TS vs the verified decode) is `decodeServed`'s, made from
 *  the same `LEAN_HSMM` mode, independent of this A/B. */
function runLeanShadow(inputs: HsmmInputs, date: string): void {
	const leanBin = process.env.LEAN_CLI;
	if (leanBin === undefined || leanBin === "" || !existsSync(leanBin)) return;
	shadowHsmmViaLean(inputs, date);
}

/** Matcher shadow (docs/proposals/2026-07-verified-core-lean.md): when the
 *  image carries the verified Lean matcher (`LEAN_CLI`), replay the day's
 *  walking legs through `verified_cli match` and the BigInt twin on identical
 *  quantised input and log the bit-exact agreement — continuous live
 *  verification of `MatchViterbi.decodeFast`, beyond the 31 golden legs the
 *  `compare-match` gate covers. Purely observational: a mismatch is logged,
 *  never fails the decode. A `RecordingOsmAdapter` (like `capture-golden`)
 *  captures the day's ways/buildings in one extra velocity run, then the
 *  shared `walk-shadow-core` runs the same per-leg A/B as the gate. Only fires
 *  when `LEAN_CLI` is set (the cron image), so it never touches the
 *  interactive `/api/velocity` path. */
async function runWalkShadow(userId: string, date: string, tz: string, osm: OsmAdapter): Promise<void> {
	const leanBin = process.env.LEAN_CLI;
	if (leanBin === undefined || leanBin === "" || !existsSync(leanBin)) return;
	try {
		const t0 = Date.now();
		const recorder = new RecordingOsmAdapter(osm);
		const inputs = await loadClassificationInputs(config, { userId, date, displayTz: tz }, recorder);
		const capture = beginWalkLegCapture();
		await computeVelocityFromInputs(inputs, { walkMatch: true });
		const legs = endWalkLegCapture(capture);
		const s = shadowWalkDay(legs);
		console.log(
			`walk-shadow ${date} quant↔lean ${s.exact}/${s.legs} EXACT` +
				(s.mismatches.length > 0 ? ` — MISMATCH ${s.mismatches.join(", ")}` : "") +
				` [float↔quant coarse ${s.coarse.EXACT}/${s.coarse.NEAR}/${s.coarse.DIFF}, ${Date.now() - t0}ms]`,
		);
	} catch (err) {
		console.log(`walk-shadow ${date} SKIPPED: ${errorText(err)}`);
	}
}

async function decodeAndPersist(
	userId: string,
	date: string,
	tz: string,
	places: readonly HsmmPlace[],
	placeNearLine: Set<string>,
	routeGraph: RouteGraph,
	railStopRelations: readonly RailStopRelation[],
	osm: OsmAdapter,
	dry: boolean,
): Promise<{ segmentCount: number; minuteCount: number; durationMs: number }> {
	const t0 = Date.now();
	const velResult = await computeVelocity(config, userId, date, tz);
	const bounds = dateBoundsUtc(date, tz);
	const biom = await loadBiometrics(userId, bounds.startUtc, bounds.endUtc, tz);
	// Per-minute rail/road proximity (#238): one nearbyWays lookup per
	// distinct ~11 m minute-median location, classified rail-vs-road, so
	// the line-proximity factor can keep a road-following taxi off a
	// parallel tube line. Outlier-dropped to match the fixes the decode
	// actually observes.
	const proximityByMinute = await computeMinuteProximity(osm, date, tz, dropGpsOutliers(velResult.points));
	// Presence-continuity seed (Phase 3 of
	// docs/proposals/2026-06-presence-continuity.md): read the prior day's
	// presence_log row to set the continuation context. Silent fallback if the
	// row doesn't exist (chain start). Unconditional since #237 — it had been
	// gated on USE_CONTINUITY_CONTINUATION, which production sets to 1, so the
	// flag's only remaining effect was to let a LOCAL run decode a different day
	// than the cron wrote to decoded_days. The loader still owns the null case;
	// the decoder purely consumes whatever context it is given.
	const continuityContext = await loadContinuityContext(userId, date);
	// Per-day stationary state-space reduction: drop focus places the user was
	// never near (dead trellis states), keeping high-dwell anchors + the
	// continuity place. Off by default — production behaviour is the full set.
	const decodePlaces = usePlaceReachability()
		? reachablePlacesForDay(places, velResult.points, {
				radiusM: placeReachabilityRadiusM(),
				continuityPlaceId: continuityContext?.priorPlaceId ?? null,
			})
		: places;
	if (usePlaceReachability() && decodePlaces.length < places.length) {
		console.log(`place-reachability ${date} ${places.length}→${decodePlaces.length} places`);
	}
	const inputs: HsmmInputs = {
		date,
		tz,
		points: velResult.points,
		hr: biom.hr,
		steps: biom.steps,
		sleep: biom.sleep,
		places: decodePlaces,
		placeNearLine,
		routeGraph,
		continuityContext,
		proximityByMinute,
		imputeCadence: useCadenceImputation(),
		segmentEvidence: useSegmentEvidence(),
		chainContext: useChainContext(),
		reacquireRobustSpeed: useReacquireRobustSpeed(),
		railStopRelations,
	};
	// LEAN_HSMM=on serves the verified Lean trellis (TS fallback on bridge
	// failure); off/shadow keep the TS float decode. The shadow A/B below is
	// unaffected — it still measures both paths regardless of what is served.
	const segments = decodeServed(inputs, date);
	if (dry) {
		const fmt = (ts: number): string =>
			new Date(ts * 1000).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
		console.error(`# DRY RUN ${date} — ${segments.length} segments (not persisted):`);
		for (const s of segments) {
			const line = s.lineName ? ` @ ${s.lineName}` : "";
			const place = s.placeId !== null ? ` place=${s.placeId}` : "";
			console.error(`    ${fmt(s.startTs)}-${fmt(s.endTs)}  ${s.mode}${line}${place}`);
		}
	} else {
		await saveDecode(kyselyDb(), userId, date, segments);
	}
	// Everything from here is observational: it re-processes the same legs to
	// measure, and its output is discarded. Label it so the ledger can keep it
	// out of the served-path tally.
	setLeanRunScope("shadow");
	// HSMM float↔quant shadow (~19s): the only check on the served verified
	// decode against its float twin, so it runs every day.
	runLeanShadow(inputs, date);
	// Walk-matcher shadow (~74s): an EXTRA velocity pass replaying every leg
	// through the lean matcher. Redundant with the served path's own matcher
	// tally — which the ledgers below still report — so gate it behind
	// LEAN_SHADOW to keep the daily serve cron fast; a periodic audit run
	// re-exercises the full A/B.
	if (leanShadowEnabled()) await runWalkShadow(userId, date, tz, osm);
	logLeanHsmmLedger(date);
	// #711. Missed on the first pass, and the first live run is what showed it:
	// the per-day `lean-stationchain <date> EXACT …` lines printed from inside
	// the resolver, so the cron LOOKED instrumented, while the accumulating
	// ledger — the fleetwatch-readable line, and the only one carrying the
	// swallowed-bridge-failure count — was emitted by the two gates and by
	// nothing on the serve path. A tenant whose ledger is never emitted in
	// production is the same silence the ledger exists to break.
	// #711 AGAIN, and on the tenant that matters most (2026-08-16). `LEAN_DAY`
	// has been `shadow` in the manifest since `ee28e434`, and this call was
	// missing — so production ran the whole 38-pass chain every day and printed
	// NOTHING. Not a line nobody read: no line at all. Checked against the live
	// pod, `lean-day` appears ZERO times in a run that prints seven other
	// tenants' ledgers per day.
	//
	// It matters more here than it did for stationchain, because `day` is the
	// tenant that WRITES: flipping it to `on` without this is flipping a
	// persisting tenant with no live evidence at all.
	logLeanDayLedger(date);
	logLeanStationChainLedger(date);
	logLeanPassLedger(date);
	logLeanMatchLedger(date);
	logLeanKalmanLedger(date);
	logLeanGpsQualityLedger(date);
	logLeanBioLabelsLedger(date);
	// Per-minute count is purely diagnostic. Segments tile the day's
	// observed minutes contiguously (each `endTs` = last minute + 60),
	// so total minutes = Σ (endTs − startTs) / 60.
	const minuteCount = segments.reduce((n, s) => n + (s.endTs - s.startTs) / 60, 0);
	return {
		segmentCount: segments.length,
		minuteCount,
		durationMs: Date.now() - t0,
	};
}

interface CliArgs {
	userId: string;
	tz: string;
	dates: string[];
	/** Decode and print the segments without writing `decoded_days`.
	 *  For inspecting a decode against prod data without mutating the
	 *  cache. */
	dry: boolean;
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	let userId = "pippijn";
	let tz = "Europe/London";
	let days = 1;
	let explicitDate: string | null = null;
	let dry = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--user") userId = args[++i] ?? userId;
		else if (a === "--tz") tz = args[++i] ?? tz;
		else if (a === "--days") days = Number(args[++i] ?? days) || days;
		else if (a === "--date") explicitDate = args[++i] ?? null;
		else if (a === "--dry" || a === "--dry-run") dry = true;
	}
	let dates: string[];
	if (explicitDate) {
		dates = [explicitDate];
	} else {
		dates = [];
		const now = new Date();
		for (let d = 1; d <= days; d++) {
			const date = new Date(now);
			date.setUTCDate(now.getUTCDate() - d);
			dates.push(date.toISOString().slice(0, 10));
		}
	}
	return { userId, tz, dates, dry };
}

async function main(): Promise<void> {
	const { userId, tz, dates, dry } = parseArgs();
	initPool(config.db);
	await withConnection(migrate);

	console.error(`# decode-day — user=${userId} tz=${tz} dates=${dates.join(",")}`);
	const places = await loadFocusPlacesForUser(userId);
	const placeNearLine = await buildPlaceNearLine(places, KNOWN_LINES);

	// Load the user's lifetime route graph (bbox derived from
	// focus_places). Used by route-rail-evidence and reused across
	// every date in this run.
	const bbox = bboxFromFixes(places.map((p) => ({ lat: p.lat, lon: p.lon })));
	if (bbox === null) {
		console.error("# no focus places — cannot build route graph");
		process.exit(1);
	}
	const t0Graph = Date.now();
	const routeGraph = await loadRouteGraphForBbox(bbox, { featureTypes: ["railway"] });
	// Served-station membership (#364) — day-invariant like the route
	// graph, loaded once per run. Empty (missing table, empty mirror)
	// decodes unchanged.
	const railStopRelations = await loadAllRailStopRelations();
	console.error(
		`# loaded ${places.length} focus_places, ${placeNearLine.size} place-line pairs, ${routeGraph.edges.size} rail edges, ${railStopRelations.length} rail stop relations in ${Date.now() - t0Graph}ms`,
	);

	// Counted rather than thrown on, so one bad day does not abandon the rest of
	// the week — the exit code below carries the verdict instead.
	let failed = 0;
	for (const date of dates) {
		try {
			const result = await decodeAndPersist(
				userId,
				date,
				tz,
				places,
				placeNearLine,
				routeGraph,
				railStopRelations,
				dbOsmAdapter,
				dry,
			);
			console.log(
				`  ${date}: ${result.segmentCount} segments / ${result.minuteCount} minutes in ${result.durationMs}ms`,
			);
		} catch (e) {
			console.error(`  ${date} FAILED: ${e instanceof Error ? e.message : e}`);
			failed += 1;
		}
	}
	// ⚠ A FAILED DAY MUST FAIL THE PROCESS. This exited 0 unconditionally, so a
	// run in which every day threw reported success: the CronJob showed
	// `Complete`, and the only trace was a line in a log nobody greps.
	//
	// It mattered little while every tenant had a TS arm to fall back to — a
	// bridge failure was repaired and the day decoded anyway. It stops being
	// survivable with `solo` (#975), where there is no fallback by construction:
	// the day is simply not decoded, and exit 0 would make that invisible in
	// exactly the deployment that most needs it visible.
	//
	// Measured before changing it: the 2026-08-16 production run has ZERO
	// `FAILED` lines, so this does not turn a healthy cron red.
	//
	// ⚠ Blast radius: the cron runs `decode-day && refresh-presence-log`, so a
	// failed day now also SKIPS the presence refresh. That is the intended
	// reading — a presence log rebuilt from a partially-decoded week is worse
	// than a stale one — but it is a behaviour change, not a side effect.
	process.exit(failed > 0 ? 1 : 0);
}

/** Load the continuity seed for `userId` on `date`: returns the
 *  context derived from `presence_log[date - 1]`, or null when no
 *  prior-day record exists (chain start, or yesterday was a travel
 *  day with no end-of-day stay). Phase 3 of
 *  `docs/proposals/2026-06-presence-continuity.md`. */
await main();
