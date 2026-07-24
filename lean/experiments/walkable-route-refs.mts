/**
 * V8 reference values for the Lean port of `src/geo/walkable-route.ts`
 * (point-to-point routing on the walkable network).
 *
 * Emits BOTH the shell-built graph (nodes / adjacency / snap edges) and the
 * route, because the Lean twin takes the fused graph as input — coordinate
 * fusion by `nodeKey` (a `toFixed(7)` string) is shell work under the port's
 * standing boundary, so the Lean side must be fed the same topology it would
 * receive in production.
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/walkable-route-refs.mts
 */

import { buildWalkGraph, routeOnWalkable } from "../../src/geo/walkable-route.js";
import { projectPointToSegment, type RoadGeometry } from "../../src/geo/map-match-core.js";

const f = (x: number): string => (Number.isFinite(x) ? x.toPrecision(17) : String(x));

type Coord = [number, number]; // [lat, lon]
function geoOf(ways: Coord[][]): RoadGeometry {
	return {
		ways: ways.map((coords, i) => ({ id: i + 1, name: `w${i + 1}`, subtype: "footway", coords })),
	} as RoadGeometry;
}

/** A city block: a closed square ring plus a stub, at ~London latitude.
 *  0.0009 deg lat ~= 100 m; lon scaled so the block is roughly square. */
const LAT0 = 51.52;
const LON0 = -0.13;
const D = 0.0009;
const BLOCK: Coord[][] = [
	// south edge, west edge, north edge, east edge (four separate ways that
	// meet at exact shared corner coordinates — the OSM junction convention)
	[
		[LAT0, LON0],
		[LAT0, LON0 + D],
	],
	[
		[LAT0, LON0],
		[LAT0 + D, LON0],
	],
	[
		[LAT0 + D, LON0],
		[LAT0 + D, LON0 + D],
	],
	[
		[LAT0, LON0 + D],
		[LAT0 + D, LON0 + D],
	],
];

console.log("=== projectPointToSegment ===");
{
	const a = { lat: LAT0, lon: LON0 };
	const b = { lat: LAT0, lon: LON0 + D };
	for (const [label, p] of [
		["before a", { lat: LAT0, lon: LON0 - D }],
		["at a", { lat: LAT0, lon: LON0 }],
		["midpoint", { lat: LAT0, lon: LON0 + D / 2 }],
		["past b", { lat: LAT0, lon: LON0 + 2 * D }],
		["offset north", { lat: LAT0 + D / 3, lon: LON0 + D / 2 }],
	] as [string, { lat: number; lon: number }][]) {
		const r = projectPointToSegment(p, a, b);
		console.log(`${label}: lat=${f(r.lat)} lon=${f(r.lon)} t=${f(r.t)} distM=${f(r.distM)}`);
	}
	// Degenerate segment (a === b): t is 0 and the projection is a.
	const deg = projectPointToSegment({ lat: LAT0 + D, lon: LON0 }, a, a);
	console.log(`degenerate: lat=${f(deg.lat)} lon=${f(deg.lon)} t=${f(deg.t)} distM=${f(deg.distM)}`);
}

console.log("");
console.log("=== buildWalkGraph (the shell-side topology the Lean twin is fed) ===");
function dumpGraph(label: string, ways: Coord[][]): void {
	const geo = geoOf(ways);
	const g = buildWalkGraph(geo);
	console.log(`${label}: ${g.nodes.length} nodes`);
	g.nodes.forEach((n, i) => console.log(`  node ${i}: ${f(n.lat)} ${f(n.lon)}`));
	g.adj.forEach((es, i) =>
		console.log(`  adj ${i}: ${es.map((e) => `${e.to}@${f(e.distM)}`).join(" ") || "(none)"}`),
	);
	// The snap-edge list, in way-iteration order, with resolved node ids.
	const idx = new Map<string, number>();
	g.nodes.forEach((n, i) => idx.set(`${n.lat.toFixed(7)},${n.lon.toFixed(7)}`, i));
	let k = 0;
	for (const w of geo.ways) {
		for (let i = 1; i < w.coords.length; i++) {
			const a = w.coords[i - 1];
			const b = w.coords[i];
			const ia = idx.get(`${a[0].toFixed(7)},${a[1].toFixed(7)}`);
			const ib = idx.get(`${b[0].toFixed(7)},${b[1].toFixed(7)}`);
			console.log(`  edge ${k++}: ${f(a[0])} ${f(a[1])} -> ${f(b[0])} ${f(b[1])} ids=${ia},${ib}`);
		}
	}
}
dumpGraph("block", BLOCK);

console.log("");
console.log("=== routeOnWalkable ===");
function route(
	label: string,
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
	ways: Coord[][],
	opts: Partial<{ snapRadiusM: number; maxRouteM: number }> = {},
): void {
	const r = routeOnWalkable(a, b, geoOf(ways), opts);
	if (r === null) {
		console.log(`${label}: null`);
		return;
	}
	console.log(`${label}: ${r.length} pts`);
	for (const p of r) console.log(`  ${f(p.lat)} ${f(p.lon)}`);
}

// Empty network: nothing to route on.
route("empty network", { lat: LAT0, lon: LON0 }, { lat: LAT0 + D, lon: LON0 }, []);
// Both endpoints project onto the SAME edge → straight along it, no Dijkstra.
route(
	"same edge",
	{ lat: LAT0, lon: LON0 + D * 0.25 },
	{ lat: LAT0, lon: LON0 + D * 0.75 },
	BLOCK,
);
// Around a corner: south edge to west edge.
route("around one corner", { lat: LAT0, lon: LON0 + D * 0.5 }, { lat: LAT0 + D * 0.5, lon: LON0 }, BLOCK);
// Diagonal across the block: two equal-length ways round — the heap's pop order
// among equal keys decides which, so this pins the heap itself.
route("diagonal (equal-cost tie)", { lat: LAT0, lon: LON0 }, { lat: LAT0 + D, lon: LON0 + D }, BLOCK);
// Endpoint too far from any way.
route("endpoint out of snap radius", { lat: LAT0 + 0.01, lon: LON0 }, { lat: LAT0, lon: LON0 + D }, BLOCK);
// Snap radius tightened until it fails.
route("snap radius 5m ok", { lat: LAT0 + 0.00002, lon: LON0 + D * 0.5 }, { lat: LAT0 + D * 0.5, lon: LON0 }, BLOCK, {
	snapRadiusM: 5,
});
route("snap radius 1m fails", { lat: LAT0 + 0.00002, lon: LON0 + D * 0.5 }, { lat: LAT0 + D * 0.5, lon: LON0 }, BLOCK, {
	snapRadiusM: 1,
});
// maxRouteM bound: the corner route is ~100 m, so 50 m must refuse it.
route("maxRoute 50m refuses", { lat: LAT0, lon: LON0 + D * 0.5 }, { lat: LAT0 + D * 0.5, lon: LON0 }, BLOCK, {
	maxRouteM: 50,
});
// Disconnected network: two separate ways with no shared coordinate.
const SPLIT: Coord[][] = [
	[
		[LAT0, LON0],
		[LAT0, LON0 + D],
	],
	[
		[LAT0 + 5 * D, LON0],
		[LAT0 + 5 * D, LON0 + D],
	],
];
route("disconnected", { lat: LAT0, lon: LON0 }, { lat: LAT0 + 5 * D, lon: LON0 }, SPLIT, { snapRadiusM: 2000 });
dumpGraph("split", SPLIT);
