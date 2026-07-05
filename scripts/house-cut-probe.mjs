// For each segment of the matched path, sample along it and measure how far
// the sampled points sit from the nearest road. A segment whose interior
// strays from the road network is the straight-line "driving over houses"
// artifact. Compares the simplified output (what ships) against the full
// routed path (every OSM vertex) to attribute the cause.

import { readFileSync } from "node:fs";
import { matchRoadSegment, projectPointToSegment } from "../dist/geo/road-match.js";

const fx = JSON.parse(readFileSync("tests/fixtures/roadmatch/2026-06-21-pippijn.json", "utf8"));
const geo = { ways: fx.osmRoadWays };
const hh = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);
function distToRoads(lat, lon) {
	let b = Infinity;
	for (const w of geo.ways)
		for (let i = 1; i < w.coords.length; i++) {
			const d = projectPointToSegment(
				{ lat, lon },
				{ lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] },
				{ lat: w.coords[i][0], lon: w.coords[i][1] },
			).distM;
			if (d < b) b = d;
		}
	return b;
}
function m(a, b, c, d) {
	const dl = (c - a) * 111320,
		dn = (d - b) * 111320 * Math.cos(((a + c) / 2) * Math.PI / 180);
	return Math.hypot(dl, dn);
}
// worst interior off-road distance of a straight segment a->b (sample every ~10m)
function worstOffRoad(a, b) {
	const len = m(a.lat, a.lon, b.lat, b.lon);
	const n = Math.max(1, Math.round(len / 10));
	let worst = 0;
	for (let k = 1; k < n; k++) {
		const f = k / n;
		const d = distToRoads(a.lat + f * (b.lat - a.lat), a.lon + f * (b.lon - a.lon));
		if (d > worst) worst = d;
	}
	return { worst, len };
}

for (const [li, seg] of fx.segments.filter((s) => ["driving"].includes(s.refinedMode ?? s.mode)).entries()) {
	const fixes = fx.rawFixes.filter((f) => f.ts >= seg.startTs && f.ts <= seg.endTs);
	const res = matchRoadSegment(fixes.map((f) => ({ lat: f.lat, lon: f.lon, ts: f.ts })), geo);
	if (!res) continue;
	console.log(`\nLEG${li} (${res.path.length} verts) — segments whose interior leaves the road:`);
	for (let i = 1; i < res.path.length; i++) {
		const { worst, len } = worstOffRoad(res.path[i - 1], res.path[i]);
		if (worst > 12) console.log(`  ${hh(res.path[i - 1].ts)}→${hh(res.path[i].ts)}  len=${len.toFixed(0)}m  worst off-road=${worst.toFixed(0)}m  <<<`);
	}
}
