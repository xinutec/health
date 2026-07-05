// Find the largest "out-and-back" excursion in each road leg's matched
// path: the contiguous run that bulges farthest from the straight chord
// between its entry/exit. Report its extra distance, time window, implied
// speed, and whether any RAW GPS fix supports the excursion (→ the matcher
// faithfully followed a scattered fix) or not (→ a routing artifact).
//
// Usage: node scripts/detour-probe.mjs

import { readFileSync } from "node:fs";
import { matchRoadSegment } from "../dist/geo/road-match.js";

const fx = JSON.parse(readFileSync("tests/fixtures/roadmatch/2026-06-21-pippijn.json", "utf8"));
const geo = { ways: fx.osmRoadWays };
const ROAD = new Set(["driving", "bus", "cycling"]);
const hhmmss = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);

function m(aLat, aLon, bLat, bLon) {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}
// perpendicular distance of p from segment a-b
function perp(p, a, b) {
	const cl = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	const ax = 0,
		ay = 0;
	const bx = (b.lon - a.lon) * 111_320 * cl,
		by = (b.lat - a.lat) * 111_320;
	const px = (p.lon - a.lon) * 111_320 * cl,
		py = (p.lat - a.lat) * 111_320;
	const L2 = bx * bx + by * by;
	let t = L2 === 0 ? 0 : (px * bx + py * by) / L2;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(px - t * bx, py - t * by);
}

const roadSegs = fx.segments.filter((s) => ROAD.has(s.refinedMode ?? s.mode));
for (const [i, seg] of roadSegs.entries()) {
	const fixes = fx.rawFixes.filter((f) => f.ts >= seg.startTs && f.ts <= seg.endTs);
	const res = matchRoadSegment(fixes.map((f) => ({ lat: f.lat, lon: f.lon, ts: f.ts })), geo);
	console.log(`\n── leg ${i} (${seg.refinedMode ?? seg.mode}) ${hhmmss(seg.startTs)}–${hhmmss(seg.endTs)}  ${fixes.length} fixes`);
	if (!res) {
		console.log("   no match");
		continue;
	}
	const P = res.path;
	// Find the vertex that is farthest from the chord between its k-back and
	// k-forward neighbours — the apex of an excursion. Scan a window.
	let best = { bulge: 0 };
	for (let a = 0; a < P.length - 2; a++) {
		for (let b = a + 2; b < P.length && b <= a + 14; b++) {
			let maxd = 0;
			let apex = a;
			for (let k = a + 1; k < b; k++) {
				const d = perp(P[k], P[a], P[b]);
				if (d > maxd) {
					maxd = d;
					apex = k;
				}
			}
			if (maxd > best.bulge) best = { bulge: maxd, a, b, apex };
		}
	}
	if (best.bulge < 15) {
		console.log(`   no significant excursion (max bulge ${best.bulge.toFixed(0)} m) — path hugs the corridor`);
		continue;
	}
	const { a, b, apex } = best;
	let along = 0;
	for (let k = a + 1; k <= b; k++) along += m(P[k - 1].lat, P[k - 1].lon, P[k].lat, P[k].lon);
	const chord = m(P[a].lat, P[a].lon, P[b].lat, P[b].lon);
	const dt = P[b].ts - P[a].ts;
	// nearest raw fix to the apex of the excursion
	let nearRaw = { d: Infinity };
	for (const f of fixes) {
		const d = m(P[apex].lat, P[apex].lon, f.lat, f.lon);
		if (d < nearRaw.d) nearRaw = { d, f };
	}
	console.log(`   largest excursion: apex ${best.bulge.toFixed(0)} m off the chord (path vertices ${a}→${b} of ${P.length})`);
	console.log(`     window ${hhmmss(P[a].ts)} → ${hhmmss(P[b].ts)}  (${dt}s)`);
	console.log(`     path along it: ${along.toFixed(0)} m   straight chord: ${chord.toFixed(0)} m   extra: ${(along - chord).toFixed(0)} m`);
	console.log(`     implied avg speed across the excursion: ${dt > 0 ? ((along / dt) * 3.6).toFixed(1) : "∞"} km/h`);
	console.log(`     nearest RAW GPS fix to the apex: ${nearRaw.d.toFixed(0)} m away (acc=${nearRaw.f?.accuracy ?? "?"}) at ${hhmmss(nearRaw.f?.ts)}`);
	console.log(`     → ${nearRaw.d < 40 ? "a real fix sits out there — matcher followed the GPS" : "NO raw fix supports it — Viterbi routing artifact"}`);
}
