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
	useContinuityContinuation,
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
import { deltaTag, unexplainedDeltas } from "../lean/accepted-deltas.js";
import { isAcceptedMatchDelta, matchDeltaTag } from "../lean/accepted-match-deltas.js";
import { decodeServed, logLeanHsmmLedger, shadowHsmmViaLean } from "../lean/lean-hsmm.js";
import {
	leanMatchDivergences,
	leanMatchMode,
	leanMatchScopeTotals,
	leanMatchStats,
	resetLeanMatchStats,
} from "../lean/lean-match.js";
import { leanPassDivergences, leanPassScopeTotals, leanPassStats, resetLeanPassStats } from "../lean/lean-passes.js";
import { setLeanRunScope } from "../lean/run-scope.js";

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
 *  a mismatch or export refusal is recorded, never fails the decode run. The
 *  `on` path (serving the verified decode) is not wired yet. */
function runLeanShadow(inputs: HsmmInputs, date: string): void {
	const leanBin = process.env.LEAN_CLI;
	if (leanBin === undefined || leanBin === "" || !existsSync(leanBin)) return;
	shadowHsmmViaLean(inputs, leanBin, date);
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
		const s = shadowWalkDay(legs, leanBin);
		console.log(
			`walk-shadow ${date} quant↔lean ${s.exact}/${s.legs} EXACT` +
				(s.mismatches.length > 0 ? ` — MISMATCH ${s.mismatches.join(", ")}` : "") +
				` [float↔quant coarse ${s.coarse.EXACT}/${s.coarse.NEAR}/${s.coarse.DIFF}, ${Date.now() - t0}ms]`,
		);
	} catch (err) {
		console.log(`walk-shadow ${date} SKIPPED: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Request-path pass ledger (docs/proposals/2026-07-verified-core-lean.md):
 *  when `LEAN_PASSES` is `shadow` or `on`, the wired geometry passes execute
 *  the verified Lean implementation via the in-process bridge during the day's
 *  velocity runs (`shadow` serves TS, `on` serves Lean). Log the accumulated
 *  per-op ledger for the day (calls/failures/divergences) and reset. No-op with
 *  the flag off. In `on` mode this keeps the soak visible while production
 *  serves Lean — the same measurement, so a run of clean `EXACT` days is the
 *  continuous evidence the flip stays honest.
 *
 *  Divergences are adjudicated against `accepted-deltas.ts`, the same manifest
 *  the `shadow-passes` gate uses, so the daily line states whether the flip's
 *  premise ("every divergence is a signed-off near-tie") still holds on days
 *  the corpus does not cover.
 *
 *  The day makes several velocity runs — the decode itself, plus the extra one
 *  `runWalkShadow` does purely to extract legs — so the line breaks the tally
 *  down by scope and flags `IN SERVED OUTPUT` when a divergence came from the
 *  decode rather than from throwaway measurement. Summing them hid that
 *  distinction, which is the one the reader actually needs. */
function logLeanPassLedger(date: string): void {
	const mode = process.env.LEAN_PASSES;
	if (mode !== "shadow" && mode !== "on") return;
	const stats = leanPassStats();
	const tally = Object.entries(stats)
		.map(([op, s]) => `${op} ${s.calls}/${s.fails}f/${s.diffs}d`)
		.join(" ");
	// Adjudicate against the same manifest the flip gate uses. The gate only
	// replays the golden corpus, so production is the only place a divergence
	// on an uncaptured day can surface — logging one without saying whether it
	// is signed off makes an accepted near-tie and a genuine behaviour change
	// read identically.
	const scopes = leanPassScopeTotals();
	const byScope = Object.entries(scopes)
		.map(([sc, s]) => `${sc} ${s.calls}/${s.fails}f/${s.diffs}d`)
		.join(" · ");
	const divs = leanPassDivergences();
	const unexplained = unexplainedDeltas(divs);
	const served = divs.filter((d) => d.scope === "decode");
	const verdict =
		divs.length === 0 ? "EXACT" : unexplained.length === 0 ? "all accepted" : `${unexplained.length} UNEXPLAINED`;
	const servedNote = served.length === 0 ? "" : ` ${served.length} IN SERVED OUTPUT`;
	const detail =
		divs.length === 0
			? ""
			: ` — ${divs.map((d) => `[${deltaTag(d)}][${d.scope}] ${d.op} n=${d.n} ${d.note}`).join("; ")}`;
	console.log(
		`lean-passes[${mode}] ${date} ${tally === "" ? "(no calls)" : tally}` +
			`${byScope === "" ? "" : ` [all ops by run: ${byScope}]`} ${verdict}${servedNote}${detail}`,
	);
	resetLeanPassStats();
}

/** Request-path MATCHER ledger — the serve-path analogue of the always-on
 *  `walk-shadow` (which spawns `verified_cli match` per leg). When `LEAN_MATCH`
 *  is `shadow` or `on`, the walk matcher runs the proved Lean Viterbi over the
 *  persistent bridge during the day's velocity runs; log the accumulated
 *  serve-path ledger (calls/failures/decision-divergences) and reset. No-op with
 *  the flag off (the default) — the plumbing is dormant until the matcher flip,
 *  independent of `LEAN_PASSES`. See `src/lean/lean-match.ts`. */
function logLeanMatchLedger(date: string): void {
	const mode = leanMatchMode();
	if (mode === "off") return;
	const s = leanMatchStats();
	// Counts breakdown only when there is something to break down; the verdict
	// below already says EXACT, and printing both read "EXACT EXACT".
	const clean = s.coarseDiffs === 0 && s.pathDiffs === 0 && s.nullFlips === 0;
	const detail = clean ? "" : ` — coarse=${s.coarseDiffs} path=${s.pathDiffs} null=${s.nullFlips}`;
	// Which run each divergence came from. `decode` is the persisted, served
	// output; `shadow` is `runWalkShadow`'s extra velocity run over the same
	// legs. Pooled, the served count read roughly double and a shadow-only
	// divergence was indistinguishable from one a reader would actually see.
	const scopes = leanMatchScopeTotals();
	const byScope = Object.entries(scopes)
		.map(([sc, t]) => `${sc} ${t.calls}/${t.fails}f/${t.coarseDiffs}c/${t.pathDiffs}p/${t.nullFlips}n`)
		.join(" · ");
	const servedDiffs =
		(scopes.decode?.coarseDiffs ?? 0) + (scopes.decode?.pathDiffs ?? 0) + (scopes.decode?.nullFlips ?? 0);
	const servedNote = servedDiffs === 0 ? "" : ` ${servedDiffs} IN SERVED OUTPUT`;
	// Adjudicate each measured leg against the accepted manifest — the same
	// `isAcceptedMatchDelta` the gate enforces, now reachable because the
	// manifest is keyed on the leg's own fingerprint rather than on a golden
	// date the cron's live days can never match.
	const divs = leanMatchDivergences();
	const unexplained = divs.filter((d) => !isAcceptedMatchDelta(d.leg, d.coarse, d.path, d.note));
	const verdict =
		divs.length === 0 ? "EXACT" : unexplained.length === 0 ? "all accepted" : `${unexplained.length} UNEXPLAINED`;
	const legDetail =
		divs.length === 0
			? ""
			: ` — ${divs
					.map(
						(d) =>
							`[${matchDeltaTag(d.leg, d.coarse, d.path, d.note)}][${d.scope}] leg=${d.leg} ` +
							`coarse=${d.coarse}/path=${d.path} ${d.note}`,
					)
					.join("; ")}`;
	console.log(
		`lean-match[${mode}] ${date} ${s.calls}/${s.fails}f${s.calls === 0 ? " (no calls)" : ""}` +
			`${byScope === "" ? "" : ` [by run: ${byScope}]`}${detail} ${verdict}${servedNote}${legDetail}`,
	);
	resetLeanMatchStats();
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
	// docs/proposals/2026-06-presence-continuity.md): when the flag is
	// on, read the prior day's presence_log row to set the
	// continuation context. Silent fallback if the row doesn't exist
	// (chain start) or the flag is off. The flag gate lives here in the
	// loader; the decoder purely consumes whatever context it is given.
	const continuityContext = useContinuityContinuation() ? await loadContinuityContext(userId, date) : null;
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
	runLeanShadow(inputs, date);
	await runWalkShadow(userId, date, tz, osm);
	logLeanHsmmLedger(date);
	logLeanPassLedger(date);
	logLeanMatchLedger(date);
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
		}
	}
	process.exit(0);
}

/** Load the continuity seed for `userId` on `date`: returns the
 *  context derived from `presence_log[date - 1]`, or null when no
 *  prior-day record exists (chain start, or yesterday was a travel
 *  day with no end-of-day stay). Phase 3 of
 *  `docs/proposals/2026-06-presence-continuity.md`. */
await main();
