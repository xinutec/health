/**
 * Capture a bbox subset of `osm_lines` + `osm_points` to a JSON
 * fixture for use by route-graph tests.
 *
 * The route-aware decoder acceptance test
 * (`tests/route-aware-decoder-board-change.test.ts`) needs real OSM
 * geometry for a specific London corridor (Wembley → Baker St → KX
 * → Green Park) to verify that the inner Viterbi correctly splits
 * a Met/Jubilee board change. Synthetic graphs prove segmentation
 * logic but not real-world data interactions.
 *
 * The fixture format is plain JSON with line/point arrays
 * (bigint osm_ids serialised as strings). The same fixture loader
 * lives in the test file. Output directory is gitignored by repo
 * convention — the captured file contains real London coords.
 *
 * Usage (via scripts/prod-db.sh):
 *
 *   scripts/prod-db.sh node dist/cli/capture-route-graph-fixture.js \
 *     --min-lat 51.49 --min-lon -0.30 \
 *     --max-lat 51.58 --max-lon -0.10 \
 *     --feature-types railway \
 *     --out tests/fixtures/route-graphs/london-met-jubilee-corridor.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import { z } from "zod";
import { db, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import type { RawOsmLine, RawOsmPoint } from "../geo/route-graph.js";

const config = z
	.object({
		db: z.object({
			host: z.string().default("health-db"),
			port: z.coerce.number().default(3306),
			user: z.string(),
			password: z.string(),
			database: z.string().default("health"),
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
	});

interface CliArgs {
	minLat: number;
	minLon: number;
	maxLat: number;
	maxLon: number;
	featureTypes: string[];
	out: string;
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	let minLat: number | null = null;
	let minLon: number | null = null;
	let maxLat: number | null = null;
	let maxLon: number | null = null;
	let featureTypes: string[] = ["railway"];
	let out = "tests/fixtures/route-graphs/region.json";
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--min-lat") minLat = Number(args[++i]);
		else if (a === "--min-lon") minLon = Number(args[++i]);
		else if (a === "--max-lat") maxLat = Number(args[++i]);
		else if (a === "--max-lon") maxLon = Number(args[++i]);
		else if (a === "--feature-types") featureTypes = (args[++i] ?? "railway").split(",");
		else if (a === "--out") out = args[++i] ?? out;
	}
	if (minLat === null || minLon === null || maxLat === null || maxLon === null) {
		console.error(
			"usage: capture-route-graph-fixture --min-lat .. --min-lon .. --max-lat .. --max-lon .. [--feature-types railway,highway] [--out path]",
		);
		process.exit(2);
	}
	return { minLat, minLon, maxLat, maxLon, featureTypes, out };
}

function bboxPolygonWkt(b: { minLat: number; minLon: number; maxLat: number; maxLon: number }): string {
	return `POLYGON((${b.minLon} ${b.minLat}, ${b.maxLon} ${b.minLat}, ${b.maxLon} ${b.maxLat}, ${b.minLon} ${b.maxLat}, ${b.minLon} ${b.minLat}))`;
}

async function main(): Promise<void> {
	const args = parseArgs();
	initPool({
		host: config.db.host,
		port: config.db.port,
		user: config.db.user,
		password: config.db.password,
		database: config.db.database,
	});
	await withConnection(migrate);

	const poly = bboxPolygonWkt(args);

	const lineRows = (
		await sql<RawOsmLine>`
			SELECT osm_id, osm_type, feature_type, subtype, name, tags_json, ST_AsText(geom) AS geom
			FROM osm_lines
			WHERE feature_type IN (${sql.join(args.featureTypes)})
			  AND MBRIntersects(geom, ST_GeomFromText(${poly}, 4326))
		`.execute(db())
	).rows;

	const pointRowsRaw = (
		await sql<RawOsmPoint & { wkt: string }>`
			SELECT osm_id, osm_type, name, tags_json, ST_AsText(geom) AS wkt
			FROM osm_points
			WHERE MBRIntersects(geom, ST_GeomFromText(${poly}, 4326))
		`.execute(db())
	).rows;

	const pointRows: RawOsmPoint[] = [];
	for (const r of pointRowsRaw) {
		const m = /^POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)\s*$/i.exec(r.wkt);
		if (m === null) continue;
		const lon = Number(m[1]);
		const lat = Number(m[2]);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
		pointRows.push({ osm_id: r.osm_id, osm_type: r.osm_type, name: r.name, tags_json: r.tags_json, lat, lon });
	}

	const fixture = {
		bbox: { minLat: args.minLat, minLon: args.minLon, maxLat: args.maxLat, maxLon: args.maxLon },
		featureTypes: args.featureTypes,
		lines: lineRows.map((l) => ({ ...l, osm_id: l.osm_id.toString() })),
		points: pointRows.map((p) => ({ ...p, osm_id: p.osm_id.toString() })),
	};

	await mkdir(path.dirname(args.out), { recursive: true });
	await writeFile(args.out, `${JSON.stringify(fixture, null, 2)}\n`);

	console.log(`wrote ${args.out}`);
	console.log(`  lines:  ${fixture.lines.length}`);
	console.log(`  points: ${fixture.points.length}`);
}

await main();
process.exit(0);
