/**
 * Train HMM emission distributions from heuristic-labeled minutes.
 *
 * Phase 2 of `docs/proposals/2026-05-hmm-learned-emissions.md`.
 *
 * Loads all days in the requested date range, derives per-minute
 * (observation, label) pairs from heuristic segments, aggregates
 * into per-mode sample buckets, fits Gaussians + zero-inflated
 * cadence via supervised MLE, and persists the parameters as a
 * row in `learned_hmm_models` keyed by (user, version).
 *
 * Usage (via prod-db.sh):
 *
 *   scripts/prod-db.sh node dist/cli/train-hmm.js \
 *     --user pippijn --tz Europe/London \
 *     --from 2025-12-01 --to 2026-05-15 \
 *     --version per-mode-gaussian-v1 \
 *     --notes "first cut: per-mode Gaussians, blessed days excluded" \
 *     --skip-blessed
 *
 * Days that fail to load (no GPS, no biometrics, pipeline error) are
 * skipped with a stderr warning — they contribute nothing rather
 * than poisoning the fit.
 *
 * Heuristic labels EXCLUDED from training:
 *   - "unknown" mode segments — the heuristic explicitly says "I
 *     don't know," so the observation has no label.
 *   - Minutes with no segment at all — same reason.
 *
 * Modes that don't reach `MIN_SAMPLES_PER_MODE` (50) labeled
 * samples are flagged "fallback" in the persisted model; the
 * inference-time emission function uses hand-tuned MODE_PRIORS
 * for those modes.
 */

import { z } from "zod";
import { db, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import type { TransportMode } from "../geo/segments.js";
import { dateBoundsUtc } from "../geo/timezone.js";
import { computeVelocity, loadBiometrics } from "../geo/velocity.js";
import { fitPerModeEmissions, type LabeledSample } from "../hmm/fit-emissions.js";
import { buildObservationTensor } from "../hmm/observation.js";

const KNOWN_MODES: ReadonlySet<TransportMode> = new Set([
	"stationary",
	"walking",
	"cycling",
	"driving",
	"train",
	"plane",
	"unknown",
]);

function asTransportMode(s: string): TransportMode | null {
	return KNOWN_MODES.has(s as TransportMode) ? (s as TransportMode) : null;
}

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

/** Days held out for hand-checked evaluation — must be excluded
 *  from training to make the audit comparison meaningful. Update
 *  in lockstep with `tests/golden/blessed-days.txt` (or whatever
 *  the canonical list is). */
const BLESSED_DAYS = new Set(["2026-04-29", "2026-04-30", "2026-05-18", "2026-05-20", "2026-05-22"]);

interface CliArgs {
	userId: string;
	tz: string;
	fromDate: string;
	toDate: string;
	version: string;
	notes: string;
	skipBlessed: boolean;
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	let userId = "pippijn";
	let tz = "Europe/London";
	let fromDate = "";
	let toDate = "";
	let version = "";
	let notes = "";
	let skipBlessed = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--user") userId = args[++i] ?? userId;
		else if (args[i] === "--tz") tz = args[++i] ?? tz;
		else if (args[i] === "--from") fromDate = args[++i] ?? "";
		else if (args[i] === "--to") toDate = args[++i] ?? "";
		else if (args[i] === "--version") version = args[++i] ?? "";
		else if (args[i] === "--notes") notes = args[++i] ?? "";
		else if (args[i] === "--skip-blessed") skipBlessed = true;
	}
	if (!fromDate || !toDate) throw new Error("--from YYYY-MM-DD --to YYYY-MM-DD required");
	if (!version) throw new Error("--version required (e.g. per-mode-gaussian-v1)");
	return { userId, tz, fromDate, toDate, version, notes, skipBlessed };
}

function* dateRange(fromIso: string, toIso: string): Generator<string> {
	const from = new Date(`${fromIso}T00:00:00Z`);
	const to = new Date(`${toIso}T00:00:00Z`);
	for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
		yield d.toISOString().slice(0, 10);
	}
}

interface PlaceCoord {
	id: number;
	lat: number;
	lon: number;
	radiusM: number;
}

/** Haversine distance in metres between two (lat, lon) points. */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Find the focus_place whose centroid is closest to (lat, lon),
 *  within its own radius_m. Returns null when no place is close
 *  enough (the user is somewhere off-network). */
function nearestPlaceId(lat: number, lon: number, places: readonly PlaceCoord[]): number | null {
	let bestId: number | null = null;
	let bestD = Infinity;
	for (const p of places) {
		const d = haversineMeters(lat, lon, p.lat, p.lon);
		if (d <= p.radiusM && d < bestD) {
			bestD = d;
			bestId = p.id;
		}
	}
	return bestId;
}

async function collectDaySamples(
	userId: string,
	date: string,
	tz: string,
	places: readonly PlaceCoord[],
): Promise<LabeledSample[]> {
	const velResult = await computeVelocity(config, userId, date, tz);
	const bounds = dateBoundsUtc(date, tz);
	const biom = await loadBiometrics(userId, bounds.startUtc, bounds.endUtc, tz);
	const tensor = buildObservationTensor({
		date,
		tz,
		points: velResult.points,
		hr: biom.hr,
		steps: biom.steps,
		sleep: biom.sleep,
	});

	// Per-segment placeId: resolved once from the segment's GPS centroid
	// (mean of all GPS-present minutes within the segment's time range),
	// then applied to ALL minutes in that segment — including the indoor
	// GPS-null minutes that dominate clinic / hospital / office stays.
	// Per-minute GPS attribution missed these (Phase 2.5 v3 audit: only
	// 8 of 27 places had enough samples). Per-segment fixes that:
	// Cleveland Clinic's full hour of stationary minutes attributes to
	// one placeId, not the 5 minutes that happened to have a GPS fix.
	const segPlaceId = new Map<number, number | null>(); // by segment index
	for (let i = 0; i < velResult.segments.length; i++) {
		const seg = velResult.segments[i];
		const segLat: number[] = [];
		const segLon: number[] = [];
		for (const o of tensor) {
			if (o.ts < seg.startTs || o.ts >= seg.endTs) continue;
			if (o.gps === null) continue;
			segLat.push(o.gps.lat);
			segLon.push(o.gps.lon);
		}
		if (segLat.length === 0) {
			segPlaceId.set(i, null);
			continue;
		}
		const meanLat = segLat.reduce((s, v) => s + v, 0) / segLat.length;
		const meanLon = segLon.reduce((s, v) => s + v, 0) / segLon.length;
		segPlaceId.set(i, nearestPlaceId(meanLat, meanLon, places));
	}

	const samples: LabeledSample[] = [];
	for (const obs of tensor) {
		// Find segment index (not just the segment) so we can look up
		// per-segment placeId via segPlaceId.
		let segIdx = -1;
		for (let i = 0; i < velResult.segments.length; i++) {
			const s = velResult.segments[i];
			if (s.startTs <= obs.ts && obs.ts < s.endTs) {
				segIdx = i;
				break;
			}
		}
		if (segIdx === -1) continue;
		const seg = velResult.segments[segIdx];
		const rawMode = seg.refinedMode ?? seg.mode;
		const mode = asTransportMode(rawMode);
		if (mode === null || mode === "unknown") continue;
		const placeId = mode === "stationary" ? (segPlaceId.get(segIdx) ?? null) : null;
		samples.push({
			mode,
			hr: obs.hr,
			cadence: obs.cadence,
			speedKmh: obs.gps !== null ? obs.gps.speedKmh : null,
			gpsPresent: obs.gps !== null,
			placeId,
		});
	}
	return samples;
}

async function loadFocusPlaceCoords(userId: string): Promise<PlaceCoord[]> {
	const rows = await db()
		.selectFrom("focus_places")
		.where("user_id", "=", userId)
		.select(["id", "centroid_lat", "centroid_lon", "radius_m"])
		.execute();
	return rows.map((r) => ({
		id: r.id,
		lat: Number(r.centroid_lat),
		lon: Number(r.centroid_lon),
		radiusM: Number(r.radius_m),
	}));
}

async function main(): Promise<void> {
	const args = parseArgs();
	initPool(config.db);
	await withConnection(migrate);

	console.error(`# Train HMM emissions — user=${args.userId} tz=${args.tz}`);
	console.error(`# Range: ${args.fromDate} → ${args.toDate}`);
	console.error(`# Version: ${args.version}`);
	console.error(`# Skip blessed: ${args.skipBlessed} (${[...BLESSED_DAYS].join(", ")})`);
	console.error();

	const places = await loadFocusPlaceCoords(args.userId);
	console.error(`# Loaded ${places.length} focus_place coordinates for GPS-centroid matching`);
	console.error();

	const allSamples: LabeledSample[] = [];
	let dayCount = 0;
	let skippedDayCount = 0;
	let failedDayCount = 0;

	for (const date of dateRange(args.fromDate, args.toDate)) {
		if (args.skipBlessed && BLESSED_DAYS.has(date)) {
			skippedDayCount++;
			continue;
		}
		try {
			const t0 = Date.now();
			const samples = await collectDaySamples(args.userId, date, args.tz, places);
			const dt = Date.now() - t0;
			console.error(`  [${date}] ${samples.length.toString().padStart(4)} labeled samples (${dt}ms)`);
			allSamples.push(...samples);
			dayCount++;
		} catch (e) {
			console.error(`  [${date}] FAILED: ${e instanceof Error ? e.message : String(e)}`);
			failedDayCount++;
		}
	}

	console.error();
	console.error(`# ${dayCount} days included, ${skippedDayCount} blessed skipped, ${failedDayCount} failed`);
	console.error(`# ${allSamples.length} total labeled samples`);

	const fit = fitPerModeEmissions(allSamples);
	console.error();
	console.error("# Per-mode sample counts:");
	for (const [mode, count] of Object.entries(fit.trainingSummary.samplesPerMode)) {
		const fitted = fit.perMode[mode as keyof typeof fit.perMode];
		const status = fitted === "fallback" ? "FALLBACK (< 50)" : "fitted";
		console.error(`  ${mode.padEnd(12)} ${(count ?? 0).toString().padStart(6)}  ${status}`);
	}
	console.error();

	const perPlaceCount = Object.keys(fit.perPlaceHr).length;
	const placesWithSamples = Object.keys(fit.trainingSummary.samplesPerPlace).length;
	console.error(`# Per-place HR: ${perPlaceCount} of ${placesWithSamples} known-place stationary clusters have a fit`);
	const sortedPlaces = Object.entries(fit.trainingSummary.samplesPerPlace)
		.map(([id, n]) => ({ id, n }))
		.sort((a, b) => b.n - a.n)
		.slice(0, 15);
	for (const { id, n } of sortedPlaces) {
		const f = fit.perPlaceHr[id];
		const status = f ? `fitted (μ=${f.mean.toFixed(0)} σ=${f.std.toFixed(0)}, n=${f.sampleCount})` : "fallback (< 50)";
		console.error(`  #${id.padEnd(5)} samples=${n.toString().padStart(5)}  ${status}`);
	}
	console.error();

	const emissionsJson = JSON.stringify(fit);
	await db()
		.insertInto("learned_hmm_models")
		.values({
			user_id: args.userId,
			version: args.version,
			notes: args.notes || null,
			emissions_json: emissionsJson,
			training_day_count: dayCount,
			training_minute_count: allSamples.length,
		})
		.onDuplicateKeyUpdate({
			notes: args.notes || null,
			emissions_json: emissionsJson,
			training_day_count: dayCount,
			training_minute_count: allSamples.length,
		})
		.execute();

	console.error(`# Persisted model: user=${args.userId} version=${args.version}`);
	console.error(`#   ${emissionsJson.length} bytes serialised`);

	process.exit(0);
}

await main();
