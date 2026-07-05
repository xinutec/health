// Eyeball the road map-matcher on a captured day: per road-vehicle leg,
// report fix count, raw vs matched path length, and how far the raw fixes
// vs the matched vertices sit from the road network. The rail-snap lesson:
// a green e2e is not the verdict — look at whether the match is actually
// better than the raw track.
//
// Usage: nix-shell -p nodejs_24 --run 'node scripts/roadmatch-report.mjs [fixture.json]'
// (run `npm run build` first — imports the compiled matcher from dist/).

import { readFileSync } from "node:fs";
import { matchRoadSegment, projectPointToSegment } from "../dist/geo/road-match.js";

const fixturePath = process.argv[2] ?? "tests/fixtures/roadmatch/2026-06-21-pippijn.json";
const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
const geo = { ways: fx.osmRoadWays };
const ROAD_MODES = new Set(["driving", "bus", "cycling"]);

function metersBetween(aLat, aLon, bLat, bLon) {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}
function distToNetwork(lat, lon) {
	let best = Infinity;
	for (const w of geo.ways) {
		for (let i = 1; i < w.coords.length; i++) {
			const d = projectPointToSegment(
				{ lat, lon },
				{ lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] },
				{ lat: w.coords[i][0], lon: w.coords[i][1] },
			).distM;
			if (d < best) best = d;
		}
	}
	return best;
}
function pathLength(pts) {
	let t = 0;
	for (let i = 1; i < pts.length; i++) t += metersBetween(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
	return t;
}
function stats(xs) {
	if (xs.length === 0) return { n: 0 };
	const s = [...xs].sort((a, b) => a - b);
	const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
	return { n: s.length, med: q(0.5).toFixed(1), p95: q(0.95).toFixed(1), max: s.at(-1).toFixed(1) };
}

console.log(`fixture: ${fixturePath}`);
console.log(`road ways: ${geo.ways.length}`);
const roadSegs = fx.segments.filter((s) => ROAD_MODES.has(s.refinedMode ?? s.mode));
console.log(`road-vehicle legs: ${roadSegs.length}\n`);

for (const [i, seg] of roadSegs.entries()) {
	const fixes = fx.rawFixes.filter((f) => f.ts >= seg.startTs && f.ts <= seg.endTs);
	const mode = seg.refinedMode ?? seg.mode;
	const durMin = ((seg.endTs - seg.startTs) / 60).toFixed(0);
	console.log(`── leg ${i}: ${mode}  ${durMin} min  ${fixes.length} fixes  way=${seg.wayName ?? "—"}`);
	if (fixes.length === 0) {
		console.log("   no fixes\n");
		continue;
	}
	const rawSnap = stats(fixes.map((f) => distToNetwork(f.lat, f.lon)));
	console.log(`   raw fix→road distance (m): med=${rawSnap.med} p95=${rawSnap.p95} max=${rawSnap.max}`);
	console.log(`   raw track length: ${pathLength(fixes).toFixed(0)} m`);
	const r = matchRoadSegment(fixes, geo);
	if (r === null) {
		console.log("   MATCH: null (falls back to raw)\n");
		continue;
	}
	const matchedSnap = stats(r.path.map((p) => distToNetwork(p.lat, p.lon)));
	console.log(`   MATCH: ${r.path.length} vertices  length ${pathLength(r.path).toFixed(0)} m`);
	console.log(`   matched vertex→road distance (m): med=${matchedSnap.med} p95=${matchedSnap.p95} max=${matchedSnap.max}`);
	console.log("");
}
