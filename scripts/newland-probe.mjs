import { readFileSync } from "node:fs";
import { matchRoadSegment, projectPointToSegment } from "../dist/geo/road-match.js";

const fx = JSON.parse(readFileSync("tests/fixtures/roadmatch/2026-06-21-pippijn.json", "utf8"));
const geo = { ways: fx.osmRoadWays };
const hh = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);
function nm(lat, lon) {
	let b = Infinity,
		n = "?";
	for (const w of geo.ways) {
		if (!w.name) continue;
		for (let i = 1; i < w.coords.length; i++) {
			const d = projectPointToSegment(
				{ lat, lon },
				{ lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] },
				{ lat: w.coords[i][0], lon: w.coords[i][1] },
			).distM;
			if (d < b) {
				b = d;
				n = w.name;
			}
		}
	}
	return n;
}
const seg = fx.segments.filter((s) => ["driving"].includes(s.refinedMode ?? s.mode))[1];
const fixes = fx.rawFixes.filter((f) => f.ts >= seg.startTs && f.ts <= seg.endTs);
const res = matchRoadSegment(
	fixes.map((f) => ({ lat: f.lat, lon: f.lon, ts: f.ts })),
	geo,
);
console.log(`local repro: ${res.path.length} verts`);
for (const p of res.path) console.log(`  ${hh(p.ts)}  ${p.lat.toFixed(5)},${p.lon.toFixed(5)}  ${nm(p.lat, p.lon)}`);

const nc = geo.ways.filter((w) => w.name === "Newland Court");
console.log(`\nNewland Court ways: ${nc.length}`);
for (const w of nc) {
	const a = w.coords[0];
	const z = w.coords[w.coords.length - 1];
	console.log(`  end1 ${a} on→ ${nm(a[0], a[1])} | end2 ${z} on→ ${nm(z[0], z[1])} | ${w.coords.length}pts`);
}
