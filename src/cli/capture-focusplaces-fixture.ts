/**
 * CLI tool: freeze a real conflated focus-cluster into a splitCluster
 * test fixture.
 *
 * # Why this exists
 *
 * `splitCluster` is a messy-geometry algorithm — it decides whether a
 * focus cluster fused two co-located places (a daytime café and an
 * evening residence) or is one genuinely noisy place. Synthetic unit
 * tests gave false-green for rail-snap three times; cluster splitting
 * has the same exposure. This tool captures the *real* member stays of
 * two clusters so an offline test can assert behaviour against actual
 * GPS history, not tidy synthetic scatter:
 *
 *   - `conflated` — the cluster that fused a café and a residence
 *     (identified by the long evening stay on `<conflatedDate>`). The
 *     test asserts splitCluster splits it and the runtime routes an
 *     evening stay to the residence lobe, a daytime stay to the café.
 *   - `home` — the user's Home cluster. A single, heavily-visited,
 *     GPS-noisy place: the test asserts splitCluster does NOT split it.
 *
 * Captured before the splitCluster pass (`clusterStays` only), so the
 * fixture is the conflated input, not the already-split output.
 *
 * # Output
 *
 * Writes `tests/fixtures/focusplaces/<conflatedDate>-<user>.json` by
 * default. That directory is gitignored — the fixture holds real
 * coordinates and times (same policy as `tests/fixtures/railsnap/`).
 * The fixture FORMAT is generic; only the captured file is private.
 *
 * Usage (via scripts/prod-db.sh, or in-pod with DB env set):
 *   node dist/cli/capture-focusplaces-fixture.js <user> <conflatedDate> [--days N] [--out <path>]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import {
	ACCURACY_FILTER_M,
	assignDisplayNames,
	clusterStays,
	detectStays,
	type RawPoint,
} from "../geo/focus-places.js";
import { fetchTrackPointsRange, openPhoneTrack } from "../nextcloud/phonetrack.js";

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

const args = process.argv.slice(2);
if (args.length < 2) {
	console.error("Usage: node dist/cli/capture-focusplaces-fixture.js <user> <conflatedDate> [--days N] [--out <path>]");
	process.exit(2);
}
const userId = args[0];
const conflatedDate = args[1];
const daysIdx = args.indexOf("--days");
const lookbackDays = daysIdx >= 0 ? Number.parseInt(args[daysIdx + 1] ?? "", 10) || 180 : 180;
const outIdx = args.indexOf("--out");
const outPath =
	outIdx >= 0 ? args[outIdx + 1] : path.join("tests/fixtures/focusplaces", `${conflatedDate}-${userId}.json`);

const FETCH_CHUNK_DAYS = 7;

function ymdNDaysAgo(n: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - n);
	return d.toISOString().slice(0, 10);
}

async function fetchAllPoints(daysBack: number): Promise<RawPoint[]> {
	const ctx = await openPhoneTrack(config, userId);
	const all: RawPoint[] = [];
	const seen = new Set<string>();
	for (let offset = daysBack; offset > 0; offset -= FETCH_CHUNK_DAYS) {
		const start = ymdNDaysAgo(offset);
		const end = ymdNDaysAgo(Math.max(0, offset - FETCH_CHUNK_DAYS));
		const points = await fetchTrackPointsRange(ctx, start, end);
		for (const p of points) {
			const k = `${p.ts}/${p.lat.toFixed(6)}/${p.lon.toFixed(6)}`;
			if (seen.has(k)) continue;
			seen.add(k);
			all.push({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy });
		}
	}
	all.sort((a, b) => a.ts - b.ts);
	return all;
}

initPool(config.db);
await withConnection(migrate);

console.log(
	`Capturing focus-places fixture — user ${userId}, conflated date ${conflatedDate}, ${lookbackDays}d lookback`,
);

const points = await fetchAllPoints(lookbackDays);
const filtered = points.filter((p) => p.accuracy === null || p.accuracy <= ACCURACY_FILTER_M);
const stays = detectStays(filtered);
// clusterStays only — capture the conflated input, before splitCluster.
const clusters = clusterStays(stays);
console.log(`  ${points.length} points → ${stays.length} stays → ${clusters.length} clusters (pre-split)`);

// The conflated cluster carries the long evening stay on `conflatedDate`.
const utcDate = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);
let conflated: (typeof clusters)[number] | null = null;
let bestEveningLen = 0;
for (const c of clusters) {
	for (const s of c.stays) {
		const startHourUtc = new Date(s.startTs * 1000).getUTCHours();
		if (utcDate(s.startTs) === conflatedDate && startHourUtc >= 16 && s.durationSec > bestEveningLen) {
			bestEveningLen = s.durationSec;
			conflated = c;
		}
	}
}
if (conflated === null) {
	console.error(`No cluster has an evening stay starting on ${conflatedDate} — cannot identify the conflated cluster.`);
	process.exit(1);
}

// The Home cluster — a single noisy place the split must leave alone.
const displayNames = assignDisplayNames(clusters);
const homeId = [...displayNames.entries()].find(([, name]) => name === "Home")?.[0] ?? null;
const home = homeId === null ? null : (clusters.find((c) => c.id === homeId) ?? null);

console.log(
	`  conflated cluster: ${conflated.stays.length} stays, ${(conflated.totalDwellSec / 3600).toFixed(1)} h dwell`,
);
console.log(home ? `  home cluster: ${home.stays.length} stays` : "  home cluster: none found (omitted)");

const fixture = {
	schema: "focusplaces-fixture/1",
	user: userId,
	conflatedDate,
	capturedAt: new Date().toISOString(),
	conflated: {
		note: `cluster with the long evening stay on ${conflatedDate} — a fused café + residence`,
		stays: conflated.stays,
	},
	home: home === null ? null : { note: "Home cluster — one noisy place, must NOT split", stays: home.stays },
};

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(fixture));
console.log(`Wrote ${outPath}`);
process.exit(0);
