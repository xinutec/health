#!/usr/bin/env -S npx tsx
/**
 * `verified_cli head` vs the TS it replaces — the pipeline head (#975/#982).
 *
 * `snapToPlace` and `classifySegments` are the two TS algorithm steps between
 * the raw fixes and `segsRaw`, the day fold's only input. Both had complete,
 * `#guard`-pinned Lean twins that NOTHING CALLED until the `head` verb existed;
 * this checks the verb actually agrees with the TS, which a guard against
 * hand-written fixtures cannot tell you.
 *
 * Floats are compared with `===` on the decoded bits, not a tolerance: the day
 * gate compares byte-exact, so anything short of identical is a divergence.
 *
 * Run: npx tsx lean/experiments/compare-head.mts   (needs lake build first)
 */
import { execFileSync } from "node:child_process";
import { floatFromBits, floatToBits } from "../../src/lean/float-bits.js";
import { classifySegments } from "../../src/geo/segments.js";
import { type KnownPlace, snapToPlace } from "../../src/geo/place-snap.js";

const CLI = "lean/.lake/build/bin/verified_cli";
const run = (req: unknown) =>
	JSON.parse(execFileSync(CLI, ["head"], { input: JSON.stringify(req), encoding: "utf8" }));

const places: KnownPlace[] = [
	{ centroidLat: 51.5205, centroidLon: -0.1, radiusM: 15, id: "home" },
	{ centroidLat: 51.524, centroidLon: -0.1, radiusM: 15, id: "cafe" },
];
const fixes: Array<{ lat: number; lon: number; accuracy: number | null }> = [
	{ lat: 51.52068, lon: -0.1, accuracy: 10 }, // precise: trusted as-is
	{ lat: 51.52068, lon: -0.1, accuracy: 50 }, // noisy: snaps
	{ lat: 51.52068, lon: -0.1, accuracy: null }, // unknown accuracy: still snaps
	{ lat: 51.6, lon: -0.1, accuracy: 50 }, // out of radius: no snap
	// ⚠ Already AT the centroid. It SNAPS without moving, so a check that
	// inferred "snapped" from whether the coordinates changed would call this a
	// non-snap. That is why the verb returns the flag rather than the geometry.
	{ lat: 51.5205, lon: -0.1, accuracy: 50 },
];

const snapResp = run({
	op: "snap",
	fixes: fixes.map((f) => [
		floatToBits(f.lat),
		floatToBits(f.lon),
		f.accuracy === null ? null : floatToBits(f.accuracy),
	]),
	places: places.map((p) => [
		floatToBits(p.centroidLat),
		floatToBits(p.centroidLon),
		p.radiusM === undefined ? null : floatToBits(p.radiusM),
		p.id ?? null,
	]),
});
if (snapResp.error) throw new Error(`lean snap: ${snapResp.error}`);

let snapBad = 0;
fixes.forEach((f, i) => {
	const ts = snapToPlace({ lat: f.lat, lon: f.lon, accuracy: f.accuracy }, places);
	const [la, lo, acc, moved] = snapResp.snapped[i];
	const ok =
		floatFromBits(la) === ts.lat &&
		floatFromBits(lo) === ts.lon &&
		(acc === null ? ts.accuracy === null : floatFromBits(acc) === ts.accuracy) &&
		moved === ts.snapped;
	if (!ok) {
		snapBad++;
		// Print EVERY compared field, not just lat/snapped. A first version printed
		// those two, and a deliberate red test reported three mismatches whose
		// printed values were identical — the field that actually differed was
		// `accuracy`, and the message hid it.
		const show = (lat: number, lon: number, acc: number | null, sn: boolean) =>
			`lat=${lat} lon=${lon} acc=${acc} snapped=${sn}`;
		console.log(`  MISMATCH fix ${i}`);
		console.log(`    lean ${show(floatFromBits(la), floatFromBits(lo), acc === null ? null : floatFromBits(acc), moved)}`);
		console.log(`    ts   ${show(ts.lat, ts.lon, ts.accuracy, ts.snapped)}`);
	}
});
console.log(`snap:     ${fixes.length - snapBad}/${fixes.length} identical`);

// A stationary run then a walking run: two segments, so the fixture pins the
// CUT as well as the classification.
const pts = Array.from({ length: 40 }, (_, i) => ({
	ts: i * 60,
	lat: 51.5 + (i < 20 ? 0 : (i - 20) * 0.0008),
	lon: -0.1,
	speed_kmh: i < 20 ? 0.2 : 4.6,
	bearing: 0,
}));
const segResp = run({
	op: "segments",
	pts: pts.map((p) => [
		p.ts,
		floatToBits(p.lat),
		floatToBits(p.lon),
		floatToBits(p.speed_kmh),
		floatToBits(p.bearing),
	]),
	stayPts: null,
});
if (segResp.error) throw new Error(`lean segments: ${segResp.error}`);

const tsSegs = classifySegments(pts as never);
let segBad = 0;
tsSegs.forEach((t, i) => {
	const l = segResp.segs[i];
	if (!l) {
		segBad++;
		console.log(`  MISSING seg ${i}`);
		return;
	}
	const same =
		l.startTs === t.startTs &&
		l.endTs === t.endTs &&
		l.mode === t.mode &&
		floatFromBits(l.confidence) === t.confidence &&
		floatFromBits(l.confidenceMargin) === t.confidenceMargin &&
		floatFromBits(l.avgSpeed) === t.avgSpeed &&
		floatFromBits(l.maxSpeed) === t.maxSpeed &&
		floatFromBits(l.linearity) === t.linearity &&
		l.pointCount === t.pointCount;
	if (!same) {
		segBad++;
		console.log(`  MISMATCH seg ${i}: lean=${l.mode} ${l.startTs}-${l.endTs} ts=${t.mode} ${t.startTs}-${t.endTs}`);
	}
});
const countOk = segResp.segs.length === tsSegs.length;
console.log(`segments: ${tsSegs.length - segBad}/${tsSegs.length} identical (lean ${segResp.segs.length} vs ts ${tsSegs.length})`);

const clean = snapBad === 0 && segBad === 0 && countOk;
console.log(clean ? "IDENTICAL" : "DIVERGED");
process.exit(clean ? 0 : 1);
