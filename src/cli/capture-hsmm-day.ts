/**
 * CLI: capture a deterministic HSMM decode-replay fixture for one
 * (date, user). #237 Phase 8 / the #238 real-data guard.
 *
 * Loads the same `HsmmInputs` the production decode-day cron builds —
 * filtered points, biometrics, focus places, place-near-line, the rail
 * route graph, the prior-day continuity context, and the per-fix
 * rail/road proximity — runs `decodeHsmm` once, and writes a
 * self-contained fixture (raw OSM rows + proximity + the decode). The
 * replay test rebuilds the route graph and re-runs `decodeHsmm` with no
 * DB and no network.
 *
 * Connection: needs the prod DB. Run via prod-db.sh with the SAME gating
 * env the cron uses (USE_CONTINUITY_CONTINUATION=1) so the captured
 * decode matches production:
 *
 *   USE_CONTINUITY_CONTINUATION=1 scripts/prod-db.sh \
 *     node dist/cli/capture-hsmm-day.js 2026-05-25 pippijn Europe/London \
 *       --description "taxi home->Cleveland Clinic; must NOT decode train @ Circle Line (#238)"
 *
 * Writes tests/golden/decoded_days/<date>-<user>.json (gitignored — the
 * fixture carries real GPS + place names).
 *
 * The route graph is captured for a bbox around THIS day's fixes (not
 * the user's lifetime bbox the cron uses). `edgesNear` is local, so the
 * line-proximity / route-rail factors see identical edges near every
 * fix; only lines nowhere near the day drop out of `modeledLines`, which
 * cannot change this day's decode. Faithfulness is confirmed by checking
 * the captured `expected` against a live prod re-decode.
 */

import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { initPool, db as kyselyDb, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { useCadenceImputation, useContinuityContinuation } from "../geo/factors/feature-flag.js";
import { parseHourProfile } from "../geo/focus-places.js";
import { stationsOnLine } from "../geo/line-stations.js";
import { dbOsmAdapter } from "../geo/osm-adapter.js";
import { computeMinuteProximity } from "../geo/rail-road-proximity.js";
import { buildRouteGraph } from "../geo/route-graph.js";
import { bboxFromFixes, loadRawOsmForBbox } from "../geo/route-graph-loader.js";
import { dateBoundsUtc } from "../geo/timezone.js";
import { computeVelocity, loadBiometrics } from "../geo/velocity.js";
import { loadContinuityContext } from "../hmm/continuity-context.js";
import { decodeHsmm, type HsmmInputs, type HsmmPlace, KNOWN_LINES } from "../hmm/decode.js";
import { dropGpsOutliers } from "../hmm/gps-outliers.js";
import { HSMM_FIXTURE_FORMAT_VERSION, type HsmmCapturedDay, toSerializedHsmmInputs } from "./hsmm-fixture.js";

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

const DECODED_DIR = path.join(process.cwd(), "tests", "golden", "decoded_days");

function usage(): never {
	console.error(
		'Usage: node dist/cli/capture-hsmm-day.js <date> <user> <timezone> [--description "..."]\n' +
			"Run via prod-db.sh with USE_CONTINUITY_CONTINUATION=1 to match the cron.\n",
	);
	process.exit(2);
}

function gitSha(): string {
	try {
		return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

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

const args = process.argv.slice(2);
if (args.length < 3) usage();
const date = args[0];
const user = args[1];
const tz = args[2];
let description = "";
for (let i = 3; i < args.length; i++) {
	if (args[i] === "--description") {
		description = args[i + 1] ?? "";
		i++;
	} else {
		usage();
	}
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
	console.error(`bad date format: ${date} (expected YYYY-MM-DD)`);
	process.exit(2);
}

initPool(config.db);
await withConnection(migrate);

console.error(`# capture-hsmm-day — ${date} ${user} (${tz}), continuity=${useContinuityContinuation() ? "on" : "off"}`);

const places = await loadFocusPlacesForUser(user);
const placeNearLine = await buildPlaceNearLine(places, KNOWN_LINES);

const velResult = await computeVelocity(config, user, date, tz);
const bounds = dateBoundsUtc(date, tz);
const biom = await loadBiometrics(user, bounds.startUtc, bounds.endUtc, tz);

// Day-scoped rail route graph: bbox around this day's fixes.
const dayBbox = bboxFromFixes(velResult.points.map((p) => ({ lat: p.lat, lon: p.lon })));
if (dayBbox === null) {
	console.error("# no fixes on this day — nothing to capture");
	process.exit(1);
}
const rawOsm = await loadRawOsmForBbox(dayBbox, { featureTypes: ["railway"] });
const routeGraph = buildRouteGraph(rawOsm.lines, rawOsm.points);

const proximityByMinute = await computeMinuteProximity(dbOsmAdapter, date, tz, dropGpsOutliers(velResult.points));
const continuityContext = useContinuityContinuation() ? await loadContinuityContext(user, date) : null;

const inputs: HsmmInputs = {
	date,
	tz,
	points: velResult.points,
	hr: biom.hr,
	steps: biom.steps,
	sleep: biom.sleep,
	places,
	placeNearLine,
	routeGraph,
	continuityContext,
	proximityByMinute,
	imputeCadence: useCadenceImputation(),
};

const expected = decodeHsmm(inputs);

const captured: HsmmCapturedDay = {
	meta: {
		fixtureFormatVersion: HSMM_FIXTURE_FORMAT_VERSION,
		capturedAt: new Date().toISOString(),
		capturedAtCodeSha: gitSha(),
		date,
		user,
		tz,
		description,
	},
	inputs: toSerializedHsmmInputs(inputs, rawOsm),
	expected,
};

await mkdir(DECODED_DIR, { recursive: true });
const outPath = path.join(DECODED_DIR, `${date}-${user}.json`);
await writeFile(outPath, `${JSON.stringify(captured, null, "\t")}\n`, "utf8");

const trainSegs = expected.filter((s) => s.mode === "train").map((s) => s.lineName ?? "unknown_rail");
console.error(
	`# wrote ${outPath}\n` +
		`#   ${expected.length} segments · ${rawOsm.lines.length} rail lines · ${proximityByMinute.size} minute proximities\n` +
		`#   train lines in decode: ${trainSegs.length === 0 ? "(none)" : trainSegs.join(", ")}`,
);
process.exit(0);
