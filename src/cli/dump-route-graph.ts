/**
 * Diagnostic CLI: build a RouteGraph for a user's recent-history
 * bbox and print summary statistics. Used to verify Phase 0 of the
 * route-aware decoder on real OSM data before any decoder changes
 * consume the graph.
 *
 * Usage:
 *   scripts/prod-db.sh node dist/cli/dump-route-graph.js
 *   scripts/prod-db.sh node dist/cli/dump-route-graph.js --days 14
 *   scripts/prod-db.sh node dist/cli/dump-route-graph.js --feature-types railway
 *   scripts/prod-db.sh node dist/cli/dump-route-graph.js --probe 51.530,-0.124
 */

import { sql } from "kysely";
import { z } from "zod";
import { db, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import type { RouteEdge, RouteGraph } from "../geo/route-graph.js";
import { bboxFromFixes, loadRouteGraphForBbox } from "../geo/route-graph-loader.js";

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
	userId: string;
	featureTypes: readonly string[] | undefined;
	probes: { lat: number; lon: number; label?: string }[];
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	let userId = "pippijn";
	let featureTypes: string[] | undefined;
	const probes: CliArgs["probes"] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--user") userId = args[++i] ?? userId;
		else if (a === "--feature-types") {
			const v = args[++i] ?? "";
			featureTypes = v
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		} else if (a === "--probe") {
			const v = args[++i] ?? "";
			const m = /^([-\d.]+),([-\d.]+)(?::(.+))?$/.exec(v);
			if (m) probes.push({ lat: Number(m[1]), lon: Number(m[2]), label: m[3] });
		}
	}
	return { userId, featureTypes, probes };
}

/** Pull the lat/lon of the user's focus places — used as a proxy
 *  for the user's geographic envelope. Cheap (DB-only, no NC).
 *  Phase 0 doesn't need second-by-second fix history; we want the
 *  bbox enclosing the user's lived geography to bound the route
 *  graph extraction. */
async function loadUserGeographyPoints(userId: string): Promise<{ lat: number; lon: number }[]> {
	void sql; // sql import retained for future fix-source fallback
	const rows = await db()
		.selectFrom("focus_places")
		.where("user_id", "=", userId)
		.select(["centroid_lat", "centroid_lon"])
		.execute();
	return rows.map((r) => ({ lat: Number(r.centroid_lat), lon: Number(r.centroid_lon) }));
}

function topN(counts: Map<string, number>, n: number): [string, number][] {
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function reportGraph(g: RouteGraph, label: string): void {
	const featureTypeCounts = new Map<string, number>();
	const subtypeCounts = new Map<string, number>();
	const lineCounts = new Map<string, number>();
	let undergroundCount = 0;
	let withLineMembership = 0;
	let totalLengthM = 0;

	for (const e of g.edges.values()) {
		featureTypeCounts.set(e.attrs.featureType, (featureTypeCounts.get(e.attrs.featureType) ?? 0) + 1);
		const subKey = `${e.attrs.featureType}:${e.attrs.subtype ?? "—"}`;
		subtypeCounts.set(subKey, (subtypeCounts.get(subKey) ?? 0) + 1);
		if (e.attrs.underground) undergroundCount++;
		if (e.attrs.lineMemberships.size > 0) {
			withLineMembership++;
			for (const line of e.attrs.lineMemberships) {
				lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
			}
		}
		totalLengthM += e.attrs.lengthM;
	}

	let stationedNodes = 0;
	for (const n of g.nodes.values()) if (n.stationName !== undefined) stationedNodes++;

	console.log(`\n## ${label}`);
	console.log(`  Edges: ${g.edges.size}  (total length ${(totalLengthM / 1000).toFixed(1)} km)`);
	console.log(`  Nodes: ${g.nodes.size}  (with station data: ${stationedNodes})`);
	console.log(`  Underground edges: ${undergroundCount}`);
	console.log(`  Edges with line membership: ${withLineMembership}`);

	console.log(`\n  Top feature types:`);
	for (const [ft, n] of topN(featureTypeCounts, 8)) console.log(`    ${n.toString().padStart(6)}  ${ft}`);

	console.log(`\n  Top subtypes:`);
	for (const [sub, n] of topN(subtypeCounts, 12)) console.log(`    ${n.toString().padStart(6)}  ${sub}`);

	console.log(`\n  Top lines (by edge count):`);
	for (const [line, n] of topN(lineCounts, 15)) console.log(`    ${n.toString().padStart(6)}  ${line}`);
}

function reportProbe(g: RouteGraph, p: { lat: number; lon: number; label?: string }): void {
	const nearby = g.edgesNear(p.lat, p.lon, 500);
	const tag = p.label ?? `(${p.lat.toFixed(5)}, ${p.lon.toFixed(5)})`;
	console.log(`\n## Probe ${tag}`);
	console.log(`  ${nearby.length} edges within 500 m`);

	const byLine = new Map<string, RouteEdge[]>();
	for (const e of nearby) {
		for (const line of e.attrs.lineMemberships) {
			let arr = byLine.get(line);
			if (arr === undefined) {
				arr = [];
				byLine.set(line, arr);
			}
			arr.push(e);
		}
	}

	if (byLine.size > 0) {
		console.log(`  Lines passing through:`);
		const sorted = [...byLine.entries()].sort((a, b) => b[1].length - a[1].length);
		for (const [line, edges] of sorted) {
			const underground = edges.filter((e) => e.attrs.underground).length;
			console.log(`    ${edges.length.toString().padStart(3)} edges  (${underground} underground)  ${line}`);
		}
	} else {
		console.log(`  No edges with line memberships nearby.`);
	}

	const byFeatureType = new Map<string, number>();
	for (const e of nearby) {
		byFeatureType.set(e.attrs.featureType, (byFeatureType.get(e.attrs.featureType) ?? 0) + 1);
	}
	console.log(`  Feature types in range:`);
	for (const [ft, n] of [...byFeatureType.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`    ${n.toString().padStart(3)}  ${ft}`);
	}
}

async function main(): Promise<void> {
	const args = parseArgs();
	initPool(config.db);
	await withConnection(migrate);

	console.error(`# dump-route-graph user=${args.userId} featureTypes=${args.featureTypes?.join(",") ?? "(all)"}`);

	const geographyPoints = await loadUserGeographyPoints(args.userId);
	console.error(`# ${geographyPoints.length} focus-place centroids loaded as bbox seed`);
	const bbox = bboxFromFixes(geographyPoints);
	if (bbox === null) {
		console.error("# no focus places — bbox cannot be computed");
		process.exit(1);
	}
	console.error(
		`# bbox: lat ${bbox.minLat.toFixed(5)} → ${bbox.maxLat.toFixed(5)}, lon ${bbox.minLon.toFixed(5)} → ${bbox.maxLon.toFixed(5)}`,
	);

	const t0 = Date.now();
	const graph = await loadRouteGraphForBbox(bbox, { featureTypes: args.featureTypes });
	const dt = Date.now() - t0;
	console.error(`# graph built in ${dt}ms`);

	reportGraph(graph, `Route graph (${args.featureTypes?.join("+") ?? "all features"})`);

	for (const p of args.probes) reportProbe(graph, p);

	process.exit(0);
}

await main();
