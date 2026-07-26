/**
 * Does this port's line metric reproduce MariaDB's `ST_Distance`? No — and the
 * difference is a MariaDB defect, not a porting error.
 *
 * # The finding
 *
 * MariaDB 12.3.2 computes the true perpendicular for a TWO-POINT linestring but
 * returns the distance to the nearest VERTEX for a multi-vertex one. Same point,
 * same coordinates, measured on the live server:
 *
 *     full 12-vertex line   0.002419365488074187   = distance to vertex 2
 *     its segment 1 alone   0.002405760590290686   = the true perpendicular
 *
 * `lineDistDeg` computes the true minimum over segments — checked against an
 * independent dense-sampling brute force, which agrees to 1e-13 and puts the
 * minimum mid-segment. So the port is right and the database is wrong.
 *
 * # How this was missed the first time
 *
 * The original port confirmed `ST_Distance`'s semantics against the live server
 * — but on a two-vertex fixture, which cannot tell "minimum over segments" from
 * "distance to the nearest vertex". A fixture that cannot distinguish the
 * candidate behaviours does not confirm one of them, however real the server it
 * ran against.
 *
 * # And how its SIZE was understated the second time (2026-07-26)
 *
 * The corpus-scale section below originally reported "4 of 3840 ways differ,
 * worst 0.94 m". Those numbers are right for what they sampled and wrong as a
 * description of the impact: the dump query draws `highway`/`railway` rows, and
 * roads carry dense vertices along their curves, so the perpendicular foot is
 * never far from a vertex. The defect's size IS the vertex spacing along the
 * nearest edge — so it is centimetres on a road and tens of metres on a polygon
 * wall, where vertices sit only at the corners. `nearbyLandmarks` reads closed
 * ways (parks, buildings, car parks) and the full-corpus replay in
 * `osm-rowset-parity.mts` finds 17.67 m there, and 37.96 m on `nearbyWays`.
 *
 * The `POLYGON_CASE` below is that case, kept alongside the road case precisely
 * so the two magnitudes sit next to each other and neither can be quoted as
 * "the" impact again. The general lesson: when a measurement's spread depends
 * on a property of the input (here, vertex spacing), sample across that
 * property — an average over one regime is not a bound.
 *
 * # Reproducing it
 *
 * Needs the mirror, so it runs in two halves. First, on a host that can reach
 * the DB (`ssh root@isis.xinutec.org`, then `kubectl -n health exec …`), the
 * decisive synthetic case:
 *
 *     SET @pt   = ST_GeomFromText('POINT(-0.13579848336856729 51.525668698640004)',4326);
 *     SET @full = ST_GeomFromText('LINESTRING(-0.1364904 51.5281741,-0.1359684 51.5280857,
 *                  -0.1354246 51.528059,-0.1350349 51.5280875,-0.1346595 51.5281412,
 *                  -0.1343061 51.5282137,-0.1338819 51.528328,-0.1335473 51.5284454,
 *                  -0.1331854 51.528577,-0.1324887 51.5287875,-0.1316731 51.5290462,
 *                  -0.1309924 51.5293015)',4326);
 *     SET @seg1 = ST_GeomFromText('LINESTRING(-0.1359684 51.5280857,-0.1354246 51.528059)',4326);
 *     SET @v2   = ST_GeomFromText('POINT(-0.1354246 51.528059)',4326);
 *     SELECT ST_Distance(@full,@pt), ST_Distance(@seg1,@pt), ST_Distance(@v2,@pt);
 *
 * `ST_Distance(@full,@pt)` equals `ST_Distance(@v2,@pt)` exactly, and both
 * differ from `ST_Distance(@seg1,@pt)`.
 *
 * Second, the corpus-scale impact. Dump real geometry near real captured query
 * points with the query at the bottom of this file, save it as TSV, and pass
 * the path as argv[2]. Without a dump this script just prints the synthetic
 * case, which is the part that establishes the semantics.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx \
 *        lean/experiments/osm-line-metric-vs-mariadb.mts [dump.tsv]
 */

import { readFileSync } from "node:fs";
import { parseLineStringWkt } from "../../src/geo/osm-local.js";
import { lineDistDeg, mPerDegAt } from "../../src/geo/osm-rowset-query.js";

/** The case that establishes the semantics, checkable without a DB: the port's
 *  answer, and the two things MariaDB could have returned. */
const CASE = {
	qlat: 51.525668698640004,
	qlon: -0.13579848336856729,
	coords: [
		[51.5281741, -0.1364904],
		[51.5280857, -0.1359684],
		[51.528059, -0.1354246],
		[51.5280875, -0.1350349],
		[51.5281412, -0.1346595],
		[51.5282137, -0.1343061],
		[51.528328, -0.1338819],
		[51.5284454, -0.1335473],
		[51.528577, -0.1331854],
		[51.5287875, -0.1324887],
		[51.5290462, -0.1316731],
		[51.5293015, -0.1309924],
	] as Array<[number, number]>,
	mariaFullLine: 0.002419365488074187,
	mariaSegment1: 0.002405760590290686,
};

/**
 * The polygon case — the same defect where it actually hurts.
 *
 * Real measurement, replayed from the golden corpus on 2026-07-26: the query
 * point sits 2.0687 m from the boundary of Paleistuin (`osm_lines` 86909138, a
 * 59-vertex closed park way), and 16.9640 m from that boundary's nearest
 * VERTEX. MariaDB returned 16.9640 m — bit-identical to the vertex distance,
 * not to the edge.
 *
 * `SYNTH` reproduces the mechanism without a DB: a rectangle whose long wall
 * runs `WALL_M` metres between corners, with the query point `OFFSET_M` from
 * the middle of that wall. The error is then bounded below by
 * `sqrt(OFFSET² + (WALL/2)²) − OFFSET`, which grows with wall length — that is
 * why a park or a car park loses tens of metres and a curved road loses
 * centimetres.
 */
const PALEISTUIN = { trueEdgeM: 2.0687, mariaVertexM: 16.964, verts: 59, osmId: 86909138 };
const SYNTH = { qlat: 51.5, qlon: -0.13, wallM: 60, offsetM: 3 };

const mine = lineDistDeg(CASE.coords, CASE.qlat, CASE.qlon);
let nearestVertex = Number.POSITIVE_INFINITY;
for (const [la, lo] of CASE.coords) {
	nearestVertex = Math.min(nearestVertex, Math.hypot(CASE.qlon - lo, CASE.qlat - la));
}
const mpd = mPerDegAt(CASE.qlat);

console.log("the decisive case:");
console.log(`  this port (true minimum over segments) : ${mine}`);
console.log(`  MariaDB, full 12-vertex line           : ${CASE.mariaFullLine}`);
console.log(`  MariaDB, that line's segment 1 alone   : ${CASE.mariaSegment1}`);
console.log(`  distance to the nearest VERTEX         : ${nearestVertex}`);
console.log(
	`\n  MariaDB's full-line answer matches the VERTEX to ${Math.abs(CASE.mariaFullLine - nearestVertex).toExponential(2)}`,
);
console.log(`  and this port matches its SEGMENT answer to ${Math.abs(mine - CASE.mariaSegment1).toExponential(2)}`);
console.log(`  the gap the defect opens: ${((CASE.mariaFullLine - mine) * mpd).toFixed(4)} m`);

// The polygon case, where the same defect is three orders of magnitude larger.
{
	const mpdS = mPerDegAt(SYNTH.qlat);
	const halfWallDeg = SYNTH.wallM / 2 / mpdS;
	const offDeg = SYNTH.offsetM / mpdS;
	// A rectangle sitting `offsetM` north of the query point, its southern wall
	// running east–west with corners only at the ends.
	const rect: Array<[number, number]> = [
		[SYNTH.qlat + offDeg, SYNTH.qlon - halfWallDeg],
		[SYNTH.qlat + offDeg, SYNTH.qlon + halfWallDeg],
		[SYNTH.qlat + offDeg + halfWallDeg, SYNTH.qlon + halfWallDeg],
		[SYNTH.qlat + offDeg + halfWallDeg, SYNTH.qlon - halfWallDeg],
		[SYNTH.qlat + offDeg, SYNTH.qlon - halfWallDeg],
	];
	const edge = lineDistDeg(rect, SYNTH.qlat, SYNTH.qlon) * mpdS;
	let vtx = Number.POSITIVE_INFINITY;
	for (const [la, lo] of rect) vtx = Math.min(vtx, Math.hypot(SYNTH.qlon - lo, SYNTH.qlat - la));
	console.log(`\nthe polygon case — a ${SYNTH.wallM} m wall, query point ${SYNTH.offsetM} m off its middle:`);
	console.log(`  true distance to the wall  : ${edge.toFixed(4)} m`);
	console.log(`  distance to nearest CORNER : ${(vtx * mpdS).toFixed(4)} m  <- what MariaDB would return`);
	console.log(`  the defect                 : ${(vtx * mpdS - edge).toFixed(4)} m`);
	console.log(
		`\n  real instance (Paleistuin, osm ${PALEISTUIN.osmId}, ${PALEISTUIN.verts} vertices):` +
			`\n    true ${PALEISTUIN.trueEdgeM} m vs MariaDB ${PALEISTUIN.mariaVertexM} m — a ${(PALEISTUIN.mariaVertexM - PALEISTUIN.trueEdgeM).toFixed(2)} m error,` +
			`\n    which crosses venue-prior's NEAR_FIELD_DECISIVE_M = 12 in the wrong direction.`,
	);
}

const dumpPath = process.argv[2];
if (!dumpPath) {
	console.log("\n(no dump given — skipping the corpus-scale impact; see the header)");
	process.exit(0);
}

interface Rec {
	key: string;
	qlat: number;
	id: string;
	maria: number;
	mine: number;
	verts: number;
}
const recs: Rec[] = [];
for (const line of readFileSync(dumpPath, "utf8").split("\n")) {
	if (!line.includes("LINESTRING")) continue;
	const [date, qlatS, qlonS, id, mariaS, wkt] = line.split("\t");
	const qlat = Number(qlatS);
	const qlon = Number(qlonS);
	const maria = Number(mariaS);
	const coords = parseLineStringWkt(wkt);
	if (!Number.isFinite(maria) || coords.length < 2) continue;
	recs.push({
		key: `${date}|${qlat}|${qlon}`,
		qlat,
		id,
		maria,
		mine: lineDistDeg(coords, qlat, qlon),
		verts: coords.length,
	});
}

const differs = (r: Rec) => Math.abs(r.mine - r.maria) > 1e-12;
const two = recs.filter((r) => r.verts === 2);
const multi = recs.filter((r) => r.verts > 2);
console.log(`\nways compared: ${recs.length} (2-vertex ${two.length}, multi-vertex ${multi.length})`);
console.log(`  2-vertex that differ    : ${two.filter(differs).length}`);
console.log(`  multi-vertex that differ: ${multi.filter(differs).length}`);
console.log(`  port ever FARTHER than MariaDB: ${recs.filter((r) => r.mine > r.maria + 1e-12).length} (must be 0)`);

const worst = Math.max(...recs.map((r) => (r.maria - r.mine) * mPerDegAt(r.qlat)));
console.log(`  worst divergence: ${worst.toFixed(4)} m`);

console.log("\nfeatures crossing the bar (MariaDB out -> port IN), per radius the pass list uses:");
const byQuery = new Map<string, Rec[]>();
for (const r of recs) byQuery.set(r.key, [...(byQuery.get(r.key) ?? []), r]);
for (const radius of [50, 100, 300, 400, 800]) {
	let flips = 0;
	let closest = Number.POSITIVE_INFINITY;
	for (const [, items] of byQuery) {
		const dDeg = radius / mPerDegAt(items[0].qlat);
		for (const r of items) {
			if (r.maria >= dDeg && r.mine < dDeg) flips++;
			else closest = Math.min(closest, Math.abs(r.mine - dDeg) * mPerDegAt(r.qlat));
		}
	}
	console.log(`  r=${String(radius).padStart(3)}: ${flips} flips (nearest non-flipping way ${closest.toFixed(3)} m from the bar)`);
}
console.log(
	"\nNOTE: unlike the sphere change this is NOT provably safe — the error can reach" +
		"\n~1 m and the nearest margin observed is centimetres. Zero flips is an empirical" +
		"\nresult on this corpus, not a guarantee.",
);
